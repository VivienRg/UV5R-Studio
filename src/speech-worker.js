// Local speech-to-text with Whisper (transformers.js). Model files download once and stay cached.
import { pipeline, env } from './vendor/transformers.min.js';
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

let asr = null, current = null, loading = null;
async function load(model) {
  if (asr && current === model) return asr;
  if (loading && current === model) return loading;
  current = model;
  const progress_callback = p => { if (p.status === 'progress' || p.status === 'done') self.postMessage({ progress: { file: p.file, pct: p.progress ?? 100, loaded: p.loaded, total: p.total } }); };
  loading = (async () => {
    let device = 'wasm';
    if (self.navigator.gpu) { try { const a = await navigator.gpu.requestAdapter(); if (a) device = 'webgpu'; } catch { } }
    try {
      asr = await pipeline('automatic-speech-recognition', model, { device, dtype: device === 'webgpu' ? 'fp32' : 'q8', progress_callback });
    } catch (e) {
      if (device !== 'webgpu') throw e;
      asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback });
      device = 'wasm';
    }
    self.postMessage({ ready: { model, device } });
    return asr;
  })();
  try { return await loading; } finally { loading = null; }
}
self.onmessage = async e => {
  const { id, cmd } = e.data;
  try {
    if (cmd === 'load') { await load(e.data.model); self.postMessage({ id, ok: true }); }
    if (cmd === 'transcribe') {
      const p = await load(e.data.model);
      const opts = { task: e.data.task || 'transcribe', chunk_length_s: 30, stride_length_s: 5 };
      if (e.data.language) opts.language = e.data.language;
      const out = await p(e.data.audio, opts);
      self.postMessage({ id, ok: true, text: (out.text || '').trim() });
    }
  } catch (err) { self.postMessage({ id, ok: false, error: String(err && err.message || err) }); }
};
self.postMessage({ hello: true, isolated: self.crossOriginIsolated });
