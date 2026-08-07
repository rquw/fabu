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
  const known = typeof INSTRUMENTS !== 'undefined' && INSTRUMENTS[k];
  if (known) return tr('instr_' + k, known);
  // An id we do not have. A loop shared from a newer build can carry one, and
  // showing "rbass808" to somebody is showing them our variable names.
  return tr('instr_unknown', 'Unknown instrument');
}
// translated drum-row name for a pitch class, or null if it has no name
const DRUM_LABEL_KEYS = { 0: 'drum_kick', 2: 'drum_snare', 4: 'drum_clap', 6: 'drum_hat', 9: 'drum_tom', 10: 'drum_ophat' };
function isDrumInstr(i) { return i === 'drums' || i === 'drumkit'; }
// The drum lanes the piano roll shows for a kit: only sounds that actually play,
// each labeled, top to bottom. The synth kit has no tom (pc 9 = open hat there).
function drumRowsFor(instrument) {
  const all = [
    { pc: 10, key: 'drum_ophat' },
    { pc: 6, key: 'drum_hat' },
    { pc: 9, key: 'drum_tom' },
    { pc: 4, key: 'drum_clap' },
    { pc: 2, key: 'drum_snare' },
    { pc: 0, key: 'drum_kick' }
  ];
  const rows = instrument === 'drumkit' ? all : all.filter(r => r.pc !== 9);
  return rows.map(r => ({ pitch: 60 + r.pc, label: tr(r.key, r.key.replace('drum_', '')) }));
}
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
  // Hats carry accents on the downbeats. A row of identical 8ths reads as a
  // machine; accenting 1 and 3 is what makes it feel like a groove.
  { id: 'dr_four', cat: 'drums', name: 'Four on the Floor', instrument: 'drums', length: 4,
    notes: _drum({ k: 'X...X...X...X...', h: 'X.x.x.x.X.x.x.x.', s: '....X.......X...' }) },
  { id: 'dr_boom', cat: 'drums', name: 'Boom Bap', instrument: 'drums', length: 4,
    notes: _drum({ k: 'X.....X...X.....', s: '....X.......X...', h: 'X.x.x.x.X.x.x.x.' }) },
  { id: 'dr_rock', cat: 'drums', name: 'Rock Beat', instrument: 'drums', length: 4,
    notes: _drum({ k: 'X.......X.......', s: '....X.......X...', h: 'X.x.x.x.X.x.x.x.' }) },
  { id: 'dr_trap', cat: 'drums', name: 'Trap Hats', instrument: 'drums', length: 4,
    notes: _drum({ k: 'X.........X.....', s: '........X.......', h: 'Xxxxxxx.Xxxxxxxx', o: '..............x.' }) },
  { id: 'dr_house', cat: 'drums', name: 'House Groove', instrument: 'drums', length: 4,
    notes: _drum({ k: 'X...X...X...X...', o: '..x...x...x...x.', c: '....X.......X...' }) },
  // real recorded kit (CC0 samples in assets/oneshots)
  { id: 'dr_acoustic', cat: 'drums', name: 'Acoustic Groove', instrument: 'drumkit', length: 4,
    notes: _drum({ k: 'X.......X.......', s: '....X.......X...', h: 'X.x.x.x.X.x.x.x.' }) },
  { id: 'dr_acbap', cat: 'drums', name: 'Acoustic Boom Bap', instrument: 'drumkit', length: 4,
    notes: _drum({ k: 'X.....X...X.....', s: '....X.......X...', h: 'X.x.x.x.X.x.x.x.', t: '.............x.x' }) },

  // --- bass (low octave) ---
  { id: 'ba_walk', cat: 'bass', name: 'Walking Bass', instrument: 'bass', length: 4,
    notes: _line([[0, 40, 0.9, 0.95], [1, 43, 0.9, 0.8], [2, 45, 0.9, 0.9], [3, 47, 0.9, 0.8]]) },
  // the 808 is a real instrument now, and this is what people mean by sub bass
  { id: 'ba_sub', cat: 'bass', name: 'Sub Bass', instrument: 'sub', length: 4,
    notes: _line([[0, 36, 1.9, 1], [2, 36, 1.9, 0.85]]) },
  { id: 'ba_off', cat: 'bass', name: 'Offbeat Bass', instrument: 'bass', length: 4,
    notes: _line([[0.5, 40, 0.45], [1.5, 40, 0.45], [2.5, 43, 0.45], [3.5, 45, 0.45]]) },
  // sits between the kicks instead of doubling them, which is the point of it
  { id: 'ba_house', cat: 'bass', name: 'House Bass', instrument: 'bass', length: 4,
    notes: _line([[0.5, 40, 0.4], [1.5, 40, 0.4], [2.5, 40, 0.4], [3.5, 43, 0.4]]) },

  // --- melodic (all in C major so anything here layers with anything else) ---
  { id: 'me_chords', cat: 'melodic', name: 'Piano Chords', instrument: 'rpiano', length: 4,
    notes: _chords([[0, [60, 64, 67], 1], [1, [57, 60, 64], 1], [2, [53, 57, 60], 1], [3, [55, 59, 62], 1]]) },
  { id: 'me_pad', cat: 'melodic', name: 'String Pad', instrument: 'strings', length: 4,
    notes: _chords([[0, [55, 60, 64], 2], [2, [53, 57, 60], 2]]) },
  { id: 'me_arp', cat: 'melodic', name: 'Bright Arp', instrument: 'pluck', length: 4,
    notes: _line([[0, 60, 0.25], [0.5, 64, 0.25], [1, 67, 0.25], [1.5, 72, 0.25], [2, 67, 0.25], [2.5, 64, 0.25], [3, 60, 0.25], [3.5, 64, 0.25]]) },
  { id: 'me_epiano', cat: 'melodic', name: 'Dreamy Chords', instrument: 'epiano', length: 4,
    notes: _chords([[0, [64, 67, 71], 1.5], [1.5, [62, 65, 69], 1.5], [3, [60, 64, 67], 1]]) },
  { id: 'me_bell', cat: 'melodic', name: 'Sparkle Melody', instrument: 'bell', length: 4,
    notes: _line([[0, 72, 0.5], [1, 76, 0.5], [2, 79, 0.5], [2.5, 76, 0.25], [3, 72, 1]]) },
  { id: 'me_organ', cat: 'melodic', name: 'Organ Chords', instrument: 'organ', length: 4,
    notes: _chords([[0, [55, 60, 64], 1.9], [2, [53, 57, 60], 1.9]]) },
  { id: 'me_warmpad', cat: 'melodic', name: 'Warm Pad', instrument: 'pad', length: 4,
    notes: _chords([[0, [55, 60, 64, 67], 2], [2, [53, 57, 60, 65], 2]]) },
  { id: 'me_lead', cat: 'melodic', name: 'Synth Lead', instrument: 'synth', length: 4,
    notes: _line([[0, 72, 0.4, 0.95], [0.75, 72, 0.25, 0.7], [1.25, 76, 0.5, 0.85],
                  [2, 79, 0.4, 0.95], [2.75, 76, 0.25, 0.7], [3.25, 72, 0.7, 0.85]]) },
  // stride: root on the strong beats, chord on the weak ones
  { id: 'me_stride', cat: 'melodic', name: 'Upright Stride', instrument: 'rupright', length: 4,
    notes: [].concat(
      _line([[0, 48, 0.4, 0.95], [2, 55, 0.4, 0.9]]),
      _chords([[1, [64, 67, 72], 0.4], [3, [62, 65, 71], 0.4]])) },
  // the glockenspiel is only sampled from G5 up, so this stays where it was recorded
  { id: 'me_glock', cat: 'melodic', name: 'Music Box', instrument: 'rglock', length: 4,
    notes: _line([[0, 84, 0.5, 1], [0.5, 88, 0.5, 0.9], [1, 91, 0.5, 1],
                  [2, 88, 0.5, 0.9], [2.5, 84, 0.5, 0.95], [3, 79, 1, 0.9]]) },
  { id: 'me_harp', cat: 'melodic', name: 'Harp Roll', instrument: 'rharp', length: 4,
    notes: _line([[0, 48, 0.3, 0.9], [0.25, 55, 0.3, 0.8], [0.5, 60, 0.3, 0.85], [0.75, 64, 0.3, 0.8],
                  [1, 67, 0.3, 0.9], [1.25, 72, 0.3, 0.8], [1.5, 76, 1.5, 0.85],
                  [2.5, 72, 0.3, 0.75], [2.75, 67, 0.3, 0.7], [3, 64, 1, 0.8]]) },
  { id: 'me_flute', cat: 'melodic', name: 'Flute Line', instrument: 'rflute', length: 4,
    notes: _line([[0, 72, 0.9, 0.8], [1, 76, 0.45, 0.85], [1.5, 74, 0.45, 0.7], [2, 72, 0.9, 0.85], [3, 67, 0.9, 0.75]]) },

  // --- jazz: a small section that works together, ii V I in C over two bars ---
  // Swing lives in the ride: beats 1 to 4 plus the "a" of 2 and 4, which is the
  // nearest a 16th grid gets to a triplet and is what makes it read as jazz.
  { id: 'jz_swing', cat: 'jazz', name: 'Swing Ride', instrument: 'drumkit', length: 4,
    notes: _drum({ h: 'X...X..xX...X..x', k: 'x.......x.......', s: '..........x.....' }) },
  { id: 'jz_brush', cat: 'jazz', name: 'Brush Shuffle', instrument: 'drumkit', length: 4,
    notes: _drum({ h: 'X..xx..xX..xx..x', s: '....x.......x...', k: 'x...............' }) },
  // walks D F A B | G A B C, landing on the root of the I chord
  { id: 'jz_walk', cat: 'jazz', name: 'Jazz Walking Bass', instrument: 'bass', length: 8,
    notes: _line([[0, 38, 0.9, 0.95], [1, 41, 0.9, 0.8], [2, 45, 0.9, 0.9], [3, 47, 0.9, 0.8],
                  [4, 43, 0.9, 0.95], [5, 45, 0.9, 0.8], [6, 47, 0.9, 0.9], [7, 48, 0.9, 0.85]]) },
  // rootless voicings, so the bass keeps the bottom to itself
  { id: 'jz_keys', cat: 'jazz', name: 'Jazz Comp (ii V I)', instrument: 'rpiano', length: 8,
    notes: _chords([[0, [65, 69, 72, 76], 1.6], [2, [59, 62, 65, 69], 1.6], [4, [64, 67, 71, 74], 3.4]]) },
  { id: 'jz_trumpet', cat: 'jazz', name: 'Trumpet Lead', instrument: 'rtrumpet', length: 8,
    notes: _line([[0, 69, 0.45, 0.9], [0.5, 72, 0.45, 0.8], [1, 74, 0.45, 0.85], [1.5, 77, 0.45, 0.8],
                  [2, 76, 0.45, 0.9], [2.5, 74, 0.45, 0.75], [3, 71, 0.45, 0.8], [3.5, 67, 0.45, 0.75],
                  [4, 76, 1.4, 0.95], [5.5, 72, 2.2, 0.85]]) },
  { id: 'jz_sax', cat: 'jazz', name: 'Sax Answer', instrument: 'rsax', length: 8,
    notes: _line([[1.5, 60, 0.45, 0.8], [2, 62, 0.45, 0.85], [2.5, 65, 0.45, 0.8], [3, 67, 0.9, 0.9],
                  [4.5, 64, 0.45, 0.8], [5, 62, 0.45, 0.75], [5.5, 60, 2, 0.85]]) },
  // both horns on the same short hits, the sound of a horn section
  { id: 'jz_vibes', cat: 'jazz', name: 'Vibes Comp', instrument: 'rvibes', length: 8,
    notes: _chords([[0, [65, 69, 72], 1.4], [2, [62, 65, 69], 1.4], [4, [64, 67, 71], 3.4]]) },
  { id: 'jz_stabs', cat: 'jazz', name: 'Horn Stabs', instrument: 'rtrumpet', length: 4,
    notes: _chords([[0, [72, 76], 0.3], [1.5, [74, 77], 0.3], [2.5, [71, 76], 0.3], [3, [72, 79], 0.7]]) },
];
// Anything that came from another person goes through here before it reaches
// innerHTML. A loop name is typed by a stranger, which is exactly the kind of
// text that must never be read as markup.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A small menu under whatever was clicked. items is [[label, fn], ...].
function ctxMenu(ev, items) {
  const old = document.getElementById('ctxShared');
  if (old) old.remove();
  const m = document.createElement('div');
  m.id = 'ctxShared';
  m.className = 'ctx-menu';
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.className = 'ctx-item';
    b.textContent = label;
    b.addEventListener('click', () => { m.remove(); fn(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = (ev.currentTarget || ev.target).getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.min(r.bottom + 6, window.innerHeight - m.offsetHeight - 8) + 'px';
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); window.removeEventListener('mousedown', close, true); } };
  setTimeout(() => window.addEventListener('mousedown', close, true), 0);
  return m;
}

