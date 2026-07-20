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
const DRUM_LABEL_KEYS = { 0: 'drum_kick', 2: 'drum_snare', 4: 'drum_clap', 6: 'drum_hat', 9: 'drum_tom', 10: 'drum_ophat' };
function isDrumInstr(i) { return i === 'drums' || i === 'drumkit'; }
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

// ---------- Scales & chords (the "key helper") ----------
// Semitone patterns from the root, one octave.
const SCALES = {
  major:      { name: 'Major',            steps: [0, 2, 4, 5, 7, 9, 11] },
  minor:      { name: 'Minor',            steps: [0, 2, 3, 5, 7, 8, 10] },
  pentMajor:  { name: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  pentMinor:  { name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  dorian:     { name: 'Dorian',           steps: [0, 2, 3, 5, 7, 9, 10] },
  chromatic:  { name: 'Chromatic (all notes)', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
};
function scaleName(id) { const s = SCALES[id]; return s ? tr('scale_' + id, s.name) : id; }

// Is a midi pitch inside the given key?
function inScale(pitch, root, scaleId) {
  const s = SCALES[scaleId] || SCALES.major;
  return s.steps.includes(((pitch - root) % 12 + 12) % 12);
}
// Nearest in-key pitch (for snap-to-scale); ties round down.
function nearestInScale(pitch, root, scaleId) {
  if (inScale(pitch, root, scaleId)) return pitch;
  for (let d = 1; d <= 6; d++) {
    if (inScale(pitch - d, root, scaleId)) return pitch - d;
    if (inScale(pitch + d, root, scaleId)) return pitch + d;
  }
  return pitch;
}
// Diatonic chord (stacked thirds within the key) built on a pitch, staying in key.
// Returns an array of midi pitches. An off-key click is pulled onto the nearest key note first.
function diatonicChord(pitch, root, scaleId, size = 3) {
  const steps = (SCALES[scaleId] || SCALES.major).steps;
  const base = nearestInScale(pitch, root, scaleId);
  const rel = ((base - root) % 12 + 12) % 12;
  const rootPitchBelow = base - rel;             // the scale root at/below base
  let deg = steps.indexOf(rel);
  if (deg < 0) deg = 0;
  const out = [];
  for (let i = 0; i < size; i++) {
    const stepIdx = deg + i * 2;                  // stack thirds: root, +2, +4 steps
    const oct = Math.floor(stepIdx / steps.length);
    out.push(rootPitchBelow + steps[stepIdx % steps.length] + 12 * oct);
  }
  return out;
}

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

function setHint(msg) { const el = $('#statusHint'); if (el) el.textContent = msg; } // status bar removed; kept null-safe

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
    p: { amt: { min: 0, max: 100, step: 1, def: 50, labelKey: 'fx_amount', labelFb: 'Amount' } } },
  lowcut: { nameKey: 'fx_lowcut', fallback: 'Low cut',
    p: { freq: { min: 20, max: 2000, step: 10, def: 200, labelKey: 'fx_cutoff', labelFb: 'Cutoff' } } },
  tremolo: { nameKey: 'fx_tremolo', fallback: 'Tremolo',
    p: { rate: { min: 0.5, max: 16, step: 0.1, def: 5, labelKey: 'fx_rate', labelFb: 'Rate' },
         depth: { min: 0, max: 1, step: 0.01, def: 0.6, labelKey: 'fx_depth', labelFb: 'Depth' } } },
  wobble: { nameKey: 'fx_wobble', fallback: 'Wobble',
    p: { rate: { min: 0.25, max: 12, step: 0.05, def: 3, labelKey: 'fx_rate', labelFb: 'Rate' },
         amt: { min: 0, max: 1, step: 0.01, def: 0.7, labelKey: 'fx_amount', labelFb: 'Amount' } } },
  widen: { nameKey: 'fx_widen', fallback: 'Widen',
    p: { amt: { min: 0, max: 1, step: 0.01, def: 0.6, labelKey: 'fx_amount', labelFb: 'Amount' } } }
};
function fxName(type) {
  const d = FX_DEFS[type];
  return d ? tr(d.nameKey, d.fallback) : type;
}

// ---------- built-in sample loops ----------
// Loops are preset note PATTERNS played by the synth engine (no bundled audio,
// so they stay tiny AND you can open and edit them). Notes are templates without
// ids; ids get assigned when a loop is dropped into a project.
const DRUM_PC = { k: 0, s: 2, c: 4, h: 6, t: 9, o: 10 }; // kick snare clap hat tom ophat

// build drum notes from 16-step strings (X = accent, x/o = normal, . = rest)
function _drum(rows) {
  const notes = [];
  for (const inst in rows) {
    const pc = DRUM_PC[inst], steps = rows[inst];
    for (let i = 0; i < steps.length; i++) {
      const ch = steps[i];
      if (ch !== '.' && ch !== ' ') notes.push({ pitch: 60 + pc, start: i * 0.25, length: 0.25, vel: ch === 'X' ? 1 : 0.72 });
    }
  }
  return notes;
}
// build a line from [start, pitch, length, (vel)] tuples
function _line(tuples) {
  return tuples.map(t => ({ start: t[0], pitch: t[1], length: t[2], vel: t[3] ?? 0.85 }));
}
// build chord blocks from [start, [pitches], length] tuples
function _chords(blocks) {
  const notes = [];
  for (const [start, pitches, length] of blocks) for (const p of pitches) notes.push({ start, pitch: p, length, vel: 0.8 });
  return notes;
}

const SAMPLE_LIB = [
  // --- drums (4 beats each) ---
  { id: 'dr_four', cat: 'drums', name: 'Four on the Floor', instrument: 'drums', length: 4,
    notes: _drum({ k: 'X...X...X...X...', h: 'x.x.x.x.x.x.x.x.', s: '....X.......X...' }) },
  { id: 'dr_boom', cat: 'drums', name: 'Boom Bap', instrument: 'drums', length: 4,
    notes: _drum({ k: 'X.....X...X.....', s: '....X.......X...', h: 'x.x.x.x.x.x.x.x.' }) },
  { id: 'dr_rock', cat: 'drums', name: 'Rock Beat', instrument: 'drums', length: 4,
    notes: _drum({ k: 'X.......X.......', s: '....X.......X...', h: 'x.x.x.x.x.x.x.x.' }) },
  { id: 'dr_trap', cat: 'drums', name: 'Trap Hats', instrument: 'drums', length: 4,
    notes: _drum({ k: 'X.........X.....', s: '........X.......', h: 'xxxxxxxxxxxxxxxx', o: '..............x.' }) },
  { id: 'dr_house', cat: 'drums', name: 'House Groove', instrument: 'drums', length: 4,
    notes: _drum({ k: 'X...X...X...X...', o: '..x...x...x...x.', c: '....X.......X...' }) },
  // real recorded kit (CC0 samples in assets/oneshots)
  { id: 'dr_acoustic', cat: 'drums', name: 'Acoustic Groove', instrument: 'drumkit', length: 4,
    notes: _drum({ k: 'X.......X.......', s: '....X.......X...', h: 'x.x.x.x.x.x.x.x.' }) },
  { id: 'dr_acbap', cat: 'drums', name: 'Acoustic Boom Bap', instrument: 'drumkit', length: 4,
    notes: _drum({ k: 'X.....X...X.....', s: '....X.......X...', h: 'x.x.x.x.x.x.x.x.', t: '.............x.x' }) },

  // --- bass (low octave) ---
  { id: 'ba_walk', cat: 'bass', name: 'Walking Bass', instrument: 'bass', length: 4,
    notes: _line([[0, 40, 0.9], [1, 43, 0.9], [2, 45, 0.9], [3, 47, 0.9]]) },
  { id: 'ba_sub', cat: 'bass', name: 'Sub Bass', instrument: 'bass', length: 4,
    notes: _line([[0, 36, 1.9], [2, 36, 1.9]]) },
  { id: 'ba_off', cat: 'bass', name: 'Offbeat Bass', instrument: 'bass', length: 4,
    notes: _line([[0.5, 40, 0.45], [1.5, 40, 0.45], [2.5, 43, 0.45], [3.5, 45, 0.45]]) },
  { id: 'ba_house', cat: 'bass', name: 'House Bass', instrument: 'bass', length: 4,
    notes: _line([[0, 40, 0.4], [1, 40, 0.4], [2, 40, 0.4], [3, 40, 0.4]]) },

  // --- melodic ---
  { id: 'me_chords', cat: 'melodic', name: 'Piano Chords', instrument: 'keys', length: 4,
    notes: _chords([[0, [60, 64, 67], 1], [1, [57, 60, 64], 1], [2, [53, 57, 60], 1], [3, [55, 59, 62], 1]]) },
  { id: 'me_pad', cat: 'melodic', name: 'Warm Pad', instrument: 'strings', length: 4,
    notes: _chords([[0, [55, 60, 64], 2], [2, [53, 57, 60], 2]]) },
  { id: 'me_arp', cat: 'melodic', name: 'Bright Arp', instrument: 'pluck', length: 4,
    notes: _line([[0, 60, 0.25], [0.5, 64, 0.25], [1, 67, 0.25], [1.5, 72, 0.25], [2, 67, 0.25], [2.5, 64, 0.25], [3, 60, 0.25], [3.5, 64, 0.25]]) },
  { id: 'me_epiano', cat: 'melodic', name: 'Dreamy Chords', instrument: 'epiano', length: 4,
    notes: _chords([[0, [64, 67, 71], 1.5], [1.5, [62, 65, 69], 1.5], [3, [60, 64, 67], 1]]) },
  { id: 'me_bell', cat: 'melodic', name: 'Sparkle Melody', instrument: 'bell', length: 4,
    notes: _line([[0, 72, 0.5], [1, 76, 0.5], [2, 79, 0.5], [2.5, 76, 0.25], [3, 72, 1]]) },

  // --- one-shot sound effect ---
  { id: 'fx_downer', cat: 'fx', name: 'Downlifter', instrument: 'sfx_downer', length: 4, notes: [{ pitch: 60, start: 0, length: 4, vel: 0.9 }] }
];
const SAMPLE_CATS = ['drums', 'bass', 'melodic', 'fx'];
function sampleCatName(c) {
  return tr('samp_cat_' + c, c === 'drums' ? 'Drums' : c === 'bass' ? 'Bass' : c === 'melodic' ? 'Melodic' : 'Sound FX');
}
