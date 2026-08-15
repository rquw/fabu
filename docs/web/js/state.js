// ---------- project state ----------
'use strict';

let S = null;

function freshProject() {
  return {
    app: 'fabu',
    version: 1,
    bpm: 120,
    timeSig: [4, 4],  // [beats per bar, note value]. 3/4, 6/8 and friends
    snap: 1,          // grid in beats (0 = off)
    metronome: false,
    countIn: false,   // 1-2-3-4 before recording (off by default)
    masterVol: 0.9,
    loopOn: false,    // repeat a section while you work on it
    loopStart: 0,
    loopEnd: 8,
    markers: [],      // song sections: [{ id, beat, name }]
    instruments: {},   // id -> custom sampler instrument { name, sampleId, root, start, end, attack, release }
    tracks: []
  };
}

function beatsPerBar() {
  const ts = (S && S.timeSig) || [4, 4];
  const n = Math.max(1, ts[0] || 4), d = Math.max(1, ts[1] || 4);
  return n * (4 / d);
}

// ---------- sustain pedal ----------
function pedalEvents(clip) {
  const s = clip && clip.sustain;
  return (s && s.length) ? s : null;
}

function pedalDownAt(clip, beat) {
  const ev = pedalEvents(clip);
  if (!ev) return false;
  let down = false;
  for (const e of ev) {
    if (e.beat > beat + 1e-9) break;
    down = !!e.on;
  }
  return down;
}

function sustainedLength(clip, noteStart, dur) {
  const ev = pedalEvents(clip);
  if (!ev) return dur;
  const noteEnd = noteStart + dur;
  if (!pedalDownAt(clip, noteEnd)) return dur;
  let lift = clip.length;                     // still down at the end: ring to the clip end
  for (const e of ev) {
    if (e.beat > noteEnd + 1e-9 && !e.on) { lift = e.beat; break; }
  }
  return Math.max(dur, Math.min(lift, clip.length) - noteStart);
}

function setPedalSpan(clip, from, to) {
  if (!clip.sustain) clip.sustain = [];
  const spans = pedalSpans(clip);
  spans.push({ from: Math.max(0, from), to: Math.max(from, to) });
  spans.sort((a, b) => a.from - b.from);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.from <= last.to + 1e-9) last.to = Math.max(last.to, s.to);
    else merged.push({ from: s.from, to: s.to });
  }
  clip.sustain = [];
  for (const s of merged) { clip.sustain.push({ beat: s.from, on: true }, { beat: s.to, on: false }); }
}

function pedalSpans(clip) {
  const ev = pedalEvents(clip);
  if (!ev) return [];
  const out = [];
  let start = null;
  for (const e of ev) {
    if (e.on && start == null) start = e.beat;
    else if (!e.on && start != null) { out.push({ from: start, to: e.beat }); start = null; }
  }
  if (start != null) out.push({ from: start, to: clip.length });
  return out;
}

function clearPedalRange(clip, from, to) {
  const spans = [];
  for (const s of pedalSpans(clip)) {
    if (s.to <= from || s.from >= to) { spans.push(s); continue; }
    if (s.from < from) spans.push({ from: s.from, to: from });
    if (s.to > to) spans.push({ from: to, to: s.to });
  }
  clip.sustain = [];
  for (const s of spans) if (s.to > s.from + 1e-9) clip.sustain.push({ beat: s.from, on: true }, { beat: s.to, on: false });
}

const UI = {
  playhead: 0,          // beats
  playing: false,
  recording: false,
  zoom: 32,             // px per beat
  selClipId: null,      // primary (last clicked)
  selClipIds: new Set(),// full multi-selection (always contains selClipId when set)
  selTrackId: null,
  keysOctave: 4,
  keysTrackId: null,
  clipboard: null,      // { type:'clip'|'notes', data }
  dirty: false,         // changed since last autosave (autosave clears this)
  _fileDirty: false,    // changed since last save to a FILE (only a real save/new/load clears this)
  get fileDirty() { return this._fileDirty; },
  set fileDirty(v) {
    v = !!v;
    if (v === this._fileDirty) return;
    this._fileDirty = v;
    if (window.electronAPI && window.electronAPI.setDirty) {
      try { window.electronAPI.setDirty(v); } catch (e) {}
    }
  }
};

const Samples = {};