const SAMPLE_CATS = ['mine', 'drums', 'bass', 'melodic', 'jazz', 'other'];
function sampleCatName(c) {
  const fallback = { mine: 'Yours', drums: 'Drums', bass: 'Bass', melodic: 'Melodic', jazz: 'Jazz', other: 'Other', fx: 'Sound FX' };
  return tr('samp_cat_' + c, fallback[c] || c);
}

// ---------- the card you are dragging ----------
// The browser's own drag image is a frozen snapshot: it cannot move, so the
// thing under your cursor was dead while the card left behind in the list did
// the animating, which is backwards. This replaces it with a real element that
// follows the pointer and swings like something held at the top: the further it
// lags behind your hand, the more it trails, and it settles when you stop.
const DragGhost = {
  el: null, x: 0, y: 0, angle: 0, vel: 0, lastX: 0, raf: null, painting: false,

  // One transparent pixel, made at startup rather than on the first drag. An
  // image that has not finished decoding has naturalWidth 0, which the OS
  // rejects, and rejecting it is what brought back its own icon.
  pixel() {
    let px = document.getElementById('dragPixel');
    if (!px) {
      px = document.createElement('img');
      px.id = 'dragPixel';
      px.alt = '';
      px.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      document.body.appendChild(px);
    }
    return px;
  },

  // Shift turns a drag into a brush: the card goes green with a plus, and the
  // cursor becomes a brush, so the mode is obvious before you touch anything.
  setPaint(on) {
    if (on === this.painting) return;
    this.painting = on;
    document.body.classList.toggle('fx-painting', on);
    if (this.el) this.el.classList.toggle('ghost-paint', on);
  },

  start(sourceEl, e) {
    this.stop();
    const g = sourceEl.cloneNode(true);
    g.classList.remove('card-lifted');
    g.id = 'dragGhostCard';
    g.style.width = sourceEl.offsetWidth + 'px';
    document.body.appendChild(g);
    this.el = g;
    this.x = e.clientX; this.y = e.clientY; this.lastX = e.clientX;
    this.angle = 0; this.vel = 0;
    if (this.painting) g.classList.add('ghost-paint');
    // Hide the native drag image. It has to be a real, rendered, in-document
    // image: a detached canvas is never painted, so macOS discards it and falls
    // back to its own generic icon (the globe that flies in from the corner).
    try { e.dataTransfer.setDragImage(this.pixel(), 0, 0); }
    catch (err) { /* older engines keep their own ghost, which is fine */ }
    this.draw();
    this.raf = requestAnimationFrame(() => this.tick());
  },

  move(clientX, clientY) {
    if (!this.el || (!clientX && !clientY)) return;   // some browsers send 0,0 on the last event
    this.x = clientX; this.y = clientY;
  },

  tick() {
    if (!this.el) return;
    const dx = this.x - this.lastX;
    this.lastX = this.x;
    // a pendulum: the pointer's motion pushes it, gravity pulls it back to
    // hanging, and friction stops it ringing forever
    const target = clamp(dx * 0.53, -11, 11);
    this.vel += (target - this.angle) * 0.18;
    this.vel *= 0.82;
    this.angle = clamp(this.angle + this.vel, -12.5, 12.5);
    this.draw();
    this.raf = requestAnimationFrame(() => this.tick());
  },

  draw() {
    if (!this.el) return;
    this.el.style.transform =
      `translate(${this.x}px, ${this.y}px) translate(-50%, -8px) rotate(${this.angle.toFixed(2)}deg)`;
  },

  // Let go and the card comes apart rather than blinking out: it fades and
  // drifts while a scatter of specks lifts off it. Short enough to read as a
  // release, not a cutscene.
  stop() {
    const wasPainting = this.painting;   // read before clearing it, for the dust colour
    this.setPaint(false);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    const el = this.el;
    this.el = null;                       // stop the pointer driving it mid-dissolve
    if (!el) return;
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) { el.remove(); return; }

    const r = el.getBoundingClientRect();
    if (!r.width) { el.remove(); return; }
    // the animation has to keep the position and lean it already had, so hand
    // the current transform to the keyframes rather than overwriting it
    el.style.setProperty('--gt', el.style.transform || 'none');
    el.classList.add('ghost-dissolve');

    // specks seeded across the card, weighted toward the trailing edge so it
    // looks like it is coming apart rather than exploding from the middle
    const n = Math.min(26, Math.max(12, Math.round(r.width / 9)));
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'ghost-dust' + (wasPainting ? ' paint' : '');
      const fx = Math.pow(Math.random(), 0.7);
      d.style.left = (r.left + fx * r.width) + 'px';
      d.style.top = (r.top + Math.random() * r.height) + 'px';
      const size = 2 + Math.random() * 3;
      d.style.width = d.style.height = size.toFixed(1) + 'px';
      d.style.setProperty('--dx', ((Math.random() - 0.35) * 46).toFixed(1) + 'px');
      d.style.setProperty('--dy', (-14 - Math.random() * 40).toFixed(1) + 'px');
      d.style.animationDelay = (fx * 130).toFixed(0) + 'ms';
      frag.appendChild(d);
    }
    const dust = [...frag.children];
    document.body.appendChild(frag);
    setTimeout(() => { el.remove(); for (const d of dust) d.remove(); }, 780);
  },

  // The first release of a drag used to stutter, and the second and third a
  // little. The browser will not build the layers or compile the keyframes for
  // an animation it has never run, so it does all of that during the first one.
  // Running it once on something invisible at startup moves that cost to a
  // moment when nobody is watching.
  warm() {
    if (this._warm) return;
    this._warm = true;
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const box = document.createElement('div');
    box.id = 'dragGhostCard';
    box.style.cssText = 'left:-9999px;top:-9999px;width:40px;height:20px;opacity:0';
    box.style.setProperty('--gt', 'none');
    const speck = document.createElement('div');
    speck.className = 'ghost-dust';
    speck.style.cssText = 'left:-9999px;top:-9999px;width:3px;height:3px;opacity:0';
    speck.style.setProperty('--dx', '10px');
    speck.style.setProperty('--dy', '-10px');
    document.body.append(box, speck);
    // a frame between insert and animate, or the two are batched into one style
    // pass and the layer is still built lazily
    requestAnimationFrame(() => {
      box.classList.add('ghost-dissolve');
      setTimeout(() => { box.remove(); speck.remove(); }, 900);
    });
  }
};
// Shift is the paint modifier, and it should be readable BEFORE you commit to a
// drag: hold it and the effect cards show what shift-dragging them will do.
// Tracked on the window so it survives focus moving between panels.
(function trackShift() {
  const set = (on) => {
    if (document.body.classList.contains('shift-held') === on) return;
    document.body.classList.toggle('shift-held', on);
    if (DragGhost.el) DragGhost.setPaint(on);
  };
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') set(true); });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') set(false); });
  // a lost window (alt-tab, a native dialog) must not leave it stuck on
  window.addEventListener('blur', () => set(false));
})();

