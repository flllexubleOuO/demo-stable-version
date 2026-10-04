// 服务端翻译模块：集中管理 API 密钥、提供方、模型、缓存和 Gemini 请求额度。
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';
const MAX_BATCH_ITEMS = 8;
const MAX_BATCH_CHARS = 6000;
const MAX_SEGMENT_CHARS = 3000;
const CACHE_TTL_MS = 15000;
const CACHE_MAX_ITEMS = 200;

const TARGET_LANGUAGES = {
  zh: 'Simplified Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  es: 'Spanish',
  de: 'German'
};

const SOURCE_LANGUAGES = {
  zh: 'Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  es: 'Spanish',
  de: 'German'
};

function makeError(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readModel(value, fallback) {
  if (typeof value !== 'string') return fallback;
  return /^[a-zA-Z0-9._-]{1,100}$/.test(value) ? value : fallback;
}

function extractModelText(result, isGemini) {
  if (isGemini) {
    const parts = (result.candidates || []).flatMap(candidate => candidate.content?.parts || []);
    return parts.map(part => part.text || '').join('');
  }

  if (result.output_text) return result.output_text;
  const outputItems = (result.output || []).flatMap(item => item.content || []);
  return outputItems
    .filter(item => item.type === 'output_text')
    .map(item => item.text)
    .join('');
}

function describeEmptyModelResponse(result, isGemini) {
  if (!isGemini) return result.incomplete_details?.reason || '';

  const promptBlockReason = result.promptFeedback?.blockReason;
  if (promptBlockReason) return `prompt blocked: ${promptBlockReason}`;

  const finishReasons = (result.candidates || [])
    .map(candidate => candidate.finishReason)
    .filter(reason => reason && reason !== 'STOP');
  return finishReasons.length ? `finish reason: ${finishReasons.join(', ')}` : '';
}

function parseTranslationArray(output, expectedCount) {
  const cleanOutput = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let translations;

  try {
    translations = JSON.parse(cleanOutput);
  } catch {
    throw makeError('The model returned an invalid translation batch.');
  }

  const hasExpectedItems = Array.isArray(translations) && translations.length === expectedCount;
  const hasOnlyText = hasExpectedItems && translations.every(item => typeof item === 'string' && item.trim());
  if (!hasOnlyText) throw makeError('The model returned an incomplete translation batch.');
  return translations.map(item => item.trim());
}

function createTranslationService({ env = process.env, fetchImpl = fetch } = {}) {
  const runtimeKeys = {
    gemini: env.GEMINI_API_KEY || '',
    openai: env.OPENAI_API_KEY || ''
  };
  let runtimeProvider = env.OPENAI_API_KEY && !env.GEMINI_API_KEY ? 'openai' : 'gemini';
  let runtimeModel = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  // 这些状态按模型和服务进程共享；默认留出 10% 余量，避免刚好触及项目级限额。
  const configuredGeminiRpm = Number(env.GEMINI_RPM);
  const geminiNextSlot = new Map();
  const geminiQueues = new Map();
  const geminiCache = new Map();
  const geminiInflight = new Map();

  function getGeminiRpm(model) {
    const defaultRpm = model.startsWith('gemma-4-') ? 27 : 12;
    const requestedRpm = configuredGeminiRpm > 0 ? configuredGeminiRpm : defaultRpm;
    return Math.min(30, Math.max(1, requestedRpm));
  }

  function getSettings() {
    return {
      configured: Boolean(runtimeKeys[runtimeProvider]),
      provider: runtimeProvider,
      model: runtimeModel
    };
  }

  function configure(data) {
    const provider = data.provider === 'openai' ? 'openai' : 'gemini';
    const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
    if (apiKey) runtimeKeys[provider] = apiKey;
    runtimeProvider = provider;
    runtimeModel = readModel(data.model, runtimeModel);
    return getSettings();
  }

  async function createRealtimeTranscriptionSecret(language = 'en') {
    const apiKey = runtimeKeys.gemini;
    if (!apiKey) throw makeError('Configure a Gemini API key in Settings before starting live transcription.', 503);
    const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: 'models/gemini-3.5-transcribe-live',
          config: {
            generationConfig: { responseModalities: ['TEXT'] },
            inputAudioTranscription: { languageCodes: [language] },
            realtimeInputConfig: { automaticActivityDetection: { disabled: false } }
          }
        }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw makeError(data.error?.message || `Gemini Live token creation failed (${response.status}).`, response.status);
    if (!data.name) throw makeError('Gemini returned no temporary transcription credential.');
    return { value: data.name, expiresAt: data.expireTime };
  }

  function isRealtimeAsrConfigured() { return Boolean(runtimeKeys.gemini); }

  async function waitForGeminiSlot(model) {
    const previousRequest = geminiQueues.get(model) || Promise.resolve();
    const reservedSlot = previousRequest.catch(() => {}).then(async () => {
      const waitMs = (geminiNextSlot.get(model) || 0) - Date.now();
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      geminiNextSlot.set(model, Date.now() + Math.ceil(60000 / getGeminiRpm(model)));
    });
    geminiQueues.set(model, reservedSlot);
    await reservedSlot;
  }

  function cacheKeyFor(model, source, target, text) {
    // 缓存按模型和语言方向隔离，避免相同文字在不同翻译方向间串用。
    const normalizedText = text.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    return `${model}\0${source}\0${target}\0${normalizedText}`;
  }

  async function callProvider({ apiKey, batchTexts, model, sourceLanguage, targetLanguage, isGemini, isDisconnected }) {
    const instructions = `Translate each input segment independently from ${sourceLanguage} into natural, faithful ${targetLanguage}. Preserve meaning and tone. Return only a valid JSON array of strings in the same order, with exactly ${batchTexts.length} items.`;
    let url;
    let headers;
    let body;

    if (isGemini) {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      headers = { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };
      body = {
        system_instruction: { parts: [{ text: instructions }] },
        contents: [{ parts: [{ text: JSON.stringify(batchTexts) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: Math.min(4096, 512 * batchTexts.length),
          thinkingConfig: { thinkingLevel: 'minimal' }
        }
      };
    } else {
      url = 'https://api.openai.com/v1/responses';
      headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      body = { model, store: false, instructions, input: JSON.stringify(batchTexts) };
    }

    if (isGemini) await waitForGeminiSlot(model);
    // 页面清空后可能在等待配额时断开；此时不要再调用外部模型。
    if (isDisconnected()) throw makeError('The client cancelled this translation batch.', 499);
    const requestController = new AbortController();
    // 外部 API 无响应时释放服务端队列，避免前端一直停在翻译中。
    const requestTimeout = setTimeout(() => requestController.abort(), 30000);
    let response;
    let result;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: requestController.signal
      });
      result = await response.json();
    } catch (error) {
      if (requestController.signal.aborted) {
        const providerName = isGemini ? 'Gemini' : 'OpenAI';
        throw makeError(`${providerName} request timed out after 30 seconds.`, 504);
      }
      throw error;
    } finally {
      clearTimeout(requestTimeout);
    }
    if (!response.ok) {
      const providerName = isGemini ? 'Gemini' : 'OpenAI';
      throw makeError(result.error?.message || `${providerName} API returned ${response.status}.`, response.status);
    }

    const output = extractModelText(result, isGemini);
    if (!output) {
      const reason = describeEmptyModelResponse(result, isGemini);
      const detail = reason ? ` (${reason})` : '';
      throw makeError(`The model returned no translation${detail}.`);
    }
    return parseTranslationArray(output, batchTexts.length);
  }

  async function translate({ text, texts, source, target, model }, { isDisconnected = () => false } = {}) {
    const apiKey = runtimeKeys[runtimeProvider];
    const providerName = runtimeProvider === 'gemini' ? 'Gemini' : 'OpenAI';
    if (!apiKey) throw makeError(`No ${providerName} API key is set. Open Settings and add your API key.`, 503);

    const segments = Array.isArray(texts) ? texts : [text];
    const cleanTexts = segments.map(segment => typeof segment === 'string' ? segment.trim() : '');
    const totalChars = cleanTexts.reduce((sum, segment) => sum + segment.length, 0);
    const isValidBatch = cleanTexts.length > 0
      && cleanTexts.length <= MAX_BATCH_ITEMS
      && cleanTexts.every(segment => segment && segment.length <= MAX_SEGMENT_CHARS)
      && totalChars <= MAX_BATCH_CHARS;
    if (!isValidBatch) {
      throw makeError('Provide 1–8 non-empty text segments, up to 3,000 characters each and 6,000 characters total.', 400);
    }

    const targetLanguage = TARGET_LANGUAGES[target];
    if (!targetLanguage) throw makeError('Unsupported target language.', 400);
    const sourceCode = typeof source === 'string' ? source.split('-')[0] : '';
    const sourceLanguage = SOURCE_LANGUAGES[sourceCode] || 'the detected source language';
    const selectedModel = readModel(model, runtimeModel);
    const isGemini = runtimeProvider === 'gemini';
    const resolved = new Array(cleanTexts.length);
    const missing = new Map();

    cleanTexts.forEach((segment, index) => {
      if (!isGemini) {
        missing.set(`openai-${index}`, { text: segment, indexes: [index] });
        return;
      }

      const key = cacheKeyFor(selectedModel, sourceCode, target, segment);
      const cached = geminiCache.get(key);
      if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
        resolved[index] = Promise.resolve(cached.translation);
        return;
      }
      if (geminiInflight.has(key)) {
        resolved[index] = geminiInflight.get(key);
        return;
      }
      if (!missing.has(key)) missing.set(key, { text: segment, indexes: [] });
      missing.get(key).indexes.push(index);
    });

    if (missing.size) {
      const entries = [...missing.entries()];
      const batchTexts = entries.map(([, entry]) => entry.text);
      const operation = callProvider({
        apiKey,
        batchTexts,
        model: selectedModel,
        sourceLanguage,
        targetLanguage,
        isGemini,
        isDisconnected
      });

      entries.forEach(([key, entry], batchIndex) => {
        const itemPromise = operation.then(translations => translations[batchIndex]);
        for (const index of entry.indexes) resolved[index] = itemPromise;
        if (!isGemini) return;

        geminiInflight.set(key, itemPromise);
        itemPromise.then(translation => {
          geminiCache.set(key, { translation, time: Date.now() });
          while (geminiCache.size > CACHE_MAX_ITEMS) geminiCache.delete(geminiCache.keys().next().value);
        }).catch(() => {}).finally(() => {
          if (geminiInflight.get(key) === itemPromise) geminiInflight.delete(key);
        });
      });
    }

    const translations = await Promise.all(resolved);
    const result = { translations };
    if (translations.length === 1) result.translation = translations[0];
    return result;
  }

  return { getSettings, configure, translate, createRealtimeTranscriptionSecret, isRealtimeAsrConfigured };
}

module.exports = { createTranslationService };
