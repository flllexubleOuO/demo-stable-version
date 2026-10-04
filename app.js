import { createRealtimeAsr } from './audio-capture.js';
import { createTranslationQueue } from './translation-queue.js';
import { logDiagnostic } from './diagnostics.js';

// 页面入口只负责 DOM 展示、用户操作和语音/翻译模块之间的协调。
const $ = id => document.getElementById(id);
const source = $('sourceLang');
const target = $('targetLang');
const mic = $('micButton');
const transcript = $('transcript');
const empty = $('emptyState');
const settings = $('settingsDialog');

let toastTimer;
const draftRows = new Map();
const transcriptSegments = new Map();

// 只列出已在服务端支持的常用模型；自定义的已保存模型会作为当前选项保留。
const modelOptionsByProvider = {
  gemini: [
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
    { id: 'gemma-4-26b-a4b-it', label: 'Gemma 4 26B A4B IT' },
    { id: 'gemma-4-31b-it', label: 'Gemma 4 31B IT' }
  ],
  openai: [
    { id: 'gpt-6-luna', label: 'gpt-6-luna' }
  ]
};

function defaultModelFor(provider) {
  return provider === 'openai' ? 'gpt-6-luna' : 'gemini-3.1-flash-lite';
}

function populateModelOptions(provider, selectedModel) {
  const modelSelect = $('modelName');
  const options = modelOptionsByProvider[provider] || modelOptionsByProvider.gemini;
  const modelIds = new Set(options.map(option => option.id));
  modelSelect.replaceChildren();

  options.forEach(option => {
    modelSelect.add(new Option(option.label, option.id));
  });

  if (selectedModel && !modelIds.has(selectedModel)) {
    modelSelect.add(new Option(`${selectedModel} (current model)`, selectedModel));
  }

  modelSelect.value = selectedModel || defaultModelFor(provider);
}

// 通用界面反馈：状态栏、麦克风按钮和轻提示都由页面层统一更新。
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3500);
}

function setStatus(message, active = false) {
  $('connectionText').textContent = message;
  document.querySelector('.connection-dot').style.background = active ? '#c95b4e' : '#b5c5a9';
}

function updateMicUI(active, label) {
  mic.classList.toggle('listening', active);
  $('micText').textContent = label;
  $('listeningLabel').classList.toggle('visible', active);
}

function updateHeadings() {
  const sourceName = source.options[source.selectedIndex].text;
  const targetName = target.options[target.selectedIndex].text;
  $('sourceHeading').textContent = `${sourceName} original`;
  $('targetHeading').textContent = `${targetName} translation`;
}

function addMessage(original, pending = true, beforeNode = null) {
  empty.hidden = true;

  const wrapper = document.createElement('article');
  wrapper.className = 'message';
  const originalNode = document.createElement('div');
  originalNode.className = 'message-original';
  originalNode.textContent = original;
  const translationNode = document.createElement('div');
  translationNode.className = 'message-translation';
  translationNode.textContent = pending ? 'Translating…' : '';

  wrapper.append(originalNode, translationNode);
  transcript.insertBefore(wrapper, beforeNode);
  transcript.scrollTop = transcript.scrollHeight;
  return {
    wrapper,
    originalNode,
    translationNode,
    currentText: original,
    translationRequestVersion: 0
  };
}

function firstDraftNode() {
  for (const row of draftRows.values()) {
    if (row.wrapper.parentNode === transcript) return row.wrapper;
  }
  return null;
}

function promoteDraftRow(row, text) {
  const animationToken = (row.commitAnimationToken || 0) + 1;
  row.commitAnimationToken = animationToken;
  const finishAnimation = () => {
    if (row.commitAnimationToken === animationToken) row.wrapper.classList.remove('is-committing');
  };
  row.wrapper.classList.remove('interim-row');
  row.wrapper.classList.add('is-committing');
  row.wrapper.addEventListener('animationend', finishAnimation, { once: true });
  setTimeout(finishAnimation, 400);
  row.originalNode.textContent = text;
  row.currentText = text;
  row.translationNode.textContent = 'Translating…';
}