// decode the stand-in pixel now, so it is ready before anyone drags anything,
// and run the release animation once while it cannot be seen
function warmDragGhost() { DragGhost.pixel(); setTimeout(() => DragGhost.warm(), 600); }
if (document.body) warmDragGhost();
else document.addEventListener('DOMContentLoaded', warmDragGhost);

// dragover is the event that reliably carries coordinates while a drag is live,
// and the only one that reports the shift key during a drag
document.addEventListener('dragover', (e) => {
  DragGhost.move(e.clientX, e.clientY);
  if (DragGhost.el) DragGhost.setPaint(e.shiftKey);
});
document.addEventListener('drop', () => DragGhost.stop());
document.addEventListener('dragend', () => DragGhost.stop());
window.DragGhost = DragGhost;

// ---------- your own loops ----------
// A loop is notes plus an instrument, which is why it costs kilobytes rather
// than megabytes: nothing is recorded, the instruments are already in the app.
// That is what makes saving and sharing them cheap enough to be free.
const MyLoops = {
  KEY: 'fabu.myLoops',
  EXT: '.fabloop',

  all() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(l => l && l.id && Array.isArray(l.notes)) : [];
    } catch (e) { return []; }
  },

  save(list) {
    try { localStorage.setItem(this.KEY, JSON.stringify(list)); return true; }
    catch (e) { toast(tr('loop_save_fail', 'There is no room left to save loops.'), 'red'); return false; }
  },

  // Build one from a pattern on the timeline. Notes are normalised to start at
  // zero so a loop taken from bar 30 still begins at the beginning.
  fromClip(clip, track) {
    if (!clip || clip.kind !== 'midi' || !clip.notes || !clip.notes.length) return null;
    let first = Infinity;
    for (const n of clip.notes) first = Math.min(first, n.start);
    if (!isFinite(first)) first = 0;
    return {
      id: uid('myloop'),
      name: (clip.name || tr('loop_untitled', 'My loop')).slice(0, 40),
      instrument: (track && track.instrument) || 'rpiano',
      length: Math.max(1, clip.length || 4),
      notes: clip.notes.map(n => ({
        pitch: n.pitch, start: +(n.start - first).toFixed(4),
        length: n.length, vel: n.vel ?? 0.85
      })),
      sustain: clip.sustain ? clip.sustain.map(e => ({ beat: e.beat, on: !!e.on })) : undefined,
      made: Date.now()
    };
  },

  add(loop) {
    if (!loop) return null;
    const list = this.all();
    list.push(loop);
    return this.save(list) ? loop : null;
  },

  update(id, patch) {
    const list = this.all();
    const i = list.findIndex(l => l.id === id);
    if (i < 0) return false;
    Object.assign(list[i], patch);
    return this.save(list);
  },

  remove(id) {
    return this.save(this.all().filter(l => l.id !== id));
  },

  // ---------- sharing ----------
  // A .fabloop is a small JSON file. Deliberately plain text: anyone can look
  // inside one, and it will still open in ten years.
  toFile(loop) {
    return JSON.stringify({ fabloop: 1, name: loop.name, instrument: loop.instrument,
                            length: loop.length, notes: loop.notes, sustain: loop.sustain }, null, 1);
  },

  parseFile(text) {
    let d;
    try { d = JSON.parse(text); } catch (e) { return null; }
    if (!d || !d.fabloop || !Array.isArray(d.notes) || !d.notes.length) return null;
    const clean = d.notes
      .filter(n => n && typeof n.pitch === 'number' && typeof n.start === 'number')
      .map(n => ({
        pitch: clamp(Math.round(n.pitch), 0, 127),
        start: Math.max(0, +n.start || 0),
        length: Math.max(1 / 32, +n.length || 0.25),
        vel: clamp(+n.vel || 0.85, 0.05, 1)
      }));
    if (!clean.length) return null;
    const instr = (typeof INSTRUMENTS !== 'undefined' && INSTRUMENTS[d.instrument]) ? d.instrument : 'rpiano';
    return {
      id: uid('myloop'),
      name: String(d.name || tr('loop_untitled', 'My loop')).slice(0, 40),
      instrument: instr,
      length: Math.max(1, +d.length || 4),
      notes: clean,
      sustain: Array.isArray(d.sustain) ? d.sustain : undefined,
      made: Date.now()
    };
  },

  isLoopFile(f) { return /\.fabloop$/i.test(f.name) || /\.fabloop\.json$/i.test(f.name); },

  // shaped like a SAMPLE_LIB entry so everything downstream treats them alike
  asPresets() {
    return this.all().map(l => ({
      id: l.id, cat: 'mine', name: l.name, instrument: l.instrument,
      length: l.length, notes: l.notes, sustain: l.sustain, mine: true, from: l.from || null
    }));
  }
};
window.MyLoops = MyLoops;