function makeTrack(kind) {
  const isMidi = kind === 'midi';
  const n = S.tracks.filter(t => t.kind === kind).length + 1;
  return {
    id: uid('trk'),
    kind,
    name: isMidi ? 'Instrument ' + n : 'Audio ' + n,
    instrument: isMidi ? 'rpiano' : null,   // the sampled grand, not the synth 'keys'
    color: nextColor(),
    volume: 0.8,
    pan: 0,
    swing: 0,    // 0..0.6 per-track swing (delays this track's offbeat 8ths)
    sidechain: 0, // 0..1 tempo-synced "pump" ducking on every beat
    eq: { low: 0, mid: 0, high: 0 },
    mute: false,
    solo: false,
    autom: {},   // param -> [{beat, v}] keyframes; empty means use the static value
    clips: []
  };
}

let LIB = {};
function resolveInstrument(id) {
  return (S && S.instruments && S.instruments[id]) || LIB[id] || null;
}

function automPoints(track, param) {
  if (!track.autom) track.autom = {};
  if (!track.autom[param]) track.autom[param] = [];
  return track.autom[param];
}

// ---------- automation curves ----------
const CURVE_SHAPES = ['lin', 'ease', 'in', 'out', 'hold'];

function curveEase(f, shape) {
  switch (shape) {
    case 'ease': return f * f * (3 - 2 * f);      // slow at both ends
    case 'in':   return f * f;                     // starts slowly, accelerates
    case 'out':  return 1 - (1 - f) * (1 - f);     // starts fast, settles
    case 'hold': return 0;                         // stays put, then jumps
    default:     return f;                         // straight
  }
}

function interpPoints(pts, beat) {
  if (!pts || !pts.length) return 0;
  if (beat <= pts[0].beat) return pts[0].v;
  if (beat >= pts[pts.length - 1].beat) return pts[pts.length - 1].v;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (beat >= a.beat && beat <= b.beat) {
      const f = (beat - a.beat) / ((b.beat - a.beat) || 1);
      return a.v + (b.v - a.v) * curveEase(f, a.c);
    }
  }
  return pts[pts.length - 1].v;
}

function automValueAt(track, param, beat) {
  const pts = track.autom && track.autom[param];
  if (!pts || !pts.length) return null;
  return interpPoints(pts, beat);   // one implementation, so curves apply everywhere
}

function getTrack(id) { return S.tracks.find(t => t.id === id); }
function getClip(id) {
  for (const t of S.tracks) {
    const c = t.clips.find(c => c.id === id);
    if (c) return { clip: c, track: t };
  }
  return null;
}

function clipOffSec(clip) { return clip.offset || 0; }
function clipDurSec(clip) {
  const s = Samples[clip.sampleId];
  const bufDur = s && s.buffer ? s.buffer.duration : 0;
  const off = clipOffSec(clip);
  const max = Math.max(0.05, bufDur - off);
  return clip.dur != null ? Math.min(clip.dur, max) : max;
}

// ---------- automated playback rate ----------
const _rateCache = new Map(); // clip.id -> { key, durSec, dt, table }

function clipRateAutom(clip) {
  return !!(clip && clip.kind === 'audio' && clip.autom &&
    ((clip.autom.speed && clip.autom.speed.length) || (clip.autom.pitch && clip.autom.pitch.length)));
}

function clipRateAtBeat(clip, beat) {
  const sp = (clip.autom && clip.autom.speed && clip.autom.speed.length)
    ? interpPoints(clip.autom.speed, beat) : (clip.speed || 1);
  const pf = (clip.autom && clip.autom.pitch && clip.autom.pitch.length)
    ? Math.pow(2, interpPoints(clip.autom.pitch, beat) / 12) : 1;
  return Math.max(0.01, sp * pf);
}

function clipAutoInfo(clip) {
  const avail = clipDurSec(clip);           // source seconds to consume
  const spb = 60 / (S.bpm || 120);
  const key = JSON.stringify([S.bpm, clip.speed || 1, avail, clip.start,
    clip.autom && clip.autom.speed, clip.autom && clip.autom.pitch]);
  const hit = _rateCache.get(clip.id);
  if (hit && hit.key === key) return hit;
  const dt = Math.min(0.02, spb / 8);
  const CAP = 1200;                          // sanity ceiling on output length
  const table = [0];
  let t = 0, consumed = 0;
  while (consumed < avail && t < CAP) {
    consumed += clipRateAtBeat(clip, clip.start + (t + dt / 2) / spb) * dt; // midpoint rule
    t += dt;
    table.push(Math.min(consumed, avail));
  }
  const info = {
    key, dt, table, durSec: t,
    sourceAt(outSec) {
      const i = Math.max(0, outSec / this.dt);
      const i0 = Math.min(this.table.length - 1, Math.floor(i));
      const i1 = Math.min(this.table.length - 1, i0 + 1);
      return this.table[i0] + (this.table[i1] - this.table[i0]) * (i - i0);
    }
  };
  _rateCache.set(clip.id, info);
  return info;
}