function fadeOutDraftRow(row) {
  row.wrapper.classList.add('is-fading');
  const removeRow = () => row.wrapper.remove();
  row.wrapper.addEventListener('transitionend', removeRow, { once: true });
  setTimeout(removeRow, 260);
}

// 临时草稿仅随语音识别更新；提交后转换为固定对话项。
function showDraft(text, segmentId = 'draft') {
  const draft = text.trim();
  if (!draft) {
    const existingRow = draftRows.get(segmentId);
    if (existingRow) existingRow.wrapper.remove();
    draftRows.delete(segmentId);
    return;
  }

  let row = draftRows.get(segmentId);
  if (!row) {
    row = addMessage('', false);
    row.wrapper.classList.add('interim-row');
    draftRows.set(segmentId, row);
  }
  row.originalNode.textContent = draft;
  row.currentText = draft;
  row.translationNode.textContent = 'Listening…';
  transcript.scrollTop = transcript.scrollHeight;
}

// 从当前设置读取模型配置，并把已确认的语音交给翻译队列管理。
function readProviderSettings() {
  const provider = localStorage.getItem('lingua_provider') || 'gemini';
  const fallbackModel = provider === 'gemini' ? 'gemini-3.1-flash-lite' : 'gpt-6-luna';
  const model = localStorage.getItem(`lingua_model_${provider}`) || fallbackModel;
  return { provider, model };
}

function enqueueTranslation(text, row) {
  const { provider, model } = readProviderSettings();
  const requestVersion = ++row.translationRequestVersion;
  translationQueue.enqueue({
    provider,
    model,
    source: source.value,
    target: target.value,
    text
  }, translation => {
    if (requestVersion === row.translationRequestVersion) row.translationNode.textContent = translation;
  }, status => {
    if (requestVersion === row.translationRequestVersion) row.translationNode.textContent = status;
  });
}

function renderCommittedChunk(text, metadata = {}) {
  const chunk = text.trim();
  if (!chunk) return;

  if (metadata.reason === 'final-result' || metadata.reason === 'final-pause'
      || metadata.reason === 'confirmed-wait-limit' || metadata.reason === 'stop-flush') {
    showDraft('', 'confirmed-pending');
  }

  let row = metadata.segmentId ? draftRows.get(metadata.segmentId) : null;
  if (row) {
    draftRows.delete(metadata.segmentId);
    promoteDraftRow(row, chunk);
    transcript.insertBefore(row.wrapper, firstDraftNode());
  } else {
    if (metadata.segmentId) showDraft('', metadata.segmentId);
    row = addMessage(chunk, false, firstDraftNode());
    row.currentText = chunk;
    row.translationNode.textContent = 'Translating…';
  }

  if (metadata.segmentId) {
    const segmentRows = transcriptSegments.get(metadata.segmentId) || [];
    segmentRows.push(row);
    transcriptSegments.set(metadata.segmentId, segmentRows);
  }
  enqueueTranslation(chunk, row);
}

function splitTranscriptText(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  let currentWords = [];

  words.forEach(word => {
    const candidate = [...currentWords, word].join(' ');
    if (currentWords.length && (currentWords.length >= 24 || candidate.length > 160)) {
      chunks.push(currentWords.join(' '));
      currentWords = [word];
      return;
    }
    currentWords.push(word);
  });

  if (currentWords.length) chunks.push(currentWords.join(' '));
  return chunks;
}

