import { prefs } from './util.js';
import { SR, FPS, pct } from './analyze.js';

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => {
    const p = pending.get(e.data.id);
    if (!p) return;
    if (e.data.type === 'progress') p.onProgress && p.onProgress(e.data.p);
    else { pending.delete(e.data.id); e.data.type === 'error' ? p.reject(new Error(e.data.error)) : p.resolve(e.data.out); }
  };
  worker.onerror = e => { for (const p of pending.values()) p.reject(new Error(e.message || 'worker crashed')); pending.clear(); worker = null; };
  return worker;
}

function call(msg, onProgress, transfer) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ ...msg, id }, transfer || []);
  });
}

export const MODELS = {
  tiny: { id: 'Xenova/whisper-tiny', label: 'Fast (~40 MB)' },
  base: { id: 'Xenova/whisper-base', label: 'Balanced (~80 MB)' },
  small: { id: 'Xenova/whisper-small', label: 'Accurate (~250 MB, slow)' },
};

function modelOpts() {
  const m = MODELS[prefs.get('asrModel', 'base')] || MODELS.base;
  const lang = prefs.get('asrLang', '');
  return { model: m.id, language: lang || null, gpu: prefs.get('asrGpu', false) };
}

// Cut the track into <=28 s windows, split in the quietest spot, skip silence.
function windows(L, R, vdb) {
  const total = L.length / SR;
  const quiet = pct(vdb, 0.5);
  const out = [];
  let a = 0;
  while (a < total - 0.3) {
    let b = Math.min(total, a + 28);
    if (b < total) {
      let best = b, bestV = Infinity;
      for (let t = a + 18; t < b; t += 1 / FPS) {
        const v = vdb[Math.floor(t * FPS)] ?? 0;
        if (v < bestV) { bestV = v; best = t; }
      }
      b = best;
    }
    let loud = 0;
    for (let f = Math.floor(a * FPS); f < Math.floor(b * FPS); f++) if (vdb[f] > quiet + 8) loud++;
    if (loud > FPS * 0.4) out.push([a, b]);
    a = b;
  }
  return out;
}

const JUNK = /^\s*[\[(♪*].*[\])♪*]\s*$|^\s*♪+\s*$/;

export async function transcribe(audio, vdb, { onProgress, signal } = {}) {
  const opts = modelOpts();
  onProgress && onProgress({ stage: 'Loading speech model', pct: 0 });
  const files = new Map();
  await call({ type: 'load', ...opts }, p => {
    files.set(p.file, p);
    let l = 0, t = 0;
    for (const f of files.values()) { l += f.loaded; t += f.total; }
    onProgress && onProgress({ stage: 'Downloading speech model (once)', pct: t ? l / t : 0 });
  });
  const wins = windows(audio.L, audio.R, vdb);
  const words = [];
  for (let i = 0; i < wins.length; i++) {
    if (signal && signal.aborted) break;
    const [a, b] = wins[i];
    const s = Math.floor(a * SR), e = Math.floor(b * SR);
    const mono = new Float32Array(e - s);
    for (let k = 0; k < mono.length; k++) mono[k] = (audio.L[s + k] + audio.R[s + k]) * 0.5;
    onProgress && onProgress({ stage: `Writing the script ${i + 1}/${wins.length}`, pct: i / wins.length });
    const out = await call({ type: 'run', ...opts, audio: mono }, null, [mono.buffer]);
    for (const c of out.chunks) {
      const txt = (c.text || '').trim();
      if (!txt || JUNK.test(txt)) continue;
      const t0 = a + (c.timestamp[0] ?? 0);
      const t1 = a + (c.timestamp[1] ?? c.timestamp[0] + 0.3);
      if (out.segments) words.push(...spread(txt, t0, t1));
      else words.push({ w: txt, t0, t1: Math.max(t1, t0 + 0.08) });
    }
  }
  onProgress && onProgress({ stage: 'Script ready', pct: 1 });
  return words.filter(w => !/^[\[(].*[\])]$/.test(w.w));
}

export function spread(text, t0, t1) {
  const parts = text.split(/\s+/).filter(Boolean);
  const weights = parts.map(p => p.length + 2);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let t = t0;
  return parts.map((w, i) => {
    const d = (t1 - t0) * weights[i] / sum;
    const o = { w, t0: t, t1: t + d };
    t += d;
    return o;
  });
}

// Words (absolute seconds) -> lines relative to the clip start.
export function linesFor(words, start, end) {
  const inside = words.filter(w => (w.t0 + w.t1) / 2 >= start && (w.t0 + w.t1) / 2 < end);
  const lines = [];
  let cur = null;
  for (const w of inside) {
    const rel = { w: w.w, t0: Math.max(0, w.t0 - start), t1: Math.min(end - start, w.t1 - start) };
    const len = cur ? cur.words.reduce((a, x) => a + x.w.length + 1, 0) : 0;
    const prev = cur && cur.words[cur.words.length - 1];
    if (!cur || rel.t0 - prev.t1 > 0.7 || len + rel.w.length > 44 || (/[.?!]$/.test(prev.w) && len > 14)) {
      cur = { words: [] };
      lines.push(cur);
    }
    cur.words.push(rel);
  }
  for (const l of lines) { l.t0 = l.words[0].t0; l.t1 = l.words[l.words.length - 1].t1; l.text = l.words.map(w => w.w).join(' '); }
  return lines;
}

// Manual edit: keep each line's timing, re-spread the new words across it.
export function relineText(lines, text, dur) {
  const rows = text.split('\n').map(s => s.trim()).filter(Boolean);
  const out = [];
  rows.forEach((row, i) => {
    let t0, t1;
    if (lines[i]) { t0 = lines[i].t0; t1 = lines[i].t1; }
    else {
      const last = out[out.length - 1];
      t0 = last ? last.t1 + 0.2 : 0.3; t1 = Math.min(dur, t0 + Math.max(1, row.length * 0.07));
    }
    const words = spread(row, t0, Math.max(t1, t0 + 0.3));
    out.push({ words, t0, t1: Math.max(t1, t0 + 0.3), text: row });
  });
  return out;
}
