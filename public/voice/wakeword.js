// "Hey Jarvis" detection, fully on this computer: openWakeWord's three small ONNX models.
//   audio (16 kHz) -> melspectrogram -> speech embedding (every 80 ms) -> wake-word score
// Same steps as openwakeword/utils.py (AudioFeatures). Works in the panel and in Node (tests).
export const CHUNK = 1280; // 80 ms at 16 kHz

export class WakeWord {
  // ort: onnxruntime-web module; load(name) -> ArrayBuffer of a model file
  static async create(ort, load) {
    const opts = { executionProviders: ['wasm'] };
    const [mel, emb, wake] = await Promise.all(['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis.onnx']
      .map(async n => ort.InferenceSession.create(new Uint8Array(await load(n)), opts)));
    return new WakeWord(ort, mel, emb, wake);
  }
  constructor(ort, mel, emb, wake) {
    this.ort = ort; this.mel = mel; this.emb = emb; this.wake = wake;
    this.reset();
  }
  reset() {
    this.raw = new Float32Array(0);        // audio not yet turned into mel frames
    this.tail = new Float32Array(480);     // 3 hops of context for the next mel window
    this.melFrames = [];                   // rows of 32
    for (let i = 0; i < 76; i++) this.melFrames.push(new Float32Array(32).fill(1));
    this.embeddings = [];                  // rows of 96
    this.busy = false;
  }
  // samples: Float32Array or Int16Array at 16 kHz. Returns the latest score (0..1) or null.
  async push(samples) {
    const s = samples instanceof Int16Array ? Float32Array.from(samples) : Float32Array.from(samples, v => v * 32767);
    const all = new Float32Array(this.raw.length + s.length); all.set(this.raw); all.set(s, this.raw.length);
    this.raw = all;
    let score = null;
    while (this.raw.length >= CHUNK) {
      const chunk = this.raw.subarray(0, CHUNK);
      const input = new Float32Array(this.tail.length + CHUNK); input.set(this.tail); input.set(chunk, this.tail.length);
      this.tail = input.slice(input.length - 480);
      this.raw = this.raw.slice(CHUNK);
      score = await this._step(input);
    }
    return score;
  }
  async _step(audio) {
    const T = this.ort.Tensor;
    // 1) mel frames for this 80 ms (+ 30 ms context)
    const mo = await this.mel.run({ [this.mel.inputNames[0]]: new T('float32', audio, [1, audio.length]) });
    const m = mo[this.mel.outputNames[0]];
    const frames = m.dims[m.dims.length - 2];
    for (let f = 0; f < frames; f++) {
      const row = new Float32Array(32);
      for (let k = 0; k < 32; k++) row[k] = m.data[f * 32 + k] / 10 + 2;
      this.melFrames.push(row);
    }
    if (this.melFrames.length > 200) this.melFrames.splice(0, this.melFrames.length - 200);
    // 2) one embedding from the last 76 mel frames
    const win = new Float32Array(76 * 32);
    const start = this.melFrames.length - 76;
    for (let i = 0; i < 76; i++) win.set(this.melFrames[start + i], i * 32);
    const eo = await this.emb.run({ [this.emb.inputNames[0]]: new T('float32', win, [1, 76, 32, 1]) });
    this.embeddings.push(Float32Array.from(eo[this.emb.outputNames[0]].data));
    if (this.embeddings.length > 16) this.embeddings.shift();
    if (this.embeddings.length < 16) return 0;
    // 3) the wake word score from the last 16 embeddings (~1.3 s)
    const feat = new Float32Array(16 * 96);
    this.embeddings.forEach((e, i) => feat.set(e, i * 96));
    const wo = await this.wake.run({ [this.wake.inputNames[0]]: new T('float32', feat, [1, 16, 96]) });
    return wo[this.wake.outputNames[0]].data[0];
  }
}

// Simple linear resampler (e.g. 48 kHz microphone or 22.05 kHz TTS -> 16 kHz).
export function resample(input, from, to = 16000) {
  if (from === to) return Float32Array.from(input);
  const ratio = from / to, n = Math.floor(input.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, i0 = Math.floor(x), i1 = Math.min(i0 + 1, input.length - 1), t = x - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}