function alignTranscriptWords(previousRows, finalChunks) {
  const oldWords = [];
  const rowRanges = previousRows.map(row => {
    const words = row.currentText.trim().split(/\s+/).filter(Boolean);
    const start = oldWords.length;
    oldWords.push(...words);
    return { start, end: oldWords.length };
  });
  const finalWords = finalChunks.join(' ').trim().split(/\s+/).filter(Boolean);

  // 识别片段通常较短；超大结果跳过二次方对齐，改用完整修订以限制内存消耗。
  if (oldWords.length * finalWords.length > 1_000_000) {
    return { oldWords, finalWords, rowRanges, oldToFinal: null };
  }

  const wordKey = word => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') || word.toLocaleLowerCase();
  const oldKeys = oldWords.map(wordKey);
  const finalKeys = finalWords.map(wordKey);
  const columns = finalWords.length + 1;
  const table = new Uint16Array((oldWords.length + 1) * columns);

  for (let oldIndex = oldWords.length - 1; oldIndex >= 0; oldIndex--) {
    const rowOffset = oldIndex * columns;
    const nextRowOffset = (oldIndex + 1) * columns;
    for (let finalIndex = finalWords.length - 1; finalIndex >= 0; finalIndex--) {
      const cell = rowOffset + finalIndex;
      if (oldKeys[oldIndex] === finalKeys[finalIndex]) {
        table[cell] = table[nextRowOffset + finalIndex + 1] + 1;
      } else {
        table[cell] = Math.max(table[nextRowOffset + finalIndex], table[cell + 1]);
      }
    }
  }

  const oldToFinal = new Array(oldWords.length).fill(-1);
  let oldIndex = 0;
  let finalIndex = 0;
  while (oldIndex < oldWords.length && finalIndex < finalWords.length) {
    const cell = oldIndex * columns + finalIndex;
    if (oldKeys[oldIndex] === finalKeys[finalIndex]) {
      oldToFinal[oldIndex] = finalIndex;
      oldIndex++;
      finalIndex++;
    } else if (table[(oldIndex + 1) * columns + finalIndex] >= table[cell + 1]) {
      oldIndex++;
    } else {
      finalIndex++;
    }
  }

  return { oldWords, finalWords, rowRanges, oldToFinal };
}

function buildRevisionPlan(previousRows, finalChunks) {
  const alignment = alignTranscriptWords(previousRows, finalChunks);
  const { finalWords, rowRanges, oldToFinal } = alignment;
  if (!oldToFinal) {
    return finalChunks.map((text, index) => ({ row: previousRows[index] || null, text }));
  }

  const rowIsUnchanged = rowRanges.map(({ start, end }) => {
    if (start === end || oldToFinal[start] < 0) return false;
    for (let index = start + 1; index < end; index++) {
      if (oldToFinal[index] !== oldToFinal[index - 1] + 1) return false;
    }
    return true;
  });
  const plan = [];
  let finalCursor = 0;
  let rowIndex = 0;

  while (rowIndex < previousRows.length) {
    if (rowIsUnchanged[rowIndex]) {
      const { start, end } = rowRanges[rowIndex];
      const finalStart = oldToFinal[start];
      const finalEnd = oldToFinal[end - 1] + 1;
      if (finalStart > finalCursor) {
        splitTranscriptText(finalWords.slice(finalCursor, finalStart).join(' '))
          .forEach(text => plan.push({ row: null, text }));
      }
      plan.push({ row: previousRows[rowIndex], text: previousRows[rowIndex].currentText });
      finalCursor = finalEnd;
      rowIndex++;
      continue;
    }

    const changedStart = rowIndex;
    while (rowIndex < previousRows.length && !rowIsUnchanged[rowIndex]) rowIndex++;
    let finalEnd = finalWords.length;
    if (rowIndex < previousRows.length) {
      const nextRange = rowRanges[rowIndex];
      finalEnd = oldToFinal[nextRange.start];
    }
    const changedText = finalWords.slice(finalCursor, finalEnd).join(' ');
    const replacementChunks = splitTranscriptText(changedText);
    replacementChunks.forEach((text, index) => {
      plan.push({ row: index === 0 ? previousRows[changedStart] : null, text });
    });
    finalCursor = finalEnd;
  }

  if (finalCursor < finalWords.length) {
    splitTranscriptText(finalWords.slice(finalCursor).join(' '))
      .forEach(text => plan.push({ row: null, text }));
  }
  return plan;
}

