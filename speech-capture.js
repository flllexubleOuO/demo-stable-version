import { logDiagnostic } from './diagnostics.js';

// 语音采集模块：封装麦克风独占、识别重连、草稿显示和确认文本分块。
const MAX_WORDS_PER_CHUNK = 24;
const MAX_CHARS_PER_CHUNK = 160;
const PAUSE_COMMIT_MS = 1500;
const INTERIM_STABILITY_MS = 500;
const MAX_CONFIRMED_WAIT_MS = 7000;
const RECONNECT_DELAY_MS = 300;
const DUPLICATE_WINDOW_MS = 300000;
const NEAR_DUPLICATE_MIN_LENGTH = 40;
const NEAR_DUPLICATE_MIN_LENGTH_RATIO = 0.9;
const NEAR_DUPLICATE_SIMILARITY = 0.9;

function logSpeechDebug(event, details = {}) {
  logDiagnostic('Speech', event, details);
}

export function createSpeechCapture({ getSourceLanguage, onDraft, onChunk, onRevision, onStatus, onListening, onError }) {
  // 录音状态只在此模块内维护，避免页面事件创建并行的识别会话。
  let recognition = null;
  let recognitionState = 'idle';
  let conversationGeneration = 0;
  let speechLockRelease = null;
  let speechLockRequestPending = false;
  let listening = false;
  let pendingText = '';
  let pendingTextStartedAt = 0;
  let interimRemainder = '';
  let interimCommittedPrefix = '';
  let latestInterimText = '';
  let activeInterimSegmentId = null;
  let activeInterimSessionId = null;
  let interimCandidateText = '';
  let pauseFlushTimer = null;
  let maxWaitFlushTimer = null;
  let interimPauseTimer = null;
  let interimCandidateTimer = null;
  let recognitionRestartTimer = null;
  let recognitionSessionSequence = 0;
  const recentCommits = new Map();
  const interimSegments = new Map();

  function updateListening(active, label) {
    onListening(active, label);
  }

  function releaseSpeechLock() {
    const release = speechLockRelease;
    speechLockRelease = null;
    if (release) release();
  }

  function joinSpeech(first, second) {
    return [first.trim(), second.trim()].filter(Boolean).join(' ');
  }

  function normalizeSpeech(text) {
    return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function getSegmentId(sessionId, resultIndex) {
    return `${sessionId}:${resultIndex}`;
  }

  function getInterimSegment(segmentId) {
    if (!interimSegments.has(segmentId)) {
      interimSegments.set(segmentId, { committedChunks: [] });
    }
    return interimSegments.get(segmentId);
  }

  function getComparableUnits(text) {
    return Array.from(text);
  }

  function similarityScore(first, second) {
    const firstUnits = getComparableUnits(first);
    const secondUnits = getComparableUnits(second);
    const longestLength = Math.max(firstUnits.length, secondUnits.length);
    if (!longestLength) return 1;

    let previousRow = Array.from({ length: secondUnits.length + 1 }, (_, index) => index);
    for (let firstIndex = 1; firstIndex <= firstUnits.length; firstIndex++) {
      const currentRow = [firstIndex];
      for (let secondIndex = 1; secondIndex <= secondUnits.length; secondIndex++) {
        const substitutionCost = firstUnits[firstIndex - 1] === secondUnits[secondIndex - 1] ? 0 : 1;
        currentRow[secondIndex] = Math.min(
          currentRow[secondIndex - 1] + 1,
          previousRow[secondIndex] + 1,
          previousRow[secondIndex - 1] + substitutionCost
        );
      }
      previousRow = currentRow;
    }

    return 1 - previousRow[secondUnits.length] / longestLength;
  }

  function isNearDuplicate(normalized, previous) {
    if (normalized.length < NEAR_DUPLICATE_MIN_LENGTH || previous.length < NEAR_DUPLICATE_MIN_LENGTH) {
      return false;
    }

    const lengthRatio = Math.min(normalized.length, previous.length) / Math.max(normalized.length, previous.length);
    if (lengthRatio < NEAR_DUPLICATE_MIN_LENGTH_RATIO) return false;
    return similarityScore(normalized, previous) >= NEAR_DUPLICATE_SIMILARITY;
  }

  function stripCommittedInterimPrefix(text) {
    const normalizedPrefix = normalizeSpeech(interimCommittedPrefix);
    const normalizedText = normalizeSpeech(text);
    if (!normalizedPrefix) return text.trim();
    if (!normalizedText.startsWith(normalizedPrefix)) return null;

    let normalized = '';
    let rawEnd = 0;
    for (const character of text) {
      rawEnd += character.length;
      if (/[\p{L}\p{N}]/u.test(character)) {
        normalized += character.toLocaleLowerCase();
      } else if (normalized && !normalized.endsWith(' ')) {
        normalized += ' ';
      }
      if (normalized.trimEnd().length >= normalizedPrefix.length) break;
    }

    logSpeechDebug('interim-prefix-removed', {
      method: 'same-result-index-exact',
      segmentId: activeInterimSegmentId,
      matchedChars: normalizedPrefix.length
    });
    return text.slice(rawEnd).replace(/^[^\p{L}\p{N}]+/u, '').trimStart();
  }

  function activateInterimSegment(segmentId) {
    if (activeInterimSegmentId === segmentId) return;
    clearInterimTimers();
    if (activeInterimSegmentId && interimRemainder) {
      if (commitChunk(interimRemainder, 'interim-slot-switch', activeInterimSessionId, activeInterimSegmentId)) {
        rememberInterimCommit(interimRemainder, activeInterimSegmentId);
      }
      onDraft('', activeInterimSegmentId);
    }
    activeInterimSegmentId = segmentId;
    activeInterimSessionId = Number(segmentId.split(':')[0]);
    const segment = getInterimSegment(segmentId);
    interimCommittedPrefix = segment.committedText || '';
    latestInterimText = '';
    interimRemainder = '';
  }

  function rememberInterimCommit(text, segmentId) {
    interimCommittedPrefix = joinSpeech(interimCommittedPrefix, text);
    const segment = getInterimSegment(segmentId);
    segment.committedText = interimCommittedPrefix;
    segment.committedChunks.push(text);
  }

  function clearInterimTimers() {
    clearTimeout(interimPauseTimer);
    clearTimeout(interimCandidateTimer);
    interimPauseTimer = null;
    interimCandidateTimer = null;
    interimCandidateText = '';
  }

  function commitStableInterimCandidate(sessionId, resultIndex) {
    const segmentId = getSegmentId(sessionId, resultIndex);
    const remaining = stripCommittedInterimPrefix(latestInterimText);
    if (remaining === null) {
      logSpeechDebug('interim-revision-waiting-for-final', { sessionId, resultIndex, segmentId });
      clearInterimTimers();
      interimRemainder = '';
      onDraft('', segmentId);
      return;
    }
    const { complete } = segmentReadyText(remaining);
    const candidate = complete[0];
    if (!candidate || candidate !== interimCandidateText) {
      handleInterimText(latestInterimText, sessionId, resultIndex);
      return;
    }

    if (commitChunk(candidate, 'interim-stable', sessionId, segmentId)) {
      rememberInterimCommit(candidate, segmentId);
    }
    interimCandidateTimer = null;
    interimCandidateText = '';
    handleInterimText(latestInterimText, sessionId, resultIndex);
  }

  function commitPausedInterimText(sessionId, resultIndex) {
    const segmentId = getSegmentId(sessionId, resultIndex);
    const remaining = stripCommittedInterimPrefix(latestInterimText);
    if (remaining === null) {
      logSpeechDebug('interim-revision-waiting-for-final', { sessionId, resultIndex, segmentId, reason: 'pause' });
      interimRemainder = '';
      onDraft('', segmentId);
      clearInterimTimers();
      return;
    }
    if (remaining && commitChunk(remaining, 'interim-pause', sessionId, segmentId)) {
      rememberInterimCommit(remaining, segmentId);
    }
    interimRemainder = '';
    clearInterimTimers();
    onDraft('', segmentId);
  }

  function handleInterimText(text, sessionId, resultIndex) {
    const segmentId = getSegmentId(sessionId, resultIndex);
    activateInterimSegment(segmentId);
    latestInterimText = text.trim();
    const remaining = stripCommittedInterimPrefix(latestInterimText);
    if (remaining === null) {
      logSpeechDebug('interim-revision-waiting-for-final', { sessionId, resultIndex, segmentId });
      clearInterimTimers();
      interimRemainder = '';
      onDraft('', segmentId);
      return;
    }

    interimRemainder = remaining;
    onDraft(remaining, segmentId);

    const { complete } = segmentReadyText(remaining);
    const candidate = complete[0] || '';
    if (candidate !== interimCandidateText) {
      clearTimeout(interimCandidateTimer);
      interimCandidateTimer = null;
      interimCandidateText = candidate;
      if (candidate) {
        interimCandidateTimer = setTimeout(() => {
          commitStableInterimCandidate(sessionId, resultIndex);
        }, INTERIM_STABILITY_MS);
      }
    }

    clearTimeout(interimPauseTimer);
    interimPauseTimer = remaining
      ? setTimeout(() => commitPausedInterimText(sessionId, resultIndex), PAUSE_COMMIT_MS)
      : null;
  }

  function commitChunk(text, reason = 'unspecified', sessionId = null, segmentId = null) {
    const chunk = text.trim();
    if (!chunk) return false;

    const normalized = normalizeSpeech(chunk);
    const now = Date.now();
    logSpeechDebug('chunk-candidate', { sessionId, reason, text: chunk });
    for (const [previous, committedAt] of recentCommits) {
      if (now - committedAt > DUPLICATE_WINDOW_MS) recentCommits.delete(previous);
    }
    if (recentCommits.has(normalized)) {
      logSpeechDebug('chunk-dropped-exact-duplicate', { sessionId, segmentId, reason, text: chunk });
      return false;
    }

    // 识别服务重连或修订结果时，长句可能只差少量字符；短窗口难以拦住迟到的重复结果。
    for (const previous of recentCommits.keys()) {
      if (isNearDuplicate(normalized, previous)) {
        logSpeechDebug('chunk-dropped-near-duplicate', { sessionId, segmentId, reason, text: chunk, previous });
        return false;
      }
    }

    recentCommits.set(normalized, now);
    if (recentCommits.size > 100) recentCommits.delete(recentCommits.keys().next().value);
    logSpeechDebug('chunk-committed', { sessionId, segmentId, reason, text: chunk });
    onChunk(chunk, { segmentId, reason });
    return true;
  }

  function segmentReadyText(text) {
    let rest = text.trim();
    const complete = [];

    while (rest) {
      const words = rest.split(/\s+/);
      const exceedsWordLimit = words.length > MAX_WORDS_PER_CHUNK;
      const exceedsCharacterLimit = rest.length > MAX_CHARS_PER_CHUNK;
      if (!exceedsWordLimit && !exceedsCharacterLimit) break;

      let cut = exceedsCharacterLimit
        ? MAX_CHARS_PER_CHUNK
        : words.slice(0, MAX_WORDS_PER_CHUNK).join(' ').length;
      const earliestNaturalBreak = Math.floor(cut * 0.65);
      let foundPunctuation = false;

      // 只有达到大小上限时才按标点提前切分，避免普通短句被过度拆开。
      for (let index = cut - 1; index >= earliestNaturalBreak; index--) {
        if (/[.!?。！？,;:，；：]/.test(rest[index])) {
          cut = index + 1;
          foundPunctuation = true;
          break;
        }
      }

      if (!foundPunctuation) {
        const space = rest.lastIndexOf(' ', cut);
        if (space >= earliestNaturalBreak) cut = space;
      }

      const chunk = rest.slice(0, cut).trim();
      if (!chunk) break;
      complete.push(chunk);
      rest = rest.slice(cut).trimStart();
    }

    return { complete, rest };
  }

  function flushPendingChunk(reason, sessionId) {
    clearTimeout(pauseFlushTimer);
    clearTimeout(maxWaitFlushTimer);
    pauseFlushTimer = null;
    maxWaitFlushTimer = null;

    if (pendingText) commitChunk(pendingText, reason, sessionId);
    pendingText = '';
    pendingTextStartedAt = 0;
    onDraft('', 'confirmed-pending');
  }

  function schedulePendingFlush(sessionId) {
    clearTimeout(pauseFlushTimer);
    clearTimeout(maxWaitFlushTimer);
    if (!pendingText) {
      pendingTextStartedAt = 0;
      return;
    }

    pauseFlushTimer = setTimeout(() => flushPendingChunk('final-pause', sessionId), PAUSE_COMMIT_MS);
    const oldestWaitRemaining = Math.max(0, MAX_CONFIRMED_WAIT_MS - (Date.now() - pendingTextStartedAt));
    maxWaitFlushTimer = setTimeout(() => flushPendingChunk('confirmed-wait-limit', sessionId), oldestWaitRemaining);
  }

  function segmentAllText(text) {
    const { complete, rest } = segmentReadyText(text);
    return rest ? [...complete, rest] : complete;
  }

  function clearActiveInterimSegment(segmentId) {
    if (activeInterimSegmentId !== segmentId) return;
    clearInterimTimers();
    activeInterimSegmentId = null;
    activeInterimSessionId = null;
    interimCommittedPrefix = '';
    latestInterimText = '';
    interimRemainder = '';
  }

  function addFinalText(text, sessionId, resultIndex) {
    const segmentId = getSegmentId(sessionId, resultIndex);
    const segment = interimSegments.get(segmentId);
    clearActiveInterimSegment(segmentId);

    if (segment?.committedChunks.length) {
      const finalChunks = segmentAllText(text.trim());
      logSpeechDebug('interim-segment-revised', {
        sessionId,
        resultIndex,
        segmentId,
        interimChunkCount: segment.committedChunks.length,
        finalChunkCount: finalChunks.length,
        rawText: text
      });
      onRevision({ segmentId, chunks: finalChunks, sessionId, resultIndex });
      onDraft('', segmentId);
      interimSegments.delete(segmentId);
      return;
    }

    const cleanText = text.trim();
    logSpeechDebug('final-text-normalized', {
      sessionId,
      resultIndex,
      segmentId,
      rawText: text,
      submittedText: cleanText
    });
    onDraft('', segmentId);
    if (!cleanText) {
      interimSegments.delete(segmentId);
      return;
    }

    const oldestPendingAt = pendingTextStartedAt || Date.now();
    pendingText = pendingText ? `${pendingText.trimEnd()} ${cleanText}` : cleanText;
    const { complete, rest } = segmentReadyText(pendingText);
    complete.forEach(chunk => commitChunk(chunk, 'final-result', sessionId, segmentId));
    interimSegments.delete(segmentId);

    pendingText = rest;
    if (!rest) {
      pendingTextStartedAt = 0;
    } else if (complete.length) {
      pendingTextStartedAt = Date.now();
    } else {
      pendingTextStartedAt = oldestPendingAt;
    }
    onDraft(pendingText, 'confirmed-pending');
    if (pendingText) schedulePendingFlush(sessionId);
    else {
      clearTimeout(pauseFlushTimer);
      clearTimeout(maxWaitFlushTimer);
    }
  }

  function flushOnStop() {
    clearTimeout(pauseFlushTimer);
    clearTimeout(maxWaitFlushTimer);
    pauseFlushTimer = null;
    maxWaitFlushTimer = null;
    clearInterimTimers();

    // 临时识别结果仍可能变化；停止时只提交浏览器已经确认的文字。
    if (pendingText) commitChunk(pendingText, 'stop-flush');
    if (activeInterimSegmentId && interimRemainder) {
      if (commitChunk(interimRemainder, 'stop-flush', activeInterimSessionId, activeInterimSegmentId)) {
        rememberInterimCommit(interimRemainder, activeInterimSegmentId);
      }
      onDraft('', activeInterimSegmentId);
    }
    pendingText = '';
    pendingTextStartedAt = 0;
    interimRemainder = '';
    interimCommittedPrefix = '';
    latestInterimText = '';
    activeInterimSegmentId = null;
    activeInterimSessionId = null;
    onDraft('', 'confirmed-pending');
  }

  function commitActiveInterimRemainder(reason) {
    if (!activeInterimSegmentId || !interimRemainder) return;
    if (commitChunk(interimRemainder, reason, activeInterimSessionId, activeInterimSegmentId)) {
      rememberInterimCommit(interimRemainder, activeInterimSegmentId);
    }
    onDraft('', activeInterimSegmentId);
    interimRemainder = '';
  }

  function launchRecognition(instance) {
    if (!listening || recognition !== instance || recognitionState !== 'idle') return;
    recognitionState = 'starting';

    try {
      instance.start();
    } catch (error) {
      if (error.name === 'InvalidStateError') {
        recognitionState = 'running';
        return;
      }

      recognitionState = 'idle';
      recognition = null;
      listening = false;
      releaseSpeechLock();
      updateListening(false, 'Start speaking');
      onStatus('Could not start speech recognition');
      onError(`Could not start speech recognition: ${error.message}`);
      flushOnStop();
    }
  }

  function createRecognition(API) {
    if (!listening || recognition) return;
    const instance = new API();
    const currentGeneration = conversationGeneration;
    const sessionId = ++recognitionSessionSequence;
    recognition = instance;
    recognitionState = 'idle';
    instance.lang = getSourceLanguage();
    instance.interimResults = true;
    instance.continuous = true;
    let lastFinalIndex = 0;
    logSpeechDebug('session-created', {
      sessionId,
      generation: currentGeneration,
      language: instance.lang,
      continuous: instance.continuous,
      interimResults: instance.interimResults
    });

    instance.onstart = () => {
      if (recognition !== instance) return;
      recognitionState = 'running';
      logSpeechDebug('session-started', { sessionId, listening, lastFinalIndex });
      if (!listening) {
        recognitionState = 'stopping';
        try { instance.stop(); } catch {}
        return;
      }
      lastFinalIndex = 0;
      updateListening(true, 'Stop listening');
      onStatus('Listening', true);
    };

    instance.onresult = event => {
      if (recognition !== instance || currentGeneration !== conversationGeneration) {
        logSpeechDebug('stale-result-ignored', {
          sessionId,
          currentSessionId: recognitionSessionSequence,
          currentGeneration: conversationGeneration,
          resultIndex: event.resultIndex
        });
        return;
      }
      clearTimeout(recognitionRestartTimer);
      const interimResults = [];
      let sawFinal = false;
      logSpeechDebug('result-event', {
        sessionId,
        resultIndex: event.resultIndex,
        resultCount: event.results.length,
        lastFinalIndex
      });

      for (let index = event.resultIndex; index < event.results.length; index++) {
        const text = event.results[index][0].transcript.trim();
        logSpeechDebug('result-item', {
          sessionId,
          index,
          isFinal: event.results[index].isFinal,
          willProcess: index >= lastFinalIndex,
          text
        });
        if (event.results[index].isFinal && text && index >= lastFinalIndex) {
          clearTimeout(pauseFlushTimer);
          pauseFlushTimer = null;
          addFinalText(text, sessionId, index);
          lastFinalIndex = index + 1;
          sawFinal = true;
        } else if (!event.results[index].isFinal && text) {
          interimResults.push({ resultIndex: index, text });
        }
      }

      if (interimResults.length === 1) {
        const interim = interimResults[0];
        handleInterimText(interim.text, sessionId, interim.resultIndex);
        onDraft(pendingText, 'confirmed-pending');
      } else if (interimResults.length > 1) {
        logSpeechDebug('multiple-interim-results-deferred', {
          sessionId,
          resultIndexes: interimResults.map(item => item.resultIndex)
        });
        clearInterimTimers();
        commitActiveInterimRemainder('interim-slot-switch');
        activeInterimSegmentId = null;
        activeInterimSessionId = null;
        interimCommittedPrefix = '';
        latestInterimText = '';
        onDraft(interimResults.map(item => item.text).join(' '), 'deferred-interim');
        onDraft(pendingText, 'confirmed-pending');
      } else {
        onDraft('', 'deferred-interim');
        onDraft(pendingText, 'confirmed-pending');
        if (sawFinal) schedulePendingFlush(sessionId);
      }
    };

    instance.onerror = event => {
      if (recognition !== instance || currentGeneration !== conversationGeneration) return;
      logSpeechDebug('session-error', { sessionId, error: event.error, listening });
      if (event.error === 'no-speech' || event.error === 'aborted') return;

      let message = `Speech recognition error: ${event.error}`;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        message = 'Microphone access is blocked. Allow it for this site in Chrome’s address-bar site settings.';
      } else if (event.error === 'audio-capture') {
        message = 'No microphone was found. Check that one is connected and enabled.';
      }
      listening = false;
      recognitionState = 'stopping';
      updateListening(false, 'Start speaking');
      onStatus('Microphone needs attention');
      onError(message);
      try { instance.stop(); } catch {}
    };

    instance.onend = () => {
      if (recognition !== instance) {
        logSpeechDebug('stale-end-ignored', { sessionId, currentSessionId: recognitionSessionSequence });
        return;
      }
      logSpeechDebug('session-ended', {
        sessionId,
        listening,
        recognitionState,
        pendingText,
        interimRemainder,
        interimCommittedPrefix
      });
      if (currentGeneration !== conversationGeneration) {
        clearTimeout(recognitionRestartTimer);
        recognition = null;
        recognitionState = 'idle';
        if (listening) {
          createRecognition(API);
          return;
        }
        updateListening(false, 'Start speaking');
        onStatus('Ready');
        releaseSpeechLock();
        return;
      }

      recognitionState = 'idle';
      if (listening) {
        // 部分浏览器会中断连续识别；重连期间保留草稿，防止一句话被截断。
        clearInterimTimers();
        commitActiveInterimRemainder('reconnect-flush');
        activeInterimSegmentId = null;
        activeInterimSessionId = null;
        interimCommittedPrefix = '';
        interimRemainder = '';
        latestInterimText = '';
        onDraft('', 'deferred-interim');
        onDraft(pendingText, 'confirmed-pending');
        recognition = null;
        onStatus('Reconnecting…', true);
        logSpeechDebug('reconnect-scheduled', { sessionId, delayMs: RECONNECT_DELAY_MS });
        recognitionRestartTimer = setTimeout(() => {
          if (listening) createRecognition(API);
        }, RECONNECT_DELAY_MS);
        return;
      }

      clearTimeout(recognitionRestartTimer);
      recognition = null;
      flushOnStop();
      updateListening(false, 'Start speaking');
      onStatus('Ready');
      releaseSpeechLock();
    };

    launchRecognition(instance);
  }

  function start() {
    const API = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!API) {
      logSpeechDebug('start-unavailable');
      onStatus('Speech recognition unavailable');
      onError('Speech recognition is not supported. Try the latest Chrome or Edge.');
      return;
    }
    if (listening) return;

    logSpeechDebug('start-requested', {
      language: getSourceLanguage(),
      lockSupported: Boolean(navigator.locks?.request)
    });

    interimCommittedPrefix = '';
    latestInterimText = '';
    activeInterimSegmentId = null;
    activeInterimSessionId = null;
    clearInterimTimers();
    listening = true;
    updateListening(true, 'Stop listening');
    onStatus('Starting microphone…', true);

    if (recognition) {
      clearTimeout(recognitionRestartTimer);
      if (recognitionState === 'idle') launchRecognition(recognition);
      return;
    }
    if (speechLockRelease) {
      createRecognition(API);
      return;
    }
    if (speechLockRequestPending) return;

    if (navigator.locks?.request) {
      speechLockRequestPending = true;
      navigator.locks.request('lingua-live-speech-input', { mode: 'exclusive', ifAvailable: true }, lock => {
        speechLockRequestPending = false;
        if (!lock) {
          logSpeechDebug('speech-lock-denied');
          if (listening) {
            listening = false;
            updateListening(false, 'Start speaking');
            onStatus('Already listening in another tab');
            onError('Speech recognition is already active in another Lingua tab.');
          }
          return;
        }
        return new Promise(resolve => {
          speechLockRelease = resolve;
          logSpeechDebug('speech-lock-acquired');
          if (listening) createRecognition(API);
          else releaseSpeechLock();
        });
      }).catch(error => {
        speechLockRequestPending = false;
        if (!listening) return;
        listening = false;
        updateListening(false, 'Start speaking');
        onStatus('Could not start speech recognition');
        onError(`Could not claim the microphone: ${error.message}`);
      });
      return;
    }

    createRecognition(API);
  }

  function stop() {
    if (!listening) return;
    logSpeechDebug('stop-requested', { sessionId: recognitionSessionSequence });
    listening = false;
    clearTimeout(recognitionRestartTimer);
    updateListening(false, 'Start speaking');

    if (recognition && recognitionState !== 'idle') {
      recognitionState = 'stopping';
      onStatus('Stopping…');
      try { recognition.stop(); } catch {}
      return;
    }

    if (recognition) {
      recognition = null;
      recognitionState = 'idle';
    }
    flushOnStop();
    onStatus('Ready');
    releaseSpeechLock();
  }

  function clear() {
    // 清空时递增会话代数，令旧录音迟到的回调失效。
    logSpeechDebug('conversation-cleared', { sessionId: recognitionSessionSequence });
    conversationGeneration++;
    listening = false;
    clearTimeout(recognitionRestartTimer);
    clearTimeout(pauseFlushTimer);
    clearTimeout(maxWaitFlushTimer);
    clearInterimTimers();
    pendingText = '';
    pendingTextStartedAt = 0;
    interimRemainder = '';
    interimCommittedPrefix = '';
    latestInterimText = '';
    interimSegments.clear();
    activeInterimSegmentId = null;
    activeInterimSessionId = null;
    recentCommits.clear();
    onDraft('', 'confirmed-pending');
    onDraft('', 'deferred-interim');
    updateListening(false, 'Start speaking');
    onStatus('Ready');

    if (recognition && recognitionState !== 'idle') {
      recognitionState = 'stopping';
      try { recognition.stop(); } catch {
        recognition = null;
        recognitionState = 'idle';
        releaseSpeechLock();
      }
    } else {
      recognition = null;
      recognitionState = 'idle';
      releaseSpeechLock();
    }
  }

  return {
    start,
    stop,
    clear,
    toggle() { if (listening) stop(); else start(); },
    isListening() { return listening; }
  };
}
