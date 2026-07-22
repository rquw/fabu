// ---------- Project state, samples, and the undo system ----------
'use strict';

// The whole song lives in S. Everything in S is JSON-serializable,
// which is what makes snapshot-undo and .fab saving simple.
let S = null;

function freshProject() {
  return {
    app: 'fabu',
    version: 1,
    bpm: 120,
    snap: 1,          // grid in beats (0 = off)
    metronome: false,
    countIn: false,   // 1-2-3-4 before recording (off by default)
    masterVol: 0.9,
    instruments: {},   // id -> custom sampler instrument { name, sampleId, root, start, end, attack, release }
    tracks: []
  };
}

// Runtime-only UI state (not saved, not undoable)
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
  fileDirty: false      // changed since last save to a FILE (only a real save/new/load clears this)
};

// Decoded audio lives here, referenced by sampleId from clips.
// { id: { name, buffer: AudioBuffer, bytes: ArrayBuffer, mime } }
const Samples = {};

function makeTrack(kind) {
  const isMidi = kind === 'midi';
  const n = S.tracks.filter(t => t.kind === kind).length + 1;
  return {
    id: uid('trk'),
    kind,
    name: isMidi ? 'Instrument ' + n : 'Audio ' + n,
    instrument: isMidi ? 'keys' : null,
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

// Persistent instrument library (id -> def), shared across all projects.
// Its sample buffers are decoded into Samples on startup.
let LIB = {};
function resolveInstrument(id) {
  return (S && S.instruments && S.instruments[id]) || LIB[id] || null;
}

// Automation keyframes for one parameter, created on demand
function automPoints(track, param) {
  if (!track.autom) track.autom = {};
  if (!track.autom[param]) track.autom[param] = [];
  return track.autom[param];
}

// Interpolated automation value at a beat, or null if the param has no keyframes
function automValueAt(track, param, beat) {
  const pts = track.autom && track.autom[param];
  if (!pts || !pts.length) return null;
  if (beat <= pts[0].beat) return pts[0].v;
  if (beat >= pts[pts.length - 1].beat) return pts[pts.length - 1].v;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (beat >= a.beat && beat <= b.beat) {
      const f = (beat - a.beat) / (b.beat - a.beat || 1);
      return a.v + (b.v - a.v) * f;
    }
  }
  return pts[pts.length - 1].v;
}

function getTrack(id) { return S.tracks.find(t => t.id === id); }
function getClip(id) {
  for (const t of S.tracks) {
    const c = t.clips.find(c => c.id === id);
    if (c) return { clip: c, track: t };
  }
  return null;
}

// Trimming: clip.offset = seconds into the sample where playback starts,
// clip.dur = seconds of sample material to play (both in the sample's own time)
function clipOffSec(clip) { return clip.offset || 0; }
function clipDurSec(clip) {
  const s = Samples[clip.sampleId];
  const bufDur = s && s.buffer ? s.buffer.duration : 0;
  const off = clipOffSec(clip);
  const max = Math.max(0.05, bufDur - off);
  return clip.dur != null ? Math.min(clip.dur, max) : max;
}

// Audio clip length in beats depends on trim, tempo and speed. Pitch shifting
// preserves duration (so it does NOT change the length); speed does.
function audioClipBeats(clip) {
  const s = Samples[clip.sampleId];
  if (!s || !s.buffer) return 4;
  return (clipDurSec(clip) / (clip.speed || 1)) * (S.bpm / 60);
}

function clipBeats(clip) {
  if (clip.kind === 'group') return clip.length;
  return clip.kind === 'midi' ? clip.length : audioClipBeats(clip);
}

function songEndBeat() {
  let end = 16;
  for (const t of S.tracks)
    for (const c of t.clips)
      end = Math.max(end, c.start + clipBeats(c));
  return end;
}

// ---------- Undo / redo: snapshot the whole project ----------
// Every mutating action calls pushUndo('label') BEFORE changing S.

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
  },

  undo() {
    if (!this.undoStack.length) { toast(tr('toast_nothing_undo', 'Nothing to undo')); return; }
    const entry = this.undoStack.pop();
    this.redoStack.push({ label: entry.label, snap: JSON.stringify(S) });
    S = JSON.parse(entry.snap);
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

// Re-sync everything visible after S got replaced (undo/redo/load)
function afterStateRestore() {
  if (UI.playing) Engine.stop();
  // selection may point at things that no longer exist
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