// ---------- chord progression suggestions ----------
// Most beginners can hear when a chord is wrong but cannot name what would be
// right. This suggests the next chord from what is already there, using the
// ordinary pull of one chord toward another rather than anything clever.
const ChordSuggest = {
  // Roman numeral positions within the key, and what each usually moves to,
  // most likely first. Both majors and minors are described by scale degree,
  // so the same table works in any key.
  NEXT_MAJOR: {
    0: [4, 5, 3, 1],    // I  goes to V, vi, IV, ii
    1: [4, 6, 0],       // ii goes to V
    2: [5, 3, 0],       // iii
    3: [4, 0, 1, 5],    // IV
    4: [0, 5, 3],       // V  goes home
    5: [3, 1, 4, 0],    // vi
    6: [0, 4]           // vii
  },
  NEXT_MINOR: {
    0: [5, 3, 6, 4],    // i
    1: [4, 6, 0],
    2: [5, 6, 0],
    3: [0, 4, 5],
    4: [0, 5],
    5: [2, 3, 0],
    6: [0, 3]
  },
  // How a triad on each degree is spelled, in semitones from the degree's root
  TRIAD_MAJOR: [[0,4,7],[0,3,7],[0,3,7],[0,4,7],[0,4,7],[0,3,7],[0,3,6]],
  TRIAD_MINOR: [[0,3,7],[0,3,6],[0,4,7],[0,3,7],[0,3,7],[0,4,7],[0,4,7]],
  ROMAN_MAJOR: ['I','ii','iii','IV','V','vi','vii°'],
  ROMAN_MINOR: ['i','ii°','III','iv','v','VI','VII'],

  // "G major" reads to everyone; "V" only reads to people who took theory.
  plainName(base, intervals) {
    const letter = NOTE_NAMES[((base % 12) + 12) % 12];
    const third = intervals[1], fifth = intervals[2];
    const quality = fifth === 6 ? tr('chord_dim', 'diminished')
      : third === 3 ? tr('chord_minor', 'minor')
      : tr('chord_major', 'major');
    return letter + ' ' + quality;
  },

  // only the seven-note scales have a sensible notion of degrees
  usable(scaleId) { return scaleId === 'major' || scaleId === 'minor' || scaleId === 'dorian'; },
  minorish(scaleId) { return scaleId === 'minor' || scaleId === 'dorian'; },

  // Which scale degree a stack of notes sits on, or null if it is not a triad
  // in this key. Works off pitch classes, so voicing and octave do not matter.
  degreeOf(pitches, root, scaleId) {
    if (!pitches || pitches.length < 2) return null;
    const steps = SCALES[scaleId] ? SCALES[scaleId].steps : SCALES.major.steps;
    const pcs = [...new Set(pitches.map(p => ((p - root) % 12 + 12) % 12))].sort((a, b) => a - b);
    const triads = this.minorish(scaleId) ? this.TRIAD_MINOR : this.TRIAD_MAJOR;
    for (let d = 0; d < 7; d++) {
      const base = steps[d % steps.length];
      const want = triads[d].map(iv => (base + iv) % 12).sort((a, b) => a - b);
      // every note we have belongs to the chord, and we have most of the chord
      const covered = pcs.every(pc => want.includes(pc));
      if (covered && pcs.length >= 2) return d;
    }
    return null;
  },

  // The chord to suggest next, as { degree, roman, pitches }
  next(prevDegree, root, scaleId, octaveRoot) {
    const table = this.minorish(scaleId) ? this.NEXT_MINOR : this.NEXT_MAJOR;
    const romans = this.minorish(scaleId) ? this.ROMAN_MINOR : this.ROMAN_MAJOR;
    const triads = this.minorish(scaleId) ? this.TRIAD_MINOR : this.TRIAD_MAJOR;
    const steps = SCALES[scaleId] ? SCALES[scaleId].steps : SCALES.major.steps;
    // no previous chord: start on the home chord, which is always a safe move
    const options = prevDegree == null ? [0] : (table[prevDegree] || [0]);
    const degree = options[0];
    const base = octaveRoot + steps[degree % steps.length];
    return { degree, roman: romans[degree], name: this.plainName(base, triads[degree]),
             pitches: triads[degree].map(iv => base + iv) };
  },

  // Every option for a degree, so the user can cycle rather than take the first
  optionsFor(prevDegree, scaleId) {
    const table = this.minorish(scaleId) ? this.NEXT_MINOR : this.NEXT_MAJOR;
    return prevDegree == null ? [0] : (table[prevDegree] || [0]);
  },

  chordAt(degree, root, scaleId, octaveRoot) {
    const romans = this.minorish(scaleId) ? this.ROMAN_MINOR : this.ROMAN_MAJOR;
    const triads = this.minorish(scaleId) ? this.TRIAD_MINOR : this.TRIAD_MAJOR;
    const steps = SCALES[scaleId] ? SCALES[scaleId].steps : SCALES.major.steps;
    const base = octaveRoot + steps[degree % steps.length];
    return { degree, roman: romans[degree], name: this.plainName(base, triads[degree]),
             pitches: triads[degree].map(iv => base + iv) };
  },

  enabled() {
    try { return localStorage.getItem('fabu.chordHints') !== '0'; } catch (e) { return true; }
  },
  setEnabled(on) {
    try { localStorage.setItem('fabu.chordHints', on ? '1' : '0'); } catch (e) {}
  }
};
window.ChordSuggest = ChordSuggest;
