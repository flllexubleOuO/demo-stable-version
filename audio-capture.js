const OUTPUT_RATE = 16000;
const FRAME_SAMPLES = 1600;
const MAX_SOCKET_BUFFER = OUTPUT_RATE * 2 * 3;
const SILENCE_THRESHOLD = 0.012;

function languageCode(value) {
  const code = String(value || 'en-US').replace('_', '-');
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(code) ? code : 'en-US';
}

export function createRealtimeAsr({ onDraft = () => {}, onChunk = () => {}, onStatus = () => {}, onListening = () => {}, onError = () => {} } = {}) {
  let stream = null, context = null, node = null, socket = null;
  let active = false, ready = false, lastVoicedAt = 0;
  let captureStartedAt = 0;

  function send(event) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }

  function beginAudio() {
    const source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'lingua-pcm-processor', {
      numberOfInputs: 1, numberOfOutputs: 0,
      processorOptions: { outputRate: OUTPUT_RATE, frameSamples: FRAME_SAMPLES }
    });
    node.port.onmessage = ({ data }) => {
      if (!active || !ready || socket?.readyState !== WebSocket.OPEN) return;
      const bytes = new Uint8Array(data.pcm.length * 2);
      const pcmView = new DataView(bytes.buffer);
      for (let i = 0; i < data.pcm.length; i++) pcmView.setInt16(i * 2, data.pcm[i], true);
      if (socket.bufferedAmount + bytes.byteLength > MAX_SOCKET_BUFFER) {
        onStatus('ASR connection is slow; audio frame skipped.');
        return;
      }
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
      }
      send({ realtimeInput: { audio: { data: btoa(binary), mimeType: `audio/pcm;rate=${OUTPUT_RATE}` } } });
      if (data.rms >= SILENCE_THRESHOLD) lastVoicedAt = performance.now();
    };
    source.connect(node);
    onListening(true, 'Listening · Gemini Live');
    onStatus('Live transcription connected');
  }

  async function start() {
    if (active) return;
    active = true;
    onStatus('Requesting microphone access…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
      const credentialResponse = await fetch('/api/asr/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: languageCode(document.getElementById('sourceLang')?.value) }),
        credentials: 'same-origin', cache: 'no-store'
      });
      const credentials = await credentialResponse.json();
      if (!credentialResponse.ok) throw new Error(credentials.error || 'Could not start ASR session.');

      context = new AudioContext();
      await context.audioWorklet.addModule('/audio-worklet-processor.js');
      const modelUrl = new URL('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained');
      modelUrl.searchParams.set('access_token', credentials.value);
      socket = new WebSocket(modelUrl);
      socket.addEventListener('open', () => {
        captureStartedAt = performance.now();
        send({ setup: {
          model: 'models/gemini-3.5-transcribe-live',
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: { languageCodes: [languageCode(document.getElementById('sourceLang')?.value)] },
          realtimeInputConfig: { automaticActivityDetection: { disabled: false } }
        } });
      }, { once: true });
      socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.setupComplete) {
          ready = true;
          beginAudio();
        } else if (message.error) {
          onError(new Error(message.error.message || 'Gemini Live reported an error.'));
        }
        const content = message.serverContent;
        if (content?.interimInputTranscription?.text) onDraft(content.interimInputTranscription.text, 'gemini-live');
        if (content?.inputTranscription?.text) {
          const latencyMs = lastVoicedAt ? Math.round(performance.now() - lastVoicedAt) : null;
          onDraft('', 'gemini-live');
          onChunk(content.inputTranscription.text, { itemId: `gemini-${Math.round(performance.now())}`, latencyMs, captureLatencyMs: Math.round(performance.now() - captureStartedAt) });
          onStatus(`Transcript received · final ${latencyMs ?? 'n/a'} ms after last voiced audio`);
          lastVoicedAt = 0;
        }
      });
      socket.addEventListener('error', () => { if (active) onError(new Error('Gemini Live WebSocket connection failed.')); });
      socket.addEventListener('close', () => {
        ready = false;
        if (active) { onStatus('ASR connection interrupted. Stop and restart to reconnect.'); stop(); }
      });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Gemini Live WebSocket timed out.')), 15000);
        socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Could not connect to Gemini Live.')); }, { once: true });
      });
    } catch (error) {
      stop();
      onStatus('ASR unavailable');
      onError(error);
    }
  }

  function stop() {
    if (!active && !stream && !socket) return;
    active = false; ready = false;
    if (socket?.readyState === WebSocket.OPEN) send({ realtimeInput: { audioStreamEnd: true } });
    try { node?.disconnect(); } catch {}
    node = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    if (context && context.state !== 'closed') context.close().catch(() => {});
    context = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'capture stopped');
    socket = null;
    onListening(false, 'Start speaking');
    onStatus('Ready');
  }

  return { start, stop, toggle() { if (active) stop(); else start(); }, isListening: () => active };
}
