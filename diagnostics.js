// 浏览器诊断日志只在显式开启调试参数时保存，避免默认记录用户语音内容。
const DIAGNOSTIC_ENDPOINT = '/api/diagnostics';
const MAX_BUFFERED_EVENTS = 200;
const MAX_EVENTS_PER_REQUEST = 40;
const FLUSH_INTERVAL_MS = 1000;

let bufferedEvents = [];
let flushTimer = null;
let flushInProgress = false;

function isDiagnosticLoggingEnabled() {
  return new URLSearchParams(window.location.search).get('debugSpeech') === '1';
}

async function flushDiagnosticEvents() {
  if (flushInProgress || !bufferedEvents.length) return;

  const events = bufferedEvents.splice(0, MAX_EVENTS_PER_REQUEST);
  flushInProgress = true;
  try {
    const response = await fetch(DIAGNOSTIC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events })
    });
    if (!response.ok) throw new Error(`Local diagnostic endpoint returned ${response.status}`);
  } catch (error) {
    bufferedEvents = [...events, ...bufferedEvents].slice(-MAX_BUFFERED_EVENTS);
    console.warn('[Lingua][Diagnostics] Could not write local diagnostics:', error.message);
  } finally {
    flushInProgress = false;
    if (bufferedEvents.length) scheduleDiagnosticFlush();
  }
}

function scheduleDiagnosticFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushDiagnosticEvents();
  }, FLUSH_INTERVAL_MS);
}

export function logDiagnostic(scope, event, details = {}) {
  const isTranslationTiming = scope === 'Translation'
    && (event === 'translation-completed' || event === 'translation-failed');
  if (!isDiagnosticLoggingEnabled() && !isTranslationTiming) return;

  const record = {
    timestamp: new Date().toISOString(),
    scope,
    event,
    details
  };

  console.info(`[Lingua][${scope}]`, record.timestamp, event, details);
  bufferedEvents.push(record);
  if (bufferedEvents.length > MAX_BUFFERED_EVENTS) bufferedEvents.shift();
  if (bufferedEvents.length >= MAX_EVENTS_PER_REQUEST) {
    void flushDiagnosticEvents();
    return;
  }
  scheduleDiagnosticFlush();
}

window.addEventListener('pagehide', () => {
  if (!isDiagnosticLoggingEnabled() || !bufferedEvents.length || !navigator.sendBeacon) return;

  const events = bufferedEvents.splice(0, MAX_EVENTS_PER_REQUEST);
  const payload = new Blob([JSON.stringify({ events })], { type: 'application/json' });
  navigator.sendBeacon(DIAGNOSTIC_ENDPOINT, payload);
});
