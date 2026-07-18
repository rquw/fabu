// ---------- Small helpers, toasts, tooltips ----------
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------- i18n ----------
// I18N holds the active language's strings (empty until a file loads).
let I18N = {};
// raw lookup: undefined when a key is missing (so DOM keeps its built-in text)
function t(key) { return I18N[key]; }
// lookup with an English fallback and {placeholder} substitution
function tr(key, fallback, params) {
  let s = I18N[key];
  if (s == null) s = (fallback != null ? fallback : key);
  if (params) for (const p in params) s = s.split('{' + p + '}').join(params[p]);
  return s;
}

// instrument name: custom sampler name (project or library), else built-in label
function instrLabel(k) {
  const inst = (typeof S !== 'undefined' && S && S.instruments && S.instruments[k])
    || (typeof LIB !== 'undefined' && LIB[k]);
  if (inst) return inst.name;
  return tr('instr_' + k, (typeof INSTRUMENTS !== 'undefined' && INSTRUMENTS[k]) || k);
}
// translated drum-row name for a pitch class, or null if it has no name
const DRUM_LABEL_KEYS = { 0: 'drum_kick', 2: 'drum_snare', 4: 'drum_clap', 6: 'drum_hat', 10: 'drum_ophat' };
function drumLabel(pc) {
  const k = DRUM_LABEL_KEYS[pc];
  return k ? tr(k, k.replace('drum_', '')) : null;
}
// translated snapping label for a grid value
function snapLabel(v) {
  const m = {
    '4': tr('snap_bar', 'Bar'), '1': tr('snap_beat', 'Beat'),
    '0.5': '1/8', '0.25': '1/16', '0.125': '1/32', '0': tr('snap_off', 'Off')
  };
  return m[String(v)] || String(v);
}
// who to credit for new clips (multiplayer attribution)
function authorName() {
  return (typeof Auth !== 'undefined' && Auth.user) || null;
}

// translated undo/redo action label (built from the stored English label)
function actLabel(label) {
  if (label == null) return '';
  const slug = 'act_' + String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return tr(slug, label);
}

let _idCounter = 0;
function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + '_' + (_idCounter++).toString(36);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}
function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function fmtDb(v) { return (v > 0 ? '+' : '') + Number(v).toFixed(1) + ' dB'; }
function fmtSec(s) {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return m + ':' + (sec < 10 ? '0' : '') + sec.toFixed(1);
}

// Snap a beat value to the current grid (0 = snapping off)
function snapBeat(beat, grid) {
  if (!grid) return Math.max(0, beat);
  return Math.max(0, Math.round(beat / grid) * grid);
}

const TRACK_COLORS = ['#e0894a', '#5cb0a2', '#d8a13a', '#cf6f63', '#88a05c', '#c281a8', '#6f97c4', '#b8895f'];
let _colorIdx = 0;
function nextColor() { return TRACK_COLORS[_colorIdx++ % TRACK_COLORS.length]; }

// ---------- Toasts (bottom right: "what just happened") ----------

function toast(msg, kind = '') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  box.appendChild(el);
  while (box.children.length > 5) box.firstChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, 2200);
}

function setHint(msg) { $('#statusHint').textContent = msg; }

// ---------- Tooltips (hover any [data-tip]) ----------

(function initTooltips() {
  const tip = document.getElementById('tooltip');
  let timer = null;
  let current = null;

  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t === current) return;
    current = t;
    clearTimeout(timer);
    tip.classList.add('hidden');
    if (!t) return;
    timer = setTimeout(() => {
      tip.textContent = t.dataset.tip;
      tip.classList.remove('hidden');
      const r = t.getBoundingClientRect();
      tip.style.left = '0px'; tip.style.top = '0px';
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = clamp(r.left + r.width / 2 - tw / 2, 8, window.innerWidth - tw - 8);
      let y = r.bottom + 8;
      if (y + th > window.innerHeight - 8) y = r.top - th - 8;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    }, 420);
  });

  document.addEventListener('mousedown', () => {
    clearTimeout(timer);
    tip.classList.add('hidden');
  }, true);
})();

// ---------- base64 <-> ArrayBuffer ----------

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ---------- droppable clip effects ----------
// One entry per effect the user can drag from the Effects browser onto a clip.
// p = param defs: key -> { min, max, step, def, unit }
const FX_DEFS = {
  reverb: { nameKey: 'fx_reverb', fallback: 'Reverb',
    p: { amt: { min: 0, max: 1, step: 0.01, def: 0.35, labelKey: 'fx_amount', labelFb: 'Amount' } } },
  echo: { nameKey: 'fx_echo', fallback: 'Echo',
    p: { time: { min: 0.05, max: 1, step: 0.01, def: 0.3, labelKey: 'fx_time', labelFb: 'Time' },
         fb:   { min: 0, max: 0.9, step: 0.01, def: 0.35, labelKey: 'fx_feedback', labelFb: 'Feedback' },
         mix:  { min: 0, max: 1, step: 0.01, def: 0.35, labelKey: 'fx_mix', labelFb: 'Mix' } } },
  dampen: { nameKey: 'fx_dampen', fallback: 'Dampen',
    p: { freq: { min: 200, max: 20000, step: 100, def: 2500, labelKey: 'fx_cutoff', labelFb: 'Cutoff' } } },
  drive: { nameKey: 'fx_drive', fallback: 'Drive',
    p: { amt: { min: 0, max: 100, step: 1, def: 40, labelKey: 'fx_amount', labelFb: 'Amount' } } },
  crush: { nameKey: 'fx_crush', fallback: 'Crush',
    p: { amt: { min: 0, max: 100, step: 1, def: 50, labelKey: 'fx_amount', labelFb: 'Amount' } } }
};
function fxName(type) {
  const d = FX_DEFS[type];
  return d ? tr(d.nameKey, d.fallback) : type;
}
