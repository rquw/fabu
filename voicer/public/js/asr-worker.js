// Whisper, running entirely in the browser via transformers.js. The model is
// fetched from Hugging Face once and then cached by the browser.
const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
let lib = null;
let asr = null;
let asrKey = '';

async function load(model, gpu, onProgress) {
  lib = lib || await import(LIB);
  const key = model + (gpu ? ':gpu' : '');
  if (asr && asrKey === key) return asr;
  lib.env.allowLocalModels = false;
  const progress_callback = p => {
    if (p.status === 'progress' && p.total) onProgress({ file: p.file, loaded: p.loaded, total: p.total });
  };
  let device = 'wasm';
  if (gpu && self.navigator && navigator.gpu) {
    try { if (await navigator.gpu.requestAdapter()) device = 'webgpu'; } catch {}
  }
  try {
    asr = await lib.pipeline('automatic-speech-recognition', model, device === 'webgpu'
      ? { device, dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback }
      : { dtype: 'q8', progress_callback });
  } catch (e) {
    if (device !== 'webgpu') throw e;
    asr = await lib.pipeline('automatic-speech-recognition', model, { dtype: 'q8', progress_callback });
  }
  asrKey = key;
  return asr;
}

self.onmessage = async e => {
  const { id, type } = e.data;
  try {
    if (type === 'load') {
      await load(e.data.model, e.data.gpu, p => self.postMessage({ id, type: 'progress', p }));
      self.postMessage({ id, type: 'done' });
    } else if (type === 'run') {
      let pipe = await load(e.data.model, e.data.gpu, p => self.postMessage({ id, type: 'progress', p }));
      const opts = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 };
      if (e.data.language && !/\.en$/.test(e.data.model)) { opts.language = e.data.language; opts.task = 'transcribe'; }
      let out;
      try { out = await pipe(e.data.audio, opts); }
      catch (err) {
        if (e.data.gpu) pipe = await load(e.data.model, false, () => {});
        // some builds choke on word timestamps; segment timestamps are the fallback
        out = await pipe(e.data.audio, { ...opts, return_timestamps: true });
        out.segments = true;
      }
      self.postMessage({ id, type: 'done', out: { text: out.text, chunks: out.chunks || [], segments: !!out.segments } });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String(err && err.message || err) });
  }
};