function reviseTranscriptSegment({ segmentId, chunks }) {
  const interimDraftRow = draftRows.get(segmentId) || null;
  draftRows.delete(segmentId);
  showDraft('', 'deferred-interim');

  const previousRows = transcriptSegments.get(segmentId) || [];
  const revisionPlan = buildRevisionPlan(previousRows, chunks);
  const finalPlanItem = revisionPlan.at(-1);
  const lastNewRowIndex = finalPlanItem && !finalPlanItem.row ? revisionPlan.length - 1 : -1;
  const retainedRows = new Set();
  const revisedRows = [];
  let previousOutputRow = null;
  let translationCount = 0;
  let insertedRowCount = 0;
  const preservedRowCount = revisionPlan.filter(item => item.row && item.row.currentText === item.text).length;

  revisionPlan.forEach((item, index) => {
    let row = item.row;
    if (!row) {
      const nextExistingRow = revisionPlan.slice(index + 1).find(next => next.row)?.row;
      const beforeNode = previousOutputRow
        ? previousOutputRow.wrapper.nextSibling
        : nextExistingRow?.wrapper || firstDraftNode();
      if (interimDraftRow && index === lastNewRowIndex) {
        row = interimDraftRow;
        promoteDraftRow(row, item.text);
        transcript.insertBefore(row.wrapper, beforeNode);
      } else {
        row = addMessage(item.text, false, beforeNode);
        row.currentText = item.text;
        row.translationNode.textContent = 'Translating…';
      }
      enqueueTranslation(item.text, row);
      translationCount++;
      insertedRowCount++;
    } else if (row.currentText !== item.text) {
      row.currentText = item.text;
      row.originalNode.textContent = item.text;
      row.translationNode.textContent = 'Translating…';
      enqueueTranslation(item.text, row);
      translationCount++;
    }

    retainedRows.add(row);
    revisedRows.push(row);
    previousOutputRow = row;
  });
  if (interimDraftRow && lastNewRowIndex < 0) fadeOutDraftRow(interimDraftRow);
  logDiagnostic('Speech', 'segment-revision-applied', {
    segmentId,
    previousRowCount: previousRows.length,
    finalChunkCount: chunks.length,
    preservedRowCount,
    translationCount,
    insertedRowCount
  });

  previousRows.forEach(row => {
    if (retainedRows.has(row)) return;
    row.translationRequestVersion++;
    row.wrapper.remove();
  });
  transcriptSegments.set(segmentId, revisedRows);
}

// 两个功能模块分别持有自己的队列和状态，页面只注入错误提示回调。
const translationQueue = createTranslationQueue({
  onError(error) {
    if (error.message.includes('OPENAI_API_KEY')) {
      toast('Set OPENAI_API_KEY in the terminal, then restart the local server.');
      return;
    }
    toast(`Translation failed: ${error.message}`);
  }
});

const speech = createRealtimeAsr({
  onDraft: (text, itemId = 'live') => showDraft(text, `asr:${itemId}`),
  onChunk: (text, metadata = {}) => {
    showDraft('', `asr:${metadata.itemId || 'live'}`);
    if (!text.trim()) return;
    const row = addMessage(text.trim(), false);
    row.translationNode.textContent = `ASR final · ${metadata.latencyMs ?? 'n/a'} ms`;
    row.wrapper.dataset.asrLatencyMs = String(metadata.latencyMs ?? '');
    logDiagnostic('ASR', 'transcript-final', { latencyMs: metadata.latencyMs, captureLatencyMs: metadata.captureLatencyMs, itemId: metadata.itemId });
  },
  onStatus: setStatus,
  onListening: updateMicUI,
  onError: error => toast(error.message || String(error))
});

// 页面操作：清空、语言切换、录音控制和设置对话框。
function clearConversation() {
  // 先清空各模块内部状态，再删除对应的界面节点。
  speech.stop();
  translationQueue.cancel('');
  transcript.querySelectorAll('.message, .message-interim').forEach(node => node.remove());
  draftRows.clear();
  transcriptSegments.clear();
  empty.hidden = false;
}

function swapLanguages() {
  const targetToSource = {
    en: 'en-US',
    zh: 'zh-CN',
    ja: 'ja-JP',
    ko: 'ko-KR',
    fr: 'fr-FR',
    es: 'es-ES',
    de: 'de-DE'
  };
  const nextSource = targetToSource[target.value];
  if (!nextSource) {
    toast('This language pair cannot be swapped');
    return;
  }

  translationQueue.cancel('Translation cancelled because the target language changed.');
  const previousSource = source.value;
  source.value = nextSource;
  target.value = previousSource.split('-')[0];
  updateHeadings();
}