function audioClipBeats(clip) {
  const s = Samples[clip.sampleId];
  if (!s || !s.buffer) return 4;
  if (clipRateAutom(clip)) return clipAutoInfo(clip).durSec * (S.bpm / 60);
  return (clipDurSec(clip) / (clip.speed || 1)) * (S.bpm / 60);
}

const MAX_PATTERN_MINUTES = 2;
function maxPatternBeats() {
  return Math.max(8, Math.round(MAX_PATTERN_MINUTES * (S && S.bpm ? S.bpm : 120)));
}

function clipBeats(clip) {
  if (clip.kind === 'group') return clip.length;
  return clip.kind === 'midi' ? clip.length / (clip.speed || 1) : audioClipBeats(clip);
}

function songEndBeat() {
  let end = 16;
  for (const t of S.tracks)
    for (const c of t.clips)
      end = Math.max(end, c.start + clipBeats(c));
  return end;
}

// ---------- undo / redo ----------
const Undo = {
  undoStack: [],
  redoStack: [],
  max: 100,

  push(label) {
    this.undoStack.push({ label, snap: JSON.stringify(S) });
    if (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack.length = 0;
    UI.dirty = true;
    UI.fileDirty = true;
    updateUndoButtons();
    this._lastAt = Date.now();
  },

  // for held arrow keys: one undo step per burst, not one per repeat
  pushBurst(label, ms = 700) {
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && last.label === label && Date.now() - (this._lastAt || 0) < ms) {
      this._lastAt = Date.now();
      UI.dirty = true;
      UI.fileDirty = true;
      return;
    }
    this.push(label);
  },

  undo() {
    if (!this.undoStack.length) { toast(tr('toast_nothing_undo', 'Nothing to undo')); return; }
    const entry = this.undoStack.pop();
    this.redoStack.push({ label: entry.label, snap: JSON.stringify(S) });
    S = JSON.parse(entry.snap);   // S is replaced, old refs are stale
    afterStateRestore();
    toast(tr('undo_prefix', 'Undo') + ': ' + actLabel(entry.label));
    updateUndoButtons();
  },

  redo() {
    if (!this.redoStack.length) { toast(tr('toast_nothing_redo', 'Nothing to redo')); return; }
    const entry = this.redoStack.pop();
    this.undoStack.push({ label: entry.label, snap: JSON.stringify(S) });
    S = JSON.parse(entry.snap);
    afterStateRestore();
    toast(tr('redo_prefix', 'Redo') + ': ' + actLabel(entry.label));
    updateUndoButtons();
  }
};

function updateUndoButtons() {
  $('#btnUndo').style.opacity = Undo.undoStack.length ? 1 : 0.35;
  $('#btnRedo').style.opacity = Undo.redoStack.length ? 1 : 0.35;
}

const INSTR_REPLACED = { keys: 'rpiano' };

function migrateInstruments() {
  if (!S || !S.tracks) return;
  for (const t of S.tracks) {
    if (t.instrument && INSTR_REPLACED[t.instrument]) t.instrument = INSTR_REPLACED[t.instrument];
  }
}

function afterStateRestore() {
  migrateInstruments();
  if (UI.playing) Engine.stop();
  if (UI.selClipId && !getClip(UI.selClipId)) UI.selClipId = null;
  if (UI.selTrackId && !getTrack(UI.selTrackId)) UI.selTrackId = null;
  Engine.rebuildTracks();
  Engine.updateAllTracks();
  $('#bpmInput').value = S.bpm;
  $('#snapSelect').value = String(S.snap);
  $('#btnMetro').classList.toggle('on', S.metronome);
  Timeline.render();
  Windows.refreshAll();
  PianoRoll.onStateRestore();
  if (typeof Automation !== 'undefined') Automation.onStateRestore();
  KeysPanel.refreshTracks();
}
