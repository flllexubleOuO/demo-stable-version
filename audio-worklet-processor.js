// Capture mono PCM, resample from the AudioContext rate to 16 kHz, and emit
// fixed 100 ms frames. The browser's input sample rate is never relabelled.
class LinguaPcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.outputRate = options.processorOptions?.outputRate || 16000;
    this.frameSamples = options.processorOptions?.frameSamples || 1600;
    this.ratio = sampleRate / this.outputRate;
    this.input = new Float32Array(0);
    this.phase = 0;
    this.pending = new Int16Array(this.frameSamples);
    this.pendingLength = 0;
    this.startSample = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    const joined = new Float32Array(this.input.length + channel.length);
    joined.set(this.input);
    joined.set(channel, this.input.length);
    let index = 0;
    while (this.phase + 1 < joined.length) {
      const left = Math.floor(this.phase);
      const fraction = this.phase - left;
      const value = joined[left] + (joined[left + 1] - joined[left]) * fraction;
      const clipped = Math.max(-1, Math.min(1, value));
      this.pending[this.pendingLength++] = clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767);
      this.phase += this.ratio;
      if (this.pendingLength === this.frameSamples) {
        let power = 0;
        for (const sample of this.pending) power += sample * sample;
        const rms = Math.sqrt(power / this.frameSamples) / 32768;
        const pcm = this.pending;
        this.port.postMessage({ startSample: this.startSample, rms, pcm }, [pcm.buffer]);
        this.startSample += this.frameSamples;
        this.pending = new Int16Array(this.frameSamples);
        this.pendingLength = 0;
      }
      index++;
    }
    const consumed = Math.floor(this.phase);
    this.input = joined.slice(consumed);
    this.phase -= consumed;
    return true;
  }
}

registerProcessor('lingua-pcm-processor', LinguaPcmProcessor);