async function openSettings() {
  $('apiKey').value = '';
  settings.showModal();
  try {
    const response = await fetch('/api/settings');
    const data = await response.json();
    const provider = data.provider || 'gemini';
    $('providerName').value = provider;
    const savedModel = localStorage.getItem(`lingua_model_${provider}`);
    updateProviderFields(savedModel || data.model || defaultModelFor(provider));
    $('keyStatus').textContent = data.configured
      ? 'An API key is configured on this server. Enter a new key to replace it.'
      : 'No API key configured.';
  } catch {
    $('keyStatus').textContent = 'Local translation service is unavailable.';
  }
}

// 设置表单字段只展示当前提供方的默认模型和密钥提示。
function updateProviderFields(preferredModel) {
  const provider = $('providerName').value;
  const isGemini = provider === 'gemini';
  document.querySelector('.key-label').textContent = isGemini ? 'Gemini API key' : 'OpenAI API key';
  $('apiKey').placeholder = isGemini ? 'Paste your Gemini API key' : 'Paste your OpenAI API key';
  const savedModel = localStorage.getItem(`lingua_model_${provider}`);
  populateModelOptions(provider, preferredModel || savedModel || defaultModelFor(provider));
}

async function saveSettings(event) {
  event.preventDefault();
  const provider = $('providerName').value;
  const model = $('modelName').value || defaultModelFor(provider);
  const apiKey = $('apiKey').value.trim();

  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model, apiKey })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save settings');

    translationQueue.cancel('Translation cancelled because settings changed.');
    localStorage.setItem(`lingua_model_${provider}`, model);
    localStorage.setItem('lingua_provider', provider);
    $('apiKey').value = '';
    settings.close();
    toast(data.configured ? `Translation ready · ${model}` : 'Model saved. Add an API key to enable translation.');
  } catch (error) {
    toast(error.message);
  }
}

// 测试连接沿用单条翻译接口，不进入实时翻译批次队列。
async function testConnection() {
  const button = $('testConnection');
  const provider = $('providerName').value;
  const model = $('modelName').value || defaultModelFor(provider);
  button.disabled = true;
  $('keyStatus').textContent = 'Testing provider connection…';

  try {
    const setupResponse = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model, apiKey: $('apiKey').value.trim() })
    });
    const setup = await setupResponse.json();
    if (!setupResponse.ok) throw new Error(setup.error || `Local service returned ${setupResponse.status}`);

    translationQueue.cancel('Translation cancelled because settings changed.');
    localStorage.setItem(`lingua_model_${provider}`, model);
    localStorage.setItem('lingua_provider', provider);

    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello, how are you?', target: 'zh', model })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Translation request returned ${response.status}`);
    $('keyStatus').textContent = `Connected successfully. Test: “Hello, how are you?” → “${result.translation}”`;
  } catch (error) {
    $('keyStatus').textContent = `Connection test failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function handleSourceChange() {
  if (speech.isListening()) speech.stop();
  updateHeadings();
}

function handleTargetChange() {
  translationQueue.cancel('Translation cancelled because the target language changed.');
  updateHeadings();
}

// 所有页面事件在文件末尾集中绑定，便于顺着主流程阅读。
mic.addEventListener('click', () => speech.toggle());
document.addEventListener('keydown', event => {
  const blockedTags = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'];
  if (event.code !== 'Space' || blockedTags.includes(document.activeElement.tagName) || settings.open) return;
  event.preventDefault();
  speech.toggle();
});
source.addEventListener('change', handleSourceChange);
target.addEventListener('change', handleTargetChange);
$('swapButton').addEventListener('click', swapLanguages);
$('clearButton').addEventListener('click', clearConversation);
$('providerName').addEventListener('change', updateProviderFields);
$('settingsButton').addEventListener('click', openSettings);
$('saveSettings').addEventListener('click', saveSettings);
$('testConnection').addEventListener('click', testConnection);
$('historyNav').addEventListener('click', () => toast('History is not enabled. Conversation stays in this page.'));

updateHeadings();
