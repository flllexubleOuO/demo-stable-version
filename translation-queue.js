import { logDiagnostic } from './diagnostics.js';

// 浏览器侧翻译队列：短暂合并相邻片段，并隔离已取消会话的回调。
const BATCH_WAIT_MS = 500;
const CACHE_TTL_MS = 15000;
const CACHE_MAX_ITEMS = 100;
const BATCH_MAX_ITEMS = 8;
const BATCH_MAX_CHARS = 6000;
const MAX_ACTIVE_BATCHES = 3;

function logQueueDebug(event, details = {}) {
  logDiagnostic('Queue', event, details);
}

export function createTranslationQueue({ onError = () => {} } = {}) {
  // 队列模块独占缓存、待发送项和请求状态；页面只传入文本与结果回调。
  const cache = new Map();
  const inFlight = new Map();
  const controllers = new Set();
  let waiting = [];
  let flushTimer = null;
  // 允许有限并行来隐藏模型响应延迟；真正的 RPM 由共享的服务端限速器控制。
  let activeBatchCount = 0;
  let batchSequence = 0;
  let generation = 0;

  function scheduleBatchFlush() {
    if (flushTimer || !waiting.length || activeBatchCount >= MAX_ACTIVE_BATCHES) return;
    flushTimer = setTimeout(flushBatch, BATCH_WAIT_MS);
  }

  async function readJsonResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) return response.json();

    const responseText = (await response.text()).trim();
    if (response.status === 404 || responseText === 'Not found') {
      throw new Error('The local translation service is outdated. Stop it and restart `node server.js` from the project folder.');
    }

    throw new Error(`The local translation service returned an unexpected response (${response.status}).`);
  }

  function makeKey({ provider, model, source, target, text }) {
    // 翻译方向和模型都属于缓存键，避免不同语言对误用同一结果。
    const normalizedText = text.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    return [provider, model, source, target, normalizedText].join('\0');
  }

  function enqueue(request, onResult, onStatus = () => {}) {
    const key = makeKey(request);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
      logQueueDebug('cache-hit', { text: request.text, model: request.model });
      onResult(cached.translation);
      return;
    }

    const existingInFlight = inFlight.get(key);
    const existing = existingInFlight || waiting.find(item => item.key === key);
    if (existing) {
      logQueueDebug(existingInFlight ? 'joined-inflight-item' : 'joined-queued-item', {
        text: request.text,
        model: request.model
      });
      existing.subscribers.push({ onResult, onStatus, generation });
      onStatus(existingInFlight ? 'Translating…' : 'Queued…');
      return;
    }

    waiting.push({
      ...request,
      key,
      generation,
      subscribers: [{ onResult, onStatus, generation }]
    });
    logQueueDebug('item-enqueued', {
      text: request.text,
      model: request.model,
      waitingItems: waiting.length
    });
    onStatus('Queued…');
    scheduleBatchFlush();
  }

  function takeBatch() {
    const first = waiting[0];
    const batch = [];
    const remaining = [];
    let totalChars = 0;

    for (const item of waiting) {
      const sameRequestGroup = item.provider === first.provider
        && item.model === first.model
        && item.source === first.source
        && item.target === first.target
        && item.generation === first.generation;
      const withinBatchLimits = batch.length < BATCH_MAX_ITEMS
        && totalChars + item.text.length <= BATCH_MAX_CHARS;

      if (sameRequestGroup && withinBatchLimits) {
        batch.push(item);
        totalChars += item.text.length;
      } else {
        remaining.push(item);
      }
    }

    waiting = remaining;
    return batch;
  }

  function deliver(item, text) {
    for (const subscriber of item.subscribers) {
      if (subscriber.generation === generation) subscriber.onResult(text);
    }
  }

  function deliverStatus(item, status) {
    for (const subscriber of item.subscribers) {
      if (subscriber.generation === generation) subscriber.onStatus(status);
    }
  }

  async function flushBatch() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (activeBatchCount >= MAX_ACTIVE_BATCHES || !waiting.length) return;

    const batch = takeBatch();
    const group = batch[0];
    const batchId = ++batchSequence;
    const startedAt = Date.now();
    activeBatchCount++;
    logQueueDebug('batch-started', {
      batchId,
      batchSize: batch.length,
      activeBatches: activeBatchCount,
      remainingQueuedItems: waiting.length,
      model: group.model,
      texts: batch.map(item => item.text)
    });
    for (const item of batch) inFlight.set(item.key, item);
    batch.forEach(item => deliverStatus(item, 'Translating…'));

    const controller = new AbortController();
    controllers.add(controller);
    try {
      const response = await fetch('/api/translate-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          texts: batch.map(item => item.text),
          source: group.source,
          target: group.target,
          model: group.model
        })
      });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || `Server returned ${response.status}`);
      if (!Array.isArray(data.translations) || data.translations.length !== batch.length) {
        throw new Error('The translation service returned an invalid batch.');
      }

      batch.forEach((item, index) => {
        const translation = data.translations[index];
        cache.set(item.key, { translation, time: Date.now() });
        deliver(item, translation);
        if (inFlight.get(item.key) === item) inFlight.delete(item.key);
      });
      logQueueDebug('batch-succeeded', { batchId, durationMs: Date.now() - startedAt, batchSize: batch.length });
      trimCache();
    } catch (error) {
      const failureMessage = error.message || 'Check the local service and API settings.';
      logQueueDebug('batch-failed', {
        batchId,
        durationMs: Date.now() - startedAt,
        message: failureMessage,
        texts: batch.map(item => item.text)
      });
      batch.forEach(item => {
        deliver(item, `Translation failed: ${failureMessage}`);
        if (inFlight.get(item.key) === item) inFlight.delete(item.key);
      });
      if (group.generation === generation) onError(error);
    } finally {
      controllers.delete(controller);
      activeBatchCount--;
      scheduleBatchFlush();
    }
  }

  function trimCache() {
    while (cache.size > CACHE_MAX_ITEMS) cache.delete(cache.keys().next().value);
  }

  function cancel(message = 'Translation cancelled.') {
    // 递增代数并中止本地请求，避免旧会话响应覆盖后续对话。
    logQueueDebug('queue-cancelled', {
      waitingItems: waiting.length,
      inFlightItems: inFlight.size,
      activeBatches: activeBatchCount
    });
    generation++;
    clearTimeout(flushTimer);
    flushTimer = null;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    for (const item of [...waiting, ...inFlight.values()]) {
      for (const subscriber of item.subscribers) subscriber.onResult(message);
    }
    waiting = [];
    inFlight.clear();
  }

  return { enqueue, cancel };
}
