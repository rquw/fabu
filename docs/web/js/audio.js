// ---------- Audio engine: instruments, playback scheduler, recording, export ----------
'use strict';

const INSTRUMENTS = {
  epiano: 'E-Piano',
  organ: 'Organ',
  strings: 'Strings',
  synth: 'Synth Lead',
  bass:  'Bass',
  pluck: 'Pluck',
  bell:  'Bell',
  rpiano: 'Grand Piano',
  rupright: 'Upright Piano',
  rvibes: 'Vibraphone',
  rglock: 'Glockenspiel',
  rharp: 'Harp',
  sub: '808 Bass',
  pad: 'Warm Pad',
  rtrumpet: 'Trumpet',
  rflute: 'Flute',
  rsax: 'Saxophone',
  drums: 'Drum Kit',
  drumkit: 'Acoustic Kit'
};

// real recorded melodic instruments (bundled CC0 MP3s in assets/instr), played
// multi-zone: pick the sample whose root is nearest the note, then pitch-shift a little
const MELODIC = {
  rpiano: { name: 'Grand Piano', attack: 0.004, release: 0.18, zones: [{ file: 'piano_c2', root: 36 }, { file: 'piano_c4', root: 60 }, { file: 'piano_c6', root: 84 }] },
  rvibes: { name: 'Vibraphone', attack: 0.003, release: 0.4, zones: [{ file: 'vibes_c3', root: 48 }, { file: 'vibes_d4', root: 62 }, { file: 'vibes_a4', root: 69 }, { file: 'vibes_c5', root: 72 }, { file: 'vibes_e5', root: 76 }] },
  // roots below were measured from the audio, not taken from the file names
  // (VCSL labels these an octave off, which would have detuned everything)
  rupright: { name: 'Upright Piano', gain: 2.6, attack: 0.004, release: 0.2, zones: [{ file: 'upright_c3', root: 48 }, { file: 'upright_c4', root: 60 }, { file: 'upright_c5', root: 72 }, { file: 'upright_c6', root: 84 }, { file: 'upright_c7', root: 96 }] },
  rglock: { name: 'Glockenspiel', gain: 5.5, attack: 0.002, release: 0.5, zones: [{ file: 'glock_g5', root: 79 }, { file: 'glock_c6', root: 84 }, { file: 'glock_c7', root: 96 }, { file: 'glock_c8', root: 108 }] },
  // Wind and brass from the University of Iowa Musical Instrument Samples
  // (Lawrence Fritts), which the university publishes for use in any project
  // without restriction. Sliced out of their chromatic scale recordings; the
  // roots below are the pitch each note actually sounded, so a trumpet that
  // records 8 cents flat plays in tune here.
  rtrumpet: { name: 'Trumpet', gain: 0.64, attack: 0.02, release: 0.16, zones: [{ file: 'trumpet_g3', root: 54.936 }, { file: 'trumpet_b3', root: 58.93 }, { file: 'trumpet_e4', root: 63.898 }, { file: 'trumpet_g4', root: 66.892 }, { file: 'trumpet_c5', root: 71.932 }, { file: 'trumpet_g5', root: 79.121 }] },
  rflute: { name: 'Flute', gain: 2.34, attack: 0.03, release: 0.18, zones: [{ file: 'flute_d4', root: 61.923 }, { file: 'flute_g4', root: 67.055 }, { file: 'flute_c5', root: 72.101 }, { file: 'flute_g5', root: 79.053 }, { file: 'flute_c6', root: 84.214 }] },
  rsax: { name: 'Saxophone', gain: 0.93, attack: 0.022, release: 0.17, zones: [{ file: 'sax_cs3', root: 49.136 }, { file: 'sax_g3', root: 55.093 }, { file: 'sax_c4', root: 60.106 }, { file: 'sax_g4', root: 67.228 }, { file: 'sax_c5', root: 72.252 }, { file: 'sax_f5', root: 77.295 }] },
  // Pipe organ from VCSL. These filenames were honest, unlike the ones above it.
  organ: { name: 'Organ', gain: 4.28, attack: 0.03, release: 0.12, zones: [{ file: 'organ_c2', root: 36.027 }, { file: 'organ_c3', root: 47.995 }, { file: 'organ_c4', root: 59.985 }, { file: 'organ_c5', root: 71.993 }] },
  rharp: { name: 'Harp', gain: 4.2, attack: 0.003, release: 0.35, zones: [{ file: 'harp_d2', root: 38 }, { file: 'harp_g3', root: 55 }, { file: 'harp_c5', root: 72 }, { file: 'harp_d6', root: 86 }] }
};

// pitch-class -> bundled real drum sample (assets/oneshots). Same layout as the
// synth kit (kick=C, snare=D, clap=E, closed hat=F#, open hat=A#) plus a tom.
const DRUMKIT_MAP = { 0: 'kick', 2: 'snare', 4: 'clap', 6: 'hat_closed', 9: 'tom', 10: 'hat_open' };

const Engine = {
  ctx: null,
  master: null,
  comp: null,
  metroGain: null,
  chains: new Map(),     // trackId -> { input, eqLow, eqMid, eqHigh, pan, gain }
  live: new Set(),       // killable handles for everything currently sounding
  liveKeys: new Map(),   // "trackId:pitch" -> voice (computer keyboard)

  // playback
  startCtxTime: 0,
  startBeat: 0,
  schedTimer: null,
  events: [],            // sorted [{beat, fn(time)}]
  evIdx: 0,
  nextClickBeat: 0,

  // sustain pedal (live playing)
  pedalDown: false,
  pedalHeld: new Set(),   // keys let go of while the pedal is down

  // recording
  mediaRec: null,
  recChunks: [],
  recStream: null,
  recStartBeat: 0,
  midiRec: null,        // { trackId, clip, startBeat, held: Map } while note-recording

  // A last ceiling after the glue compressor. The compressor is deliberately
  // gentle (-3 dB, 3:1) so it does not duck quiet notes, which means a project
  // with a lot stacked on it can still leave peaks above 1.0, and anything
  // above 1.0 clips the moment it becomes a file. This curve is exactly linear
  // below 0.8, so ordinary material passes through untouched, and folds what is
  // above that into the remaining headroom instead of letting it square off.
  ceilingCurve() {
    if (this._ceilCurve) return this._ceilCurve;
    const n = 4096, c = new Float32Array(n);
    const shape = (x) => {
      const a = Math.abs(x), sg = x < 0 ? -1 : 1;
      if (a <= 0.8) return x;
      return sg * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
    };
    for (let i = 0; i < n; i++) c[i] = shape((i / (n - 1)) * 2 - 1);
    this._ceilCurve = c;
    return c;
  },
  makeCeiling(ac) {
    const ws = ac.createWaveShaper();
    ws.curve = this.ceilingCurve();
    // No oversampling on purpose. Oversampling filters ring, and that ringing
    // overshoots the curve's own maximum, which is the one thing this node
    // exists to prevent: measured, 4x still let 20 samples past 1.0. With none,
    // the output is exactly a table lookup and cannot exceed the table.
    ws.oversample = 'none';
    return ws;
  },

  ensureCtx() {
    if (this.ctx) return this.ctx;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
  // A gentle glue/limiter, not a pumping compressor. The old aggressive
    // settings (thr -8, ratio 6) ducked quiet notes hard whenever one loud
    // sound hit, so notes seemed to "cut out"; this only catches the peaks.
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -3;
    this.comp.knee.value = 8;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.006;
    this.comp.release.value = 0.2;
    this.master = this.ctx.createGain();
    this.master.gain.value = S.masterVol;
    this.master.connect(this.comp);
    this.ceiling = this.makeCeiling(this.ctx);
    // a little room reverb makes the synths feel real
    this.rev = this.buildReverb(this.ctx, this.master, this.comp, 0.16);
    if (this.ecoMode()) { try { this.rev.pre.disconnect(this.rev.conv); } catch (e) {} }
    this.comp.connect(this.ceiling);
    this.ceiling.connect(this.ctx.destination);
    this.metroGain = this.ctx.createGain();
    this.metroGain.gain.value = 1;
    this.metroGain.connect(this.comp); // clicks stay dry
    this.rebuildTracks();
    return this.ctx;
  },

  spb() { return 60 / S.bpm; },

  // a synthesized impulse response: exponentially decaying stereo noise
  impulse(ac, seconds = 1.7, decay = 2.6) {
    const len = Math.floor(ac.sampleRate * seconds);
    const buf = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  },

  // master reverb send: dryBus -> convolver -> wet -> dest (dryBus already -> dest)
  // `pre` is exposed so per-clip reverb effects can send into the same convolver.
  buildReverb(ac, source, dest, wetLevel) {
    const conv = ac.createConvolver();
    conv.buffer = this.impulse(ac);
    const pre = ac.createGain(); pre.gain.value = 1;
    const wet = ac.createGain(); wet.gain.value = wetLevel;
    source.connect(pre); pre.connect(conv); conv.connect(wet); wet.connect(dest);
    return { conv, wet, pre };
  },

  // eco mode: cheaper audio path for low-end machines (no convolver, fewer voices)
  // scrubbing preference (on by default). Drag the playhead to hear what's under it.
  scrubOn() { try { return localStorage.getItem('fabu.scrub') !== '0'; } catch (e) { return true; } },
  setScrub(on) { try { localStorage.setItem('fabu.scrub', on ? '1' : '0'); } catch (e) {} if (!on) this.scrubEnd(); },
  ecoMode() { try { return localStorage.getItem('fabu.eco') === '1'; } catch (e) { return false; } },
  setEco(on) {
    try { localStorage.setItem('fabu.eco', on ? '1' : '0'); } catch (e) {}
    if (this.rev) {
      try {
        if (on) this.rev.pre.disconnect(this.rev.conv);
        else this.rev.pre.connect(this.rev.conv);
      } catch (e) {}
    }
  },
  voiceCap() { return this.ecoMode() ? 40 : 96; },

  // Every sounding voice registers here. Past the cap we steal the voices that
  // are CLOSEST TO ENDING (least audible to cut) instead of the oldest. The
  // old "steal oldest" logic chopped sustained notes off mid-hold.
  registerVoice(h, endTime) {
    if (endTime) h._end = endTime;
    this.live.add(h);
    const cap = this.voiceCap();
    if (this.live.size > cap) {
      const arr = [...this.live].sort((a, b) => (a._end || Infinity) - (b._end || Infinity));
      const kill = arr.slice(0, this.live.size - cap);
      for (const v of kill) { try { v.kill(); } catch (e) {} this.live.delete(v); }
    }
  },

  // ----- track chains: clips into input, then EQ (3 band), pan, gain, master -----

  buildChain(ac, dest, track) {
    const input = ac.createGain();
    const trim = ac.createGain();     // 'gain' automation (pre-EQ trim, default 1)
    const eqLow = ac.createBiquadFilter();
    eqLow.type = 'lowshelf'; eqLow.frequency.value = 220;
    const eqMid = ac.createBiquadFilter();
    eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 0.9;
    const eqHigh = ac.createBiquadFilter();
    eqHigh.type = 'highshelf'; eqHigh.frequency.value = 4500;
    // drive + crush as parallel wet stages (wet gain 0 = clean passthrough)
    const driveWS = ac.createWaveShaper(); driveWS.curve = this.distortionCurve(60); driveWS.oversample = '2x';
    const driveWet = ac.createGain(); driveWet.gain.value = 0;
    const driveSum = ac.createGain();
    const crushWS = ac.createWaveShaper(); crushWS.curve = this.crushCurve(60);
    const crushWet = ac.createGain(); crushWet.gain.value = 0;
    const crushSum = ac.createGain();
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 20000; lp.Q.value = 0.7;
    const pan = ac.createStereoPanner();
    const gain = ac.createGain();
    const sc = ac.createGain();   // sidechain "pump" ducking (1 = no ducking)
    input.connect(trim);
    trim.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh);
    // drive stage: dry through + distorted*wet, summed
    eqHigh.connect(driveSum);
    eqHigh.connect(driveWS); driveWS.connect(driveWet); driveWet.connect(driveSum);
    // crush stage
    driveSum.connect(crushSum);
    driveSum.connect(crushWS); crushWS.connect(crushWet); crushWet.connect(crushSum);
    crushSum.connect(lp); lp.connect(pan); pan.connect(gain); gain.connect(sc); sc.connect(dest);
    const chain = { input, trim, eqLow, eqMid, eqHigh, driveWet, crushWet, lp, pan, gain, sc };
    this.applyParams(chain, track);
    return chain;
  },

  applyParams(chain, track) {
    chain.eqLow.gain.value = track.eq.low;
    chain.eqMid.gain.value = track.eq.mid;
    chain.eqHigh.gain.value = track.eq.high;
    chain.pan.pan.value = track.pan;
    chain.gain.gain.value = this.audible(track) ? track.volume : 0;
    // static values for the extra automatable params default to transparent
    if (chain.trim) chain.trim.gain.value = automValueAt(track, 'gain', 0) != null ? automValueAt(track, 'gain', 0) : 1;
    if (chain.driveWet) chain.driveWet.gain.value = automValueAt(track, 'drive', 0) != null ? automValueAt(track, 'drive', 0) : 0;
    if (chain.crushWet) chain.crushWet.gain.value = automValueAt(track, 'crush', 0) != null ? automValueAt(track, 'crush', 0) : 0;
    if (chain.lp) chain.lp.frequency.value = automValueAt(track, 'filter', 0) != null ? automValueAt(track, 'filter', 0) : 20000;
  },

  audible(track) {
    const anySolo = S.tracks.some(t => t.solo);
    if (track.mute) return false;
    return anySolo ? track.solo : true;
  },

  rebuildTracks() {
    if (!this.ctx) return;
    for (const c of this.chains.values()) { try { c.gain.disconnect(); } catch (e) {} }
    this.chains.clear();
    for (const t of S.tracks) {
      this.chains.set(t.id, this.buildChain(this.ctx, this.master, t));
    }
    if (S.tracks.some(t => t.instrument === 'drumkit')) this.ensureDrumkit();
    if (S.tracks.some(t => MELODIC[t.instrument])) this.ensureMelodic();
  },

  updateTrack(track) {
    const c = this.chains.get(track.id);
    if (c) this.applyParams(c, track);
  },

  updateAllTracks() {
    for (const t of S.tracks) this.updateTrack(t);
    if (this.master) this.master.gain.value = S.masterVol;
  },

  // ----- automation (keyframes over time) -----

  AUTOM_PARAMS: ['volume', 'gain', 'low', 'mid', 'high', 'pan', 'drive', 'crush', 'filter', 'transpose'],

  automAudioParam(chain, param) {
    switch (param) {
      case 'volume': return chain.gain.gain;
      case 'gain': return chain.trim.gain;
      case 'low': return chain.eqLow.gain;
      case 'mid': return chain.eqMid.gain;
      case 'high': return chain.eqHigh.gain;
      case 'pan': return chain.pan.pan;
      case 'drive': return chain.driveWet.gain;
      case 'crush': return chain.crushWet.gain;
      case 'filter': return chain.lp.frequency;
      // 'transpose' has no audio-rate param; it's applied per note at schedule time
    }
    return null;
  },

  scheduleAutomation(ac, chain, track, startBeat, startTime, spb) {
    if (!track.autom) return;
    for (const param of this.AUTOM_PARAMS) {
      const pts = track.autom[param];
      if (!pts || !pts.length) continue;
      const ap = this.automAudioParam(chain, param);
      if (!ap) continue;
      const gate = param === 'volume' ? (this.audible(track) ? 1 : 0) : 1;
      try { ap.cancelScheduledValues(startTime); } catch (e) {}
      ap.setValueAtTime(automValueAt(track, param, startBeat) * gate, startTime);
      for (const pt of pts) {
        if (pt.beat <= startBeat) continue;
        ap.linearRampToValueAtTime(pt.v * gate, startTime + (pt.beat - startBeat) * spb);
      }
    }
  },

  scheduleAllAutomation(startBeat, startTime) {
    const spb = this.spb();
    for (const t of S.tracks) {
      const chain = this.chains.get(t.id);
      if (chain) this.scheduleAutomation(this.ctx, chain, t, startBeat, startTime, spb);
    }
  },

  // sidechain "pump": duck the track on every beat then let it swell back,
  // the classic compressor-pumping sound, tempo-synced (no real audio keying)
  scheduleSidechain(chain, track, startBeat, startTime, spb) {
    const sc = chain.sc;
    if (!sc) return;
    try { sc.gain.cancelScheduledValues(startTime); } catch (e) {}
    const amt = track.sidechain || 0;
    if (amt <= 0) { sc.gain.setValueAtTime(1, startTime); return; }
    const low = Math.max(0.02, 1 - amt);
    const end = Math.max(songEndBeat() + 8, startBeat + 64);
    sc.gain.setValueAtTime(1, startTime);
    for (let b = Math.ceil(startBeat - 1e-6); b <= end; b++) {
      const t = startTime + (b - startBeat) * spb;
      if (t < startTime) continue;
      sc.gain.setValueAtTime(low, t);                    // duck on the beat
      sc.gain.linearRampToValueAtTime(1, t + spb * 0.9); // swell back before the next
    }
  },
  scheduleAllSidechain(startBeat, startTime) {
    const spb = this.spb();
    for (const t of S.tracks) {
      const chain = this.chains.get(t.id);
      if (chain) this.scheduleSidechain(chain, t, startBeat, startTime, spb);
    }
  },
  rescheduleSidechain(track) {
    if (!UI.playing || !this.ctx) return;
    const chain = this.chains.get(track.id);
    if (chain) this.scheduleSidechain(chain, track, this.currentBeat(), this.ctx.currentTime + 0.02, this.spb());
  },

  // live re-apply after editing a track's automation while playing
  rescheduleAutomation(track) {
    if (!UI.playing || !this.ctx) return;
    const chain = this.chains.get(track.id);
    if (chain) this.scheduleAutomation(this.ctx, chain, track, this.currentBeat(), this.ctx.currentTime, this.spb());
  },

  clearScheduledParams() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const [id, c] of this.chains) {
      for (const ap of [c.gain.gain, c.trim.gain, c.eqLow.gain, c.eqMid.gain, c.eqHigh.gain, c.pan.pan, c.driveWet.gain, c.crushWet.gain, c.lp.frequency]) {
        try { ap.cancelScheduledValues(now); } catch (e) {}
      }
      if (c.sc) { try { c.sc.gain.cancelScheduledValues(now); c.sc.gain.setValueAtTime(1, now); } catch (e) {} }
      const t = getTrack(id);
      if (t) this.applyParams(c, t);
    }
  },

  trackInput(trackId) {
    let c = this.chains.get(trackId);
    if (!c) {
      const t = getTrack(trackId);
      if (!t) return this.master;
      c = this.buildChain(this.ctx, this.master, t);
      this.chains.set(trackId, c);
    }
    return c.input;
  },

  // ----- noise buffer cache (per context) -----

  noise(ac) {
    if (!ac._noiseBuf) {
      const b = ac.createBuffer(1, ac.sampleRate * 1, ac.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      ac._noiseBuf = b;
    }
    return ac._noiseBuf;
  },

  // ----- pitch shifting that keeps the same duration (granular overlap-add) -----

  // returns a pitch-shifted copy of the sample's buffer, cached per semitone
  shiftedBuffer(sample, semis) {
    semis = Math.round(semis || 0);
    if (!semis) return sample.buffer;
    if (!sample._shift) sample._shift = {};
    if (!sample._shift[semis]) sample._shift[semis] = this.pitchShiftBuffer(sample.buffer, semis);
    return sample._shift[semis];
  },

  pitchShiftBuffer(buffer, semis) {
    const ratio = Math.pow(2, semis / 12);
    const sr = buffer.sampleRate;
    const len = buffer.length;
    const out = this.ctx.createBuffer(buffer.numberOfChannels, len, sr);
    const grain = 1024, hop = grain / 4;
    const win = new Float32Array(grain);
    for (let i = 0; i < grain; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grain - 1));
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const inp = buffer.getChannelData(ch);
      const o = out.getChannelData(ch);
      const norm = new Float32Array(len);
      for (let pos = 0; pos + grain < len; pos += hop) {
        for (let k = 0; k < grain; k++) {
          const inIdx = pos + k * ratio;      // read the grain faster/slower -> pitch shift
          const i0 = Math.floor(inIdx);
          if (i0 < 0 || i0 + 1 >= len) continue;
          const frac = inIdx - i0;
          const smp = inp[i0] * (1 - frac) + inp[i0 + 1] * frac;
          o[pos + k] += smp * win[k];         // place grains at the same rate -> same duration
          norm[pos + k] += win[k];
        }
      }
      for (let i = 0; i < len; i++) if (norm[i] > 1e-6) o[i] /= norm[i];
    }
    return out;
  },

  // ----- instruments (all synthesized, clean sounds, no samples needed) -----

  // noAttack = true starts the voice already in its sustain phase (a tiny fade,
  // no hard attack transient) so a note you seek INTO doesn't re-strike.
  makeVoice(ac, dest, instr, pitch, t, vel = 0.9, noAttack = false) {
    const custom = resolveInstrument(instr);
    if (custom) return this.makeSamplerVoice(ac, dest, custom, pitch, t, vel, noAttack);
    if (this.SFX && this.SFX[instr]) return this.SFX[instr](ac, dest, pitch, t, vel);
    if (instr === 'drums') return this.makeDrum(ac, dest, pitch, t, vel);
    if (instr === 'drumkit') return this.makeDrumkitVoice(ac, dest, pitch, t, vel);
    if (MELODIC[instr]) return this.makeMelodicVoice(ac, dest, instr, pitch, t, vel, noAttack);
    // 'keys' was a synthesised piano, replaced by the sampled grand. Projects
    // saved with it are remapped on load; this catches anything that slips past.
    if (instr === 'keys') return this.makeMelodicVoice(ac, dest, 'rpiano', pitch, t, vel, noAttack);

    const f = midiToFreq(pitch);
    const g = ac.createGain();
    g.connect(dest);
    const oscs = [];
    let filter = null;
    let A = 0.01, D = 0.25, SUS = 0.6, R = 0.3, peak = 0.4;
    let filtEnv = 0; // extra Hz the filter opens on attack then decays away

    const mk = (type, freq, det = 0, lvl = 1) => {
      const o = ac.createOscillator();
      o.type = type; o.frequency.value = freq; o.detune.value = det;
      const og = ac.createGain(); og.gain.value = lvl;
      o.connect(og);
      oscs.push(o);
      return og;
    };

    if (instr === 'synth') {
      filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = clamp(f * 3, 600, 6000); filter.Q.value = 3.5;
      filtEnv = clamp(f * 6, 1500, 9000);
      mk('sawtooth', f, -9, 0.5).connect(filter);
      mk('sawtooth', f, 9, 0.5).connect(filter);
      mk('sawtooth', f, 0, 0.5).connect(filter);
      mk('square', f / 2, 0, 0.2).connect(filter);
      filter.connect(g);
      A = 0.014; D = 0.3; SUS = 0.65; R = 0.26; peak = 0.3;
    } else if (instr === 'epiano') {
      // FM tine: sine carrier + fast-decaying modulator, soft bark on attack
      const carrier = ac.createOscillator();
      carrier.type = 'sine'; carrier.frequency.value = f;
      const mod = ac.createOscillator();
      mod.type = 'sine'; mod.frequency.value = f * 14;
      const modG = ac.createGain();
      modG.gain.setValueAtTime(f * (1.2 + vel * 2.2), t);
      modG.gain.exponentialRampToValueAtTime(f * 0.02, t + 0.35);
      mod.connect(modG); modG.connect(carrier.frequency);
      carrier.connect(g);
      const body = mk('sine', f * 2, 4, 0.12); body.connect(g);
      oscs.push(carrier, mod);
      A = 0.004; D = 1.1; SUS = 0.24; R = 0.35; peak = 0.42;
    } else if (instr === 'strings') {
      // detuned saw ensemble, slow bow-in, mellow top end
      filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = clamp(f * 5, 900, 5200); filter.Q.value = 0.4;
      mk('sawtooth', f, -12, 0.3).connect(filter);
      mk('sawtooth', f, -4, 0.3).connect(filter);
      mk('sawtooth', f, 5, 0.3).connect(filter);
      mk('sawtooth', f, 11, 0.3).connect(filter);
      mk('sawtooth', f * 2, 7, 0.1).connect(filter);
      filter.connect(g);
      A = 0.22; D = 0.4; SUS = 0.85; R = 0.5; peak = 0.3;
    } else if (instr === 'bass') {
      filter = ac.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = 320; filter.Q.value = 4;
      filtEnv = clamp(f * 5, 700, 2600);
      mk('sine', f, 0, 1).connect(filter);
      mk('sawtooth', f, 0, 0.45).connect(filter);
      mk('sine', f / 2, 0, 0.6).connect(filter);
      filter.connect(g);
      A = 0.006; D = 0.22; SUS = 0.72; R = 0.12; peak = 0.5;
    } else if (instr === 'sub') {
      // 808-style sub: a sine whose pitch drops fast into the fundamental, with
      // a short click on top so it still reads on small speakers. This is how an
      // 808 is actually made (synthesised), not a sample pretending to be one.
      const o = ac.createOscillator();
      o.type = 'sine';
      // the pitch drop is what makes an 808 an 808, but the same big drop up high
      // just sounds like a whistle, so ease it off as the note climbs
      const low = clamp((72 - pitch) / 36, 0, 1);          // 1 down low, 0 up high
      const drop = 1.5 + 3 * low;
      o.frequency.setValueAtTime(f * drop, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f), t + 0.03 + 0.045 * low);
      const og = ac.createGain(); og.gain.value = 1;
      o.connect(og); og.connect(g);
      oscs.push(o);
      // Attack transient: a very short filtered noise knock. This used to be a
      // triangle at 8x the fundamental over 30ms, but a tone that long IS a
      // note, so every 808 started with a little chiptune blip. Noise has no
      // pitch, and 7ms reads as a click rather than something you can hum.
      const nz = ac.createBufferSource();
      nz.buffer = this.noise(ac);
      const nf = ac.createBiquadFilter();
      nf.type = 'bandpass';
      nf.frequency.value = 1900; nf.Q.value = 0.8;
      const cg = ac.createGain();
      cg.gain.setValueAtTime(0.5 * vel * (0.4 + 0.6 * low), t);
      cg.gain.exponentialRampToValueAtTime(0.0004, t + 0.007);
      nz.connect(nf); nf.connect(cg); cg.connect(g);
      oscs.push(nz);
      A = 0.004; D = 0.9; SUS = 0.55; R = 0.42; peak = 0.72;
    } else if (instr === 'pad') {
      // wide, slow-blooming saw/triangle stack behind a gentle filter
      filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = clamp(f * 3.2, 500, 3600); filter.Q.value = 0.7;
      filtEnv = clamp(f * 3, 700, 3200);
      mk('sawtooth', f, -14, 0.22).connect(filter);
      mk('sawtooth', f, 14, 0.22).connect(filter);
      mk('triangle', f, 0, 0.3).connect(filter);
      mk('triangle', f * 2, 7, 0.12).connect(filter);
      mk('sine', f / 2, 0, 0.22).connect(filter);
      filter.connect(g);
      A = 0.5; D = 0.8; SUS = 0.9; R = 1.1; peak = 0.26;
    } else if (instr === 'pluck') {
      filter = ac.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = clamp(f * 9, 1400, 9000); filter.Q.value = 2;
      filtEnv = clamp(f * 6, 1200, 7000);
      mk('triangle', f, 0, 1).connect(filter);
      mk('sawtooth', f, 6, 0.3).connect(filter);
      filter.connect(g);
      A = 0.002; D = 0.28; SUS = 0.0001; R = 0.09; peak = 0.5;
    } else { // bell
      const carrier = ac.createOscillator();
      carrier.type = 'sine'; carrier.frequency.value = f;
      const mod = ac.createOscillator();
      mod.type = 'sine'; mod.frequency.value = f * 3.51;
      const modG = ac.createGain();
      modG.gain.setValueAtTime(f * 2.4, t);
      modG.gain.exponentialRampToValueAtTime(f * 0.2, t + 0.9);
      mod.connect(modG); modG.connect(carrier.frequency);
      carrier.connect(g);
      oscs.push(carrier, mod);
      A = 0.003; D = 1.4; SUS = 0.0001; R = 0.4; peak = 0.34;
    }

    const p = peak * vel;
    if (noAttack) {
      // straight to sustain, near-instant so it's just "already there" (no swell)
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(p * SUS, t + 0.004);
      // no filter sweep, since it's mid-note, the filter has already settled
    } else {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(p, t + A);
      g.gain.setTargetAtTime(p * SUS, t + A, Math.max(0.02, D / 3));
      if (filter && filtEnv) {
        const base = filter.frequency.value;
        filter.frequency.setValueAtTime(base + filtEnv * (0.4 + 0.6 * vel), t);
        filter.frequency.exponentialRampToValueAtTime(Math.max(120, base), t + D + 0.05);
      }
    }
    for (const o of oscs) o.start(t);

    return this.wrapVoice(ac, g, oscs, R);
  },

  // A grand-ish piano: inharmonic partials that each decay at their own rate,
  // plus a short hammer click. Brighter the harder you play.
  makePiano(ac, dest, pitch, t, vel = 0.9, noAttack = false) {
    const f = midiToFreq(pitch);
    const g = ac.createGain();
    g.connect(dest);
    const oscs = [];
    const partials = [
      [1, 1.0, 1.0], [2, 0.55, 0.8], [3, 0.32, 0.62],
      [4, 0.19, 0.5], [5, 0.11, 0.4], [6, 0.07, 0.32], [7, 0.04, 0.26]
    ];
    const bodyDecay = clamp(2.6 - (pitch - 48) * 0.02, 0.7, 2.8);
    for (const [n, lvl, decayScale] of partials) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * n * (1 + 0.0007 * n * n); // slight inharmonicity
      const pg = ac.createGain();
      // mid-note: start each partial part-way down its decay so it sounds like
      // the note has been ringing, not freshly struck
      const amp = lvl * (0.4 + 0.6 * vel) * 0.5 * (noAttack ? 0.5 : 1);
      pg.gain.setValueAtTime(0, t);
      pg.gain.linearRampToValueAtTime(amp, t + 0.004);
      pg.gain.exponentialRampToValueAtTime(0.0002, t + bodyDecay * decayScale * (noAttack ? 0.6 : 1));
      o.connect(pg); pg.connect(g);
      o.start(t);
      oscs.push(o);
    }
    if (!noAttack) {
      // hammer thock: the attack transient we skip for a mid-note start
      const noise = ac.createBufferSource();
      noise.buffer = this.noise(ac); noise.loop = true;
      const hp = ac.createBiquadFilter(); hp.type = 'bandpass';
      hp.frequency.value = clamp(f * 2, 300, 4000); hp.Q.value = 0.6;
      const ng = ac.createGain();
      ng.gain.setValueAtTime(0.18 * vel, t);
      ng.gain.exponentialRampToValueAtTime(0.0002, t + 0.05);
      noise.connect(hp); hp.connect(ng); ng.connect(g);
      noise.start(t); noise.stop(t + 0.08);
    }

    g.gain.value = 0.9;
    return this.wrapVoice(ac, g, oscs, 0.35);
  },

  wrapVoice(ac, g, oscs, R) {
    return {
      stop: (when) => {
        const w = Math.max(when, ac.currentTime);
        g.gain.setTargetAtTime(0, w, R / 4);
        for (const o of oscs) { try { o.stop(w + R + 0.2); } catch (e) {} }
      },
      kill: () => {
        try { g.gain.cancelScheduledValues(0); g.gain.value = 0; } catch (e) {}
        for (const o of oscs) { try { o.stop(); } catch (e) {} }
        try { g.disconnect(); } catch (e) {}
      }
    };
  },

  // A custom instrument built from an audio file: resample by root note,
  // with a trimmed region and attack/release envelope.
  makeSamplerVoice(ac, dest, inst, pitch, t, vel = 0.9, noAttack = false) {
    const s = Samples[inst.sampleId];
    const g = ac.createGain();
    g.connect(dest);
    if (!s || !s.buffer) return this.wrapVoice(ac, g, [], 0.05);
    const src = ac.createBufferSource();
    src.buffer = s.buffer;
    src.playbackRate.value = Math.pow(2, (pitch - (inst.root ?? 60)) / 12);
    src.connect(g);
    const A = noAttack ? 0.004 : (inst.attack ?? 0.005);
    const R = inst.release ?? 0.08;
    const start = clamp(inst.start || 0, 0, s.buffer.duration);
    const end = clamp(inst.end != null ? inst.end : s.buffer.duration, start, s.buffer.duration);
    const peak = 0.9 * vel;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + A);
    const naturalEnd = t + (end - start) / src.playbackRate.value;
    src.start(t, start, end - start);
    try { src.stop(naturalEnd + 0.02); } catch (e) {}
    return {
      stop: (when) => {
        const w = Math.max(when, ac.currentTime);
        g.gain.cancelScheduledValues(w);
        g.gain.setTargetAtTime(0, w, Math.max(0.008, R / 4));
        try { src.stop(Math.min(naturalEnd + 0.02, w + R + 0.15)); } catch (e) {}
      },
      kill: () => {
        try { src.stop(); } catch (e) {}
        try { g.disconnect(); } catch (e) {}
      }
    };
  },

  // Drum kit: which sound depends on the note's pitch class
  // C = kick, D = snare, E = clap, F/F# = closed hat, A/A# = open hat
  // ----- synthesized one-shot sound effects (risers, hits, zaps…) -----
  // Each plays its FULL effect regardless of note length (stop is a no-op), so
  // dropping one anywhere just fires it.
  _sfxHandle(sources, node) {
    return {
      stop: () => {}, // one-shots play out on their own
      kill: () => { for (const s of sources) { try { s.stop(); } catch (e) {} } try { node.disconnect(); } catch (e) {} }
    };
  },
  SFX: {
    sfx_downer(ac, dest, pitch, t, vel) { // downlifter
      const dur = 1.2;
      const n = ac.createBufferSource(); n.buffer = Engine.noise(ac); n.loop = true;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3;
      lp.frequency.setValueAtTime(8000, t); lp.frequency.exponentialRampToValueAtTime(200, t + dur);
      const g = ac.createGain(); g.gain.setValueAtTime(0.4 * vel, t); g.gain.linearRampToValueAtTime(0.02, t + dur);
      n.connect(lp); lp.connect(g); g.connect(dest); n.start(t); n.stop(t + dur + 0.05);
      return Engine._sfxHandle([n], g);
    }
  },

  makeDrum(ac, dest, pitch, t, vel = 1) {
    const pc = pitch % 12;
    const out = ac.createGain();
    out.gain.value = vel;
    out.connect(dest);
    const ends = [];

    const noiseSrc = (dur) => {
      const src = ac.createBufferSource();
      src.buffer = this.noise(ac);
      src.loop = true;
      src.start(t);
      src.stop(t + dur + 0.05);
      ends.push(src);
      return src;
    };

    if (pc === 0) { // KICK: punchy sine drop + click
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(165, t);
      o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
      const g = ac.createGain();
      g.gain.setValueAtTime(1.15, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + 0.45); ends.push(o);
      const click = noiseSrc(0.02);
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4000;
      const cg = ac.createGain();
      cg.gain.setValueAtTime(0.35, t);
      cg.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
      click.connect(hp); hp.connect(cg); cg.connect(out);
    } else if (pc === 2) { // SNARE
      const n = noiseSrc(0.22);
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.7;
      const ng = ac.createGain();
      ng.gain.setValueAtTime(0.7, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      n.connect(bp); bp.connect(ng); ng.connect(out);
      const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = 190;
      const og = ac.createGain();
      og.gain.setValueAtTime(0.5, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      o.connect(og); og.connect(out);
      o.start(t); o.stop(t + 0.15); ends.push(o);
    } else if (pc === 4) { // CLAP: three quick noise bursts
      for (let i = 0; i < 3; i++) {
        const tt = t + i * 0.018;
        const n = ac.createBufferSource();
        n.buffer = this.noise(ac); n.loop = true;
        n.start(tt); n.stop(tt + 0.15); ends.push(n);
        const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1150; bp.Q.value = 1.6;
        const g = ac.createGain();
        g.gain.setValueAtTime(i === 2 ? 0.6 : 0.3, tt);
        g.gain.exponentialRampToValueAtTime(0.001, tt + (i === 2 ? 0.14 : 0.03));
        n.connect(bp); bp.connect(g); g.connect(out);
      }
    } else if (pc === 9 || pc === 10) { // OPEN HAT
      const n = noiseSrc(0.45);
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6800;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.32, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
      n.connect(hp); hp.connect(g); g.connect(out);
    } else { // CLOSED HAT (everything else)
      const n = noiseSrc(0.07);
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7600;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.3, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      n.connect(hp); hp.connect(g); g.connect(out);
    }

    return {
      stop: () => {},
      kill: () => {
        for (const s of ends) { try { s.stop(); } catch (e) {} }
        try { out.disconnect(); } catch (e) {}
      }
    };
  },

  // ----- metronome click -----

  METRO_SOUNDS: ['classic', 'tick', 'wood', 'beep'],
  metroSound() { try { return localStorage.getItem('fabu.metroSound') || 'classic'; } catch (e) { return 'classic'; } },
  setMetroSound(s) { try { localStorage.setItem('fabu.metroSound', s); } catch (e) {} },

  click(ac, dest, t, accent) {
    const kind = this.metroSound();
    if (kind === 'tick' || kind === 'wood') {
      // a real metronome tick: a tiny filtered noise knock
      const n = ac.createBufferSource();
      n.buffer = this.noise(ac); n.loop = true;
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = kind === 'wood' ? 6 : 9;
      bp.frequency.value = kind === 'wood' ? (accent ? 1200 : 850) : (accent ? 3400 : 2300);
      const g = ac.createGain();
      g.gain.setValueAtTime(accent ? 0.9 : 0.55, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'wood' ? 0.07 : 0.045));
      n.connect(bp); bp.connect(g); g.connect(dest);
      n.start(t); n.stop(t + 0.09);
      return;
    }
    const o = ac.createOscillator();
    o.type = kind === 'beep' ? 'sine' : 'square';
    o.frequency.value = kind === 'beep' ? (accent ? 1320 : 880) : (accent ? 1568 : 1047);
    const g = ac.createGain();
    g.gain.setValueAtTime(kind === 'beep' ? (accent ? 0.3 : 0.2) : (accent ? 0.25 : 0.16), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + 0.08);
  },

  previewClick(kind) {
    this.ensureCtx(); this.ctx.resume();
    const prev = this.metroSound();
    this.setMetroSound(kind);
    this.click(this.ctx, this.metroGain, this.ctx.currentTime + 0.01, true);
    this.click(this.ctx, this.metroGain, this.ctx.currentTime + 0.22, false);
    this.setMetroSound(prev);
  },

  // ----- audio clip playback with fades + pitch -----

  // distortion / bitcrush curves for the WaveShaper effect
  distortionCurve(amount) {
    const k = Math.max(0, amount) * 4;
    const n = 8192, curve = new Float32Array(n), deg = Math.PI / 180;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  },
  crushCurve(amount) {
    const steps = Math.max(2, Math.round(64 - (amount / 100) * 62));
    const n = 4096, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    return curve;
  },

  // which dropped-effect params can be automated over time (waveshaper
  // amounts can't be ramped, so drive/crush amount stay static)
  FX_AUTOM: {
    reverb: ['amt'], echo: ['time', 'fb', 'mix'], dampen: ['freq'],
    lowcut: ['freq'], tremolo: ['rate', 'depth'], wobble: ['rate', 'amt'], widen: ['amt']
  },
  fxAutomatable(type, key) { return (this.FX_AUTOM[type] || []).includes(key); },

  // Set an effect-node AudioParam either to a static value or, when the effect
  // has keyframes for this param and we're playing/exporting, as scheduled ramps
  // over the song timeline. `transform` maps the user value to the node's units.
  bindFx(param, fx, key, def, transform, automCtx) {
    transform = transform || ((x) => x);
    const pts = fx.autom && fx.autom[key];
    if (automCtx && pts && pts.length) {
      try { param.cancelScheduledValues(automCtx.time0); } catch (e) {}
      param.setValueAtTime(transform(interpPoints(pts, automCtx.curBeat)), automCtx.time0);
      for (const pt of pts) {
        if (pt.beat <= automCtx.curBeat) continue;
        try { param.linearRampToValueAtTime(transform(pt.v), automCtx.beatToTime(pt.beat)); } catch (e) {}
      }
    } else {
      param.value = transform(fx.p && fx.p[key] != null ? fx.p[key] : def);
    }
  },

  // ramp an audio-source AudioParam (playbackRate / detune) from a clip's own
  // keyframes, or set it static when there are none
  bindClipParam(param, autom, key, staticVal, transform, automCtx) {
    transform = transform || ((x) => x);
    const pts = autom && autom[key];
    if (automCtx && pts && pts.length) {
      try { param.cancelScheduledValues(automCtx.time0); } catch (e) {}
      param.setValueAtTime(transform(interpPoints(pts, automCtx.curBeat)), automCtx.time0);
      for (const pt of pts) {
        if (pt.beat <= automCtx.curBeat) continue;
        try { param.linearRampToValueAtTime(transform(pt.v), automCtx.beatToTime(pt.beat)); } catch (e) {}
      }
    } else {
      param.value = staticVal;
    }
  },

  // build a live automation context for a clip fx chain starting now
  liveFxCtx() {
    if (!UI.playing || !this.ctx) return null;
    return { curBeat: this.currentBeat(), time0: this.ctx.currentTime, beatToTime: (b) => this.beatToTime(b) };
  },

  // A per-clip effect chain: the built-in drive, crush and filter sliders plus
  // any dropped effects from clip.fx (reverb send, dampen, echo, …). Every note
  // or audio source of the clip routes through it. Returns `dest` unchanged
  // when the clip has nothing to apply. `automCtx` (optional) schedules any
  // per-effect keyframes as ramps instead of static values.
  clipFxDest(ac, dest, clip, revIn, automCtx) {
    const list = clip.fx || [];
    const hasFx = clip.drive > 0 || clip.crush > 0 || (clip.cutoff > 0 && clip.cutoff < 20000) || list.length;
    if (!hasFx) return dest;
    const input = ac.createGain();
    let node = input;
    if (clip.drive > 0) {
      const ws = ac.createWaveShaper();
      ws.curve = this.distortionCurve(clip.drive); ws.oversample = '2x';
      node.connect(ws); node = ws;
    }
    if (clip.crush > 0) {
      const cr = ac.createWaveShaper();
      cr.curve = this.crushCurve(clip.crush);
      node.connect(cr); node = cr;
    }
    if (clip.cutoff > 0 && clip.cutoff < 20000) {
      const filt = ac.createBiquadFilter();
      filt.type = 'lowpass'; filt.frequency.value = clip.cutoff; filt.Q.value = 1;
      node.connect(filt); node = filt;
    }
    for (const fx of list) {
      const p = fx.p || {};
      if (fx.type === 'drive') {
        const ws = ac.createWaveShaper();
        ws.curve = this.distortionCurve(p.amt ?? 40); ws.oversample = '2x';
        node.connect(ws); node = ws;
      } else if (fx.type === 'crush') {
        const cr = ac.createWaveShaper();
        cr.curve = this.crushCurve(p.amt ?? 50);
        node.connect(cr); node = cr;
      } else if (fx.type === 'dampen') {
        const f = ac.createBiquadFilter();
        f.type = 'lowpass'; f.Q.value = 0.9; this.bindFx(f.frequency, fx, 'freq', 2500, null, automCtx);
        node.connect(f); node = f;
      } else if (fx.type === 'echo') {
        const sum = ac.createGain();
        const dl = ac.createDelay(2); this.bindFx(dl.delayTime, fx, 'time', 0.3, null, automCtx);
        const fb = ac.createGain(); this.bindFx(fb.gain, fx, 'fb', 0.35, (v) => clamp(v, 0, 0.92), automCtx);
        const wet = ac.createGain(); this.bindFx(wet.gain, fx, 'mix', 0.35, null, automCtx);
        node.connect(sum);
        node.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(wet); wet.connect(sum);
        node = sum;
      } else if (fx.type === 'reverb' && revIn) {
        const send = ac.createGain(); this.bindFx(send.gain, fx, 'amt', 0.35, null, automCtx);
        node.connect(send); send.connect(revIn);
      } else if (fx.type === 'lowcut') {
        const f = ac.createBiquadFilter();
        f.type = 'highpass'; f.Q.value = 0.7; this.bindFx(f.frequency, fx, 'freq', 200, null, automCtx);
        node.connect(f); node = f;
      } else if (fx.type === 'tremolo') {
        const g2 = ac.createGain();
        // depth splits into the carrier level (1 - depth/2) and the LFO swing (depth/2)
        this.bindFx(g2.gain, fx, 'depth', 0.6, (d) => 1 - clamp(d, 0, 1) / 2, automCtx);
        const lfo = ac.createOscillator(); lfo.type = 'sine'; this.bindFx(lfo.frequency, fx, 'rate', 5, null, automCtx);
        const lg = ac.createGain(); this.bindFx(lg.gain, fx, 'depth', 0.6, (d) => clamp(d, 0, 1) / 2, automCtx);
        lfo.connect(lg); lg.connect(g2.gain); lfo.start();
        node.connect(g2); node = g2;
      } else if (fx.type === 'wobble') {
        const f = ac.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 800; f.Q.value = 6;
        const lfo = ac.createOscillator(); lfo.type = 'sine'; this.bindFx(lfo.frequency, fx, 'rate', 3, null, automCtx);
        const lg = ac.createGain(); this.bindFx(lg.gain, fx, 'amt', 0.7, (a) => a * 1800, automCtx);
        lfo.connect(lg); lg.connect(f.frequency); lfo.start();
        node.connect(f); node = f;
      } else if (fx.type === 'widen') {
        // Haas widening: delay one side a few ms
        const splitL = ac.createGain(), splitR = ac.createDelay(0.05);
        this.bindFx(splitR.delayTime, fx, 'amt', 0.6, (a) => 0.004 + a * 0.02, automCtx);
        const merger = ac.createChannelMerger(2);
        node.connect(splitL); node.connect(splitR);
        splitL.connect(merger, 0, 0); splitR.connect(merger, 0, 1);
        node = merger;
      }
    }
    node.connect(dest);
    return input;
  },

  scheduleAudioClip(ac, dest, clip, when, outOff, register = true, revIn = undefined) {
    const s = Samples[clip.sampleId];
    if (!s || !s.buffer) return;
    const speed = clip.speed || 1;
    const trimOff = clipOffSec(clip);
    const rateAuto = clipRateAutom(clip);
    // with rate automation the real output length is the integral of the curve,
    // so the sound ends exactly where the block on the timeline ends
    const durOut = rateAuto ? clipAutoInfo(clip).durSec : clipDurSec(clip) / speed;
    if (outOff >= durOut) return;

    if (revIn === undefined) revIn = (ac === this.ctx && this.rev) ? this.rev.pre : null;
    const automCtx = (ac === this.ctx && UI.playing)
      ? { curBeat: this.startBeat + (when - this.startCtxTime) / this.spb(), time0: Math.max(when, ac.currentTime), beatToTime: (b) => this.beatToTime(b) }
      : (this._offlineFx ? this._offlineFx : null);
    const pitchAuto = automCtx && clip.autom && clip.autom.pitch && clip.autom.pitch.length;
    const speedAuto = automCtx && clip.autom && clip.autom.speed && clip.autom.speed.length;

    const src = ac.createBufferSource();
    // automated pitch rides on the raw buffer via detune (tape-style); otherwise
    // a clean length-preserving shift for the static pitch
    src.buffer = pitchAuto ? s.buffer : this.shiftedBuffer(s, clip.pitch || 0);
    if (pitchAuto) this.bindClipParam(src.detune, clip.autom, 'pitch', (clip.pitch || 0) * 100, (st) => st * 100, automCtx);
    if (speedAuto) this.bindClipParam(src.playbackRate, clip.autom, 'speed', speed, null, automCtx);
    else src.playbackRate.value = speed;
    const g = ac.createGain();

    // effects (built-in sliders + dropped fx) live in the shared per-clip chain
    const fxDest = this.clipFxDest(ac, dest, clip, revIn, automCtx);
    src.connect(g); g.connect(fxDest);

    const lvl = clip.gain ?? 1;
    let fi = Math.min(clip.fadeIn || 0, durOut);
    let fo = Math.min(clip.fadeOut || 0, durOut - fi);
    const envAt = (x) => {
      if (fi > 0 && x < fi) return lvl * (x / fi);
      if (fo > 0 && x > durOut - fo) return lvl * ((durOut - x) / fo);
      return lvl;
    };
    const T = when - outOff; // virtual absolute time of clip start
    g.gain.setValueAtTime(envAt(outOff), when);
    const points = [fi, durOut - fo, durOut].filter(x => x > outOff + 1e-4);
    for (const x of [...new Set(points)].sort((a, b) => a - b)) {
      g.gain.linearRampToValueAtTime(envAt(x), T + x);
    }

    // seeking into a rate-automated clip: the source position is the integral
    // of the rate curve up to the seek point, not a straight multiply
    src.start(when, trimOff + (rateAuto ? clipAutoInfo(clip).sourceAt(outOff) : outOff * speed));
    src.stop(T + durOut + (rateAuto ? 0.1 : 0.03));   // durOut is exact now, small pad only

    if (register) {
      const h = {
        kill: () => {
          try { src.stop(); } catch (e) {}
          try { g.disconnect(); } catch (e) {}
        }
      };
      src.onended = () => this.live.delete(h);
      this.registerVoice(h);
    }
  },

  // ----- transport -----

  beatToTime(beat) { return this.startCtxTime + (beat - this.startBeat) * this.spb(); },
  // Swing: delay notes that sit on an offbeat 8th by a fraction of an 8th note.
  // Per-track (sw = track.swing). Only shifts note onsets, never the grid.
  swingBeat(beat, sw) {
    if (!sw || sw <= 0) return beat;
    const eighth = beat * 2;                 // position measured in 8th notes
    const idx = Math.round(eighth);
    if (Math.abs(eighth - idx) < 0.02 && idx % 2 === 1) return beat + sw * 0.5;
    return beat;
  },
  currentBeat() {
    if (!UI.playing) return UI.playhead;
    return this.startBeat + (this.ctx.currentTime - this.startCtxTime) / this.spb();
  },

  // schedule one clip (midi or audio) playing on `t`'s chain into `ev`.
  // futureOnly = don't re-trigger notes/clips already in progress at fromBeat
  // (used for live edits: leave sounding voices exactly as they are)
  collectClipEvents(ev, c, t, fromBeat, futureOnly) {
    if (c.kind === 'midi') {
      let clipDest = null; // one shared per-clip fx chain, built at play time
      const getDest = () => {
        if (!clipDest) {
          clipDest = this.clipFxDest(this.ctx, this.trackInput(t.id), c, this.rev && this.rev.pre, this.liveFxCtx());
          if (clipDest !== this.trackInput(t.id)) this.live.add({ kill: () => { try { clipDest.disconnect(); } catch (e) {} } });
        }
        return clipDest;
      };
      const sp = c.speed || 1;   // pattern speed: squash/stretch note timing
      for (const n of c.notes) {
        if (n.start >= c.length) continue;
        const b = this.swingBeat(c.start + (n.start / sp), t.swing);
        // Sustain pedal: a note that ends while the pedal is down keeps ringing
        // until the pedal comes up, exactly like a real one. Applied here in the
        // scheduler so playback, export and bouncing all agree by construction.
        const rawDur = sustainedLength(c, n.start, Math.min(n.length, c.length - n.start));
        const durB = rawDur / sp;
        const endB = b + durB;
        if (endB <= fromBeat + 1e-6) continue; // already finished
        const startBeat = Math.max(b, fromBeat);
        const remain = endB - startBeat;
        const midNote = startBeat > b + 1e-6; // seeked INTO this note
        if (futureOnly && midNote) continue;  // don't re-trigger an already-sounding note
        ev.push({
          beat: startBeat,
          fn: (time) => {
            const tv = automValueAt(t, 'transpose', b);          // transpose automation, stepped per note
            const semis = tv == null ? 0 : Math.round(tv);
            const v = this.makeVoice(this.ctx, getDest(), t.instrument, n.pitch + (c.pitch || 0) + semis + (c.detune || 0) / 100, time, (n.vel ?? 0.9) * (c.gain ?? 1), midNote);
            const end = time + remain * this.spb();
            v.stop(end);
            this.registerVoice(v, end);
            // remember it so a live change to this clip's settings can reach a
            // note that's still ringing (see applyLiveClipEdits)
            if (n.id && c.id && this.sounding) {
              const key = t.id + ':' + c.id + ':' + n.id;
              this.sounding.set(key, { v, trackId: t.id, clipId: c.id, noteId: n.id, endTime: end, sig: this.noteSig(t, c, n) });
            }
          }
        });
      }
    } else {
      const lenB = clipBeats(c);
      if (c.start + lenB <= fromBeat + 1e-6) return;
      if (c.start >= fromBeat - 1e-6) {
        ev.push({ beat: c.start, fn: (time) => this.scheduleAudioClip(this.ctx, this.trackInput(t.id), c, time, 0) });
      } else if (!futureOnly) {
        const outOff = (fromBeat - c.start) * this.spb();
        ev.push({ beat: fromBeat, fn: (time) => this.scheduleAudioClip(this.ctx, this.trackInput(t.id), c, time, outOff) });
      }
    }
  },

  collectEvents(fromBeat, futureOnly) {
    const ev = [];
    for (const t of S.tracks) {
      for (const c of t.clips) {
        if (c.kind === 'group') {
          // play each child at its absolute position through its original track,
          // so a grouped drum pattern still sounds like drums, etc.
          for (const child of c.children) {
            const ot = getTrack(child.origTrackId) || t;
            const abs = Object.assign({}, child.clip, { start: c.start + (child.clip.start || 0) });
            this.collectClipEvents(ev, abs, ot, fromBeat, futureOnly);
          }
        } else {
          this.collectClipEvents(ev, c, t, fromBeat, futureOnly);
        }
      }
    }
    ev.sort((a, b) => a.beat - b.beat);
    return ev;
  },

  play(atTime) {
    this.ensureCtx();
    this.ctx.resume();
    if (UI.playing) return;
    this.scrubEnd(); // release any notes held from a scrub drag
    UI.playing = true;
    this.sounding = new Map();
    this.startBeat = UI.playhead;
    if (typeof App !== 'undefined' && App.noteReplay) App.noteReplay(UI.playhead);
    this.startCtxTime = (atTime && atTime > this.ctx.currentTime + 0.005) ? atTime : this.ctx.currentTime + 0.08;
    this.events = this.collectEvents(this.startBeat);
    this.evIdx = 0;
    this.nextClickBeat = Math.ceil(this.startBeat - 1e-6);
    this.scheduleAllAutomation(this.startBeat, this.startCtxTime);
    this.scheduleAllSidechain(this.startBeat, this.startCtxTime);
    this.schedTimer = setInterval(() => this.schedTick(), 25);
    this.schedTick();
    App.onTransport();
  },

  // jump the transport to a beat without stopping (used by the loop region)
  jumpTo(beat) {
    if (!UI.playing || !this.ctx) return;
    for (const v of this.live) v.kill();
    this.live.clear();
    if (this.sounding) this.sounding.clear();
    this.startBeat = Math.max(0, beat);
    this.startCtxTime = this.ctx.currentTime + 0.02;
    this.events = this.collectEvents(this.startBeat);
    this.evIdx = 0;
    this.nextClickBeat = Math.ceil(this.startBeat - 1e-6);
    this.scheduleAllAutomation(this.startBeat, this.startCtxTime);
    this.scheduleAllSidechain(this.startBeat, this.startCtxTime);
  },

  schedTick() {
    if (!UI.playing) return;
    // loop region: wrap back round while you work on a section
    if (S.loopOn && S.loopEnd > S.loopStart && this.currentBeat() >= S.loopEnd) {
      this.jumpTo(S.loopStart);
      return;
    }
    // The music has run out but the transport keeps rolling into silence: the
    // player probably wants it to come round again and does not know about L.
    // Said once per session, and only when there was a real song to run out of.
    if (!S.loopOn && !this._loopHinted && songEndBeat() > 16 && this.currentBeat() > songEndBeat() + 1) {
      this._loopHinted = true;
      toast(tr('hint_loop_key', 'Press L to turn looping on and off'));
    }
    // drop finished notes from the sounding map so it stays small
    if (this.sounding && this.sounding.size) {
      const t = this.ctx.currentTime;
      for (const [k, r] of this.sounding) if (t >= r.endTime) this.sounding.delete(k);
    }
    const horizon = this.ctx.currentTime + 0.15;
    const horizonBeat = this.startBeat + (horizon - this.startCtxTime) / this.spb();
    // guards: a single 25ms tick can never legitimately fire thousands of events
    // or clicks. If a stale scheduler state made horizonBeat balloon, cap and
    // resync instead of spinning the whole app to a freeze.
    let evGuard = 0;
    while (this.evIdx < this.events.length && this.events[this.evIdx].beat < horizonBeat && evGuard++ < 4096) {
      const e = this.events[this.evIdx++];
      e.fn(Math.max(this.beatToTime(e.beat), this.ctx.currentTime + 0.005));
    }
    if (S.metronome) {
      let clkGuard = 0;
      while (this.nextClickBeat < horizonBeat && clkGuard++ < 512) {
        const t = this.beatToTime(this.nextClickBeat);
        if (t >= this.ctx.currentTime) {
          this.click(this.ctx, this.metroGain, t, this.nextClickBeat % beatsPerBar() === 0);
        }
        this.nextClickBeat++;
      }
      if (this.nextClickBeat < horizonBeat) this.nextClickBeat = Math.ceil(horizonBeat); // resync, don't spin
    }
  },

  pause() {
    if (!UI.playing) return;
    UI.playhead = Math.max(0, this.currentBeat());
    this.haltPlayback();
    App.onTransport();
  },

  stop() {
    UI.playhead = 0;
    this.haltPlayback();
    App.onTransport();
  },

  haltPlayback() {
    if (this.midiRec) this.finishMidiRecord(); // stopping playback ends the take
    UI.playing = false;
    clearInterval(this.schedTimer);
    this.schedTimer = null;
    for (const v of this.live) v.kill();
    this.live.clear();
    this.clearScheduledParams(); // drop automation ramps, restore static values
  },

  seek(beat) {
    const wasPlaying = UI.playing;
    // trying to move outside a live loop: the loop will pull you straight back,
    // which looks broken unless we say what is happening
    if (S.loopOn && S.loopEnd > S.loopStart && (beat < S.loopStart - 1e-6 || beat >= S.loopEnd)
        && typeof App !== 'undefined' && App.hintLoop) App.hintLoop('escape');
    if (wasPlaying) this.haltPlayback();
    UI.playhead = Math.max(0, beat);
    if (wasPlaying) this.play();
    else App.onTransport();
  },

  // Scrubbing: while dragging the playhead (stopped), HOLD whatever melodic
  // notes sit under it, like pressing keys. A note sounds the moment the
  // playhead reaches it and releases the moment it leaves, so dragging over a
  // chord sustains that chord and moving reveals the next one. No re-triggered
  // bursts stacking up, no machine-gun attacks. Drums and audio clips are
  // skipped (re-triggering them just sounds like noise).
  _scrubDrum(instr) { return instr === 'drums' || instr === 'drumkit'; },
  scrub(beat) {
    this.ensureCtx();
    this.ctx.resume();
    const at = this.ctx.currentTime;
    const active = this.scrubActive || (this.scrubActive = new Map());
    const fxCache = this._scrubFx || (this._scrubFx = new Map());
    const wanted = new Set();
    const anySolo = S.tracks.some(t => t.solo);
    // route each held note through its clip's effect chain (built once per clip
    // for the drag, cached; null = clip has no fx, so use the bare track input)
    const destFor = (trackId, clip) => {
      const ti = this.trackInput(trackId);
      if (fxCache.has(clip.id)) return fxCache.get(clip.id) || ti;
      const d = this.clipFxDest(this.ctx, ti, clip, this.rev ? this.rev.pre : null);
      fxCache.set(clip.id, d === ti ? null : d);
      return d;
    };
    const hold = (instr, trackId, clip, pitch, vel, key) => {
      wanted.add(key);
      if (!active.has(key)) {
        active.set(key, this.makeVoice(this.ctx, destFor(trackId, clip), instr, pitch, at, vel, true));
      }
    };
    for (const t of S.tracks) {
      if (t.mute || (anySolo && !t.solo)) continue;
      for (const c of t.clips) {
        if (c.kind === 'midi') {
          if (this._scrubDrum(t.instrument)) continue;
          for (const n of c.notes) {
            const nb = c.start + n.start;
            if (beat >= nb && beat < nb + Math.max(0.05, n.length))
              hold(t.instrument, t.id, c, n.pitch + (c.pitch || 0), (n.vel ?? 0.9) * (c.gain ?? 1), t.id + ':' + c.id + ':' + n.id);
          }
        } else if (c.kind === 'group') {
          for (const child of c.children) {
            if (!child.clip || child.clip.kind !== 'midi') continue;
            const ot = getTrack(child.origTrackId) || t;
            if (this._scrubDrum(ot.instrument)) continue;
            for (const n of child.clip.notes) {
              const nb = c.start + child.clip.start + n.start;
              if (beat >= nb && beat < nb + Math.max(0.05, n.length))
                hold(ot.instrument, t.id, child.clip, n.pitch + (child.clip.pitch || 0), (n.vel ?? 0.9) * (child.clip.gain ?? 1), c.id + ':' + child.clip.id + ':' + n.id);
            }
          }
        }
      }
    }
    // release notes the playhead has moved off of
    for (const [key, v] of active) {
      if (!wanted.has(key)) { try { v.stop(at + 0.02); } catch (e) {} active.delete(key); }
    }
  },
  // drag finished (or interrupted): let every held scrub note ring out, then
  // tear down the per-clip effect chains built for this drag
  scrubEnd() {
    if (!this.scrubActive) return;
    const at = this.ctx ? this.ctx.currentTime : 0;
    for (const v of this.scrubActive.values()) { try { v.stop(at + 0.03); } catch (e) {} }
    this.scrubActive.clear();
    const fx = this._scrubFx; this._scrubFx = null;
    if (fx && fx.size) setTimeout(() => {
      for (const d of fx.values()) { if (d) { try { d.disconnect(); } catch (e) {} } }
    }, 500);
  },

  // Apply edits mid-playback WITHOUT disturbing what's already sounding. We keep
  // the timeline anchor and every live voice, and only replace the not-yet-
  // scheduled future events with a freshly collected (edited) set. So changing a
  // track's instrument, adding/moving/deleting future notes, etc. take hold for
  // everything ahead of the playhead, while notes in progress just play out
  // naturally: no stutter, no re-triggering, no "simulated" re-attack.
  reschedule() {
    if (!UI.playing || !this.ctx) return;
    // start just past the current scheduling horizon so we neither double a note
    // that's already been scheduled nor re-trigger one that's already sounding
    const fromBeat = this.startBeat + ((this.ctx.currentTime + 0.16) - this.startCtxTime) / this.spb();
    this.events = this.collectEvents(fromBeat, true); // futureOnly
    this.evIdx = 0;
  },

  // signature of a note's *sound*: pitch, level, instrument and the clip's
  // effects. If this changes, a note still ringing needs re-voicing to hear it.
  noteSig(t, c, n) {
    const fx = c.fx ? c.fx.map(f => f.type + JSON.stringify(f.p || {}) + JSON.stringify(f.autom || {})).join('|') : '';
    return [t.instrument, n.pitch + (c.pitch || 0) + (c.detune || 0) / 100, (n.vel ?? 0.9) * (c.gain ?? 1),
      c.drive || 0, c.crush || 0, c.cutoff || 0, fx].join(',');
  },

  // A long note is already sounding and you change its clip's gain / transpose /
  // drive / crush / filter and effects, re-voice just that note (seamless 4ms
  // crossfade) so the change is actually heard, not only on the next note.
  applyLiveClipEdits() {
    if (!UI.playing || !this.ctx || !this.sounding || !this.sounding.size) return;
    const now = this.ctx.currentTime;
    for (const [key, rec] of this.sounding) {
      if (now >= rec.endTime - 0.03) { this.sounding.delete(key); continue; }
      const t = getTrack(rec.trackId);
      const c = t && t.clips.find(x => x.id === rec.clipId); // top-level clips only
      const n = c && c.notes && c.notes.find(x => x.id === rec.noteId);
      if (!t || !c || !n) {                      // note/clip deleted -> stop it now
        try { rec.v.stop(now + 0.02); } catch (e) {}
        this.sounding.delete(key);
        continue;
      }
      const sig = this.noteSig(t, c, n);
      if (sig === rec.sig) continue;              // nothing that affects the sound changed
      const sp = c.speed || 1;
      const endBeat = this.swingBeat(c.start + (n.start / sp), t.swing) + Math.min(n.length, c.length - n.start) / sp;
      const endTime = this.beatToTime(endBeat);
      if (endTime <= now + 0.05) { this.sounding.delete(key); continue; }
      try { rec.v.stop(now + 0.02); } catch (e) {}
      const dest = this.clipFxDest(this.ctx, this.trackInput(t.id), c, this.rev && this.rev.pre, this.liveFxCtx());
      if (dest !== this.trackInput(t.id)) this.live.add({ kill: () => { try { dest.disconnect(); } catch (e) {} } });
      const v = this.makeVoice(this.ctx, dest, t.instrument, n.pitch + (c.pitch || 0) + (c.detune || 0) / 100, now, (n.vel ?? 0.9) * (c.gain ?? 1), true);
      v.stop(endTime);
      this.registerVoice(v, endTime);
      rec.v = v; rec.sig = sig; rec.endTime = endTime;
    }
  },

  // Any edit while the song plays (add/delete a clip or note, drop an effect,
  // move something) reschedules from the current beat, debounced so a flurry
  // of edits coalesces. This is what makes deletes stop sounding and effects
  // take hold live, for you AND remote collaborators.
  liveEdit() {
    if (!UI.playing) return;
    clearTimeout(this._reTimer);
    this._reTimer = setTimeout(() => { if (UI.playing) { this.reschedule(); this.applyLiveClipEdits(); } }, 150);
  },

  // ----- live keyboard playing -----

  noteOn(trackId, pitch, vel = 0.9) {
    this.ensureCtx();
    this.ctx.resume();
    const key = trackId + ':' + pitch;
    if (this.liveKeys.has(key)) return;
    const t = getTrack(trackId);
    if (!t || t.kind !== 'midi') return;
    const v = this.makeVoice(this.ctx, this.trackInput(trackId), t.instrument, pitch, this.ctx.currentTime, vel);
    this.liveKeys.set(key, v);
    // capture into the running note recording
    if (this.midiRec && UI.playing && trackId === this.midiRec.trackId) {
      const h = { pitch, beat: this.currentBeat(), vel };
      this.midiRec.held.set(key, h);
      // Put the note down straight away and let it lengthen under your fingers,
      // rather than having it appear out of nowhere when you let go.
      this.startLiveNote(key, h);
    }
  },

  noteOff(trackId, pitch) {
    const key = trackId + ':' + pitch;
    // Pedal down: let go of the key but not of the note, like a real piano.
    // The recorder is told the key was released at the right moment either way,
    // so what gets written down is the notes you played plus a pedal span.
    if (this.pedalDown) {
      if (this.liveKeys.has(key)) this.pedalHeld.add(key);
      if (this.midiRec) {
        const h = this.midiRec.held.get(key);
        if (h) { this.midiRec.held.delete(key); this.commitRecNote(h, this.currentBeat(), key); }
      }
      return;
    }
    this.releaseKey(key);
    if (this.midiRec) {
      const h = this.midiRec.held.get(key);
      if (h) {
        this.midiRec.held.delete(key);
        this.commitRecNote(h, this.currentBeat(), key);
      }
    }
  },

  releaseKey(key) {
    const v = this.liveKeys.get(key);
    if (v) {
      // the pedal can be pressed and let go before a note has ever sounded,
      // and there is no audio context until then
      v.stop(this.ctx ? this.ctx.currentTime : 0);
      this.liveKeys.delete(key);
    }
    this.pedalHeld.delete(key);
  },

  // ----- sustain pedal -----
  // One flag the whole app agrees on, whatever pushed it: the keyboard, a real
  // pedal on a MIDI keyboard, or the on-screen button.
  setPedal(down) {
    down = !!down;
    if (down === this.pedalDown) return;
    this.pedalDown = down;
    if (!down) {
      // pedal up: everything it was holding is released now
      for (const key of [...this.pedalHeld]) this.releaseKey(key);
      this.pedalHeld.clear();
    }
    // write it into the take being recorded, so it plays back as you played it
    if (this.midiRec && UI.playing) this.recordPedal(down);
    if (typeof KeysPanel !== 'undefined' && KeysPanel.showPedal) KeysPanel.showPedal(down);
  },

  recordPedal(down) {
    const rec = this.midiRec;
    if (!rec) return;
    if (!rec.clip) { (rec.pendingPedal = rec.pendingPedal || []).push({ at: this.currentBeat(), on: down }); return; }
    this.writePedal(rec.clip, this.currentBeat(), down);
  },

  writePedal(clip, absBeat, down) {
    const beat = absBeat - clip.start;
    if (beat < 0) return;
    if (!clip.sustain) clip.sustain = [];
    const last = clip.sustain[clip.sustain.length - 1];
    if (last && !!last.on === !!down) return;      // no repeats of the same state
    clip.sustain.push({ beat, on: !!down });
    clip.sustain.sort((x, y) => x.beat - y.beat);
  },

  // ----- record played notes into a pattern clip -----

  toggleMidiRecord() {
    if (this.midiRec) { this.finishMidiRecord(); return; }
    this.ensureCtx();
    this.ctx.resume();
    const track = KeysPanel.targetTrack();
    if (!track) { toast(tr('toast_add_instr_first', 'Add an instrument track first'), 'red'); return; }
    const startBeat = snapBeat(UI.playhead, S.snap);
    const into = track.clips.find(c => c.kind === 'midi'
      && startBeat >= c.start - 1e-6 && startBeat < c.start + clipBeats(c) - 1e-6);
    if (into) Undo.push('Record notes');
    this.midiRec = { trackId: track.id, clip: into || null, intoExisting: !!into,
                     startBeat, held: new Map(), live: new Map(), pendingPedal: null };
    // Holding the pedal down already is a real state, but setPedal only fires
    // on a change, so nothing would ever have written it.
    if (this.pedalDown) this.recordPedal(true);
    KeysPanel.syncRecButton();
    const begin = (at) => {
      if (!this.midiRec) return; // cancelled during count-in
      UI.playhead = startBeat;
      if (!UI.playing) this.play(at);
      toast(tr('toast_recording_notes', 'Recording notes'), 'red');
    };
    if (!UI.playing && S.countIn) this.countIn(() => !!this.midiRec).then(begin);
    else begin();
  },

  // the clip a take is being recorded into, made on demand
  recClip() {
    const mr = this.midiRec;
    const track = getTrack(mr.trackId);
    if (!track) return null;
    if (!mr.clip) {
      Undo.push('Record notes');
      mr.clip = {
        id: uid('clip'), kind: 'midi', name: 'Take', by: authorName(),
        start: mr.startBeat, length: 4, notes: []
      };
      track.clips.push(mr.clip);
      // pedal presses from before the first note belong in this clip
      if (mr.pendingPedal) {
        for (const e of mr.pendingPedal) this.writePedal(mr.clip, e.at, e.on);
        mr.pendingPedal = null;
      }
    }
    return mr.clip;
  },

  // Draw the note the moment the key goes down, then stretch it every frame
  // until the key comes up. This is the part that makes recording feel live.
  startLiveNote(key, h) {
    const clip = this.recClip();
    if (!clip) return;
    const note = { id: uid('note'), pitch: h.pitch,
                   start: Math.max(0, h.beat - clip.start), length: 0.05, vel: h.vel ?? 0.9 };
    clip.notes.push(note);
    this.midiRec.live.set(key, { note, clip });
    Timeline.renderSoon();
    if (typeof PianoRoll !== 'undefined' && PianoRoll.isOpen()) PianoRoll.redraw();
    this.startLiveGrow();
  },

  startLiveGrow() {
    if (this._growRaf) return;
    const tick = () => {
      const mr = this.midiRec;
      if (!mr || !mr.live.size) { this._growRaf = null; return; }
      const now = this.currentBeat();
      let clip = null;
      for (const { note, clip: c } of mr.live.values()) {
        note.length = Math.max(0.05, now - (c.start + note.start));
        clip = c;
      }
      if (clip) {
        const want = Math.max(clip.length, Math.ceil(now - clip.start));
        // growing the clip changes the timeline's layout, so that needs a real
        // render; otherwise only the one block it lives in has to be repainted
        if (want !== clip.length) { clip.length = want; Timeline.renderSoon(); }
        else Timeline.redrawClip(clip);
      }
      if (typeof PianoRoll !== 'undefined' && PianoRoll.isOpen()) PianoRoll.redraw();
      this._growRaf = requestAnimationFrame(tick);
    };
    this._growRaf = requestAnimationFrame(tick);
  },

  commitRecNote(h, endBeat, key) {
    const mr = this.midiRec;
    if (!mr) return;
    const len = Math.max(0.05, endBeat - h.beat);
    // the note is already on screen from startLiveNote; this settles its length
    const liveKey = key != null ? key : [...mr.live.keys()].find(k => mr.live.get(k).note.pitch === h.pitch);
    const live = liveKey != null ? mr.live.get(liveKey) : null;
    if (live) {
      live.note.length = len;
      live.clip.length = Math.max(live.clip.length, Math.ceil(live.note.start + len));
      mr.live.delete(liveKey);
    } else {
      // no live note (recording started mid-hold): record it exactly as played
      const clip = this.recClip();
      if (!clip) return;
      const rel = Math.max(0, h.beat - clip.start);
      clip.notes.push({ id: uid('note'), pitch: h.pitch, start: rel, length: len, vel: h.vel ?? 0.9 });
      clip.length = Math.max(clip.length, Math.ceil(rel + len));
    }
    Timeline.render();
    if (typeof PianoRoll !== 'undefined' && PianoRoll.isOpen()) PianoRoll.redraw();
  },

  finishMidiRecord() {
    const mr = this.midiRec;
    if (!mr) return;
    const now = this.currentBeat();
    for (const [k, h] of mr.held) this.commitRecNote(h, now, k);   // close held notes
    mr.held.clear();
    // a take that ends with the pedal still down leaves a span with no end
    if (this.pedalDown && mr.clip) this.writePedal(mr.clip, now, false);
    mr.live.clear();
    if (this._growRaf) { cancelAnimationFrame(this._growRaf); this._growRaf = null; }
    this.midiRec = null;
    KeysPanel.syncRecButton();
    if (mr.clip) {
      const track = getTrack(mr.trackId);
      const takeEnd = mr.clip.start + mr.clip.length;
      const neighbour = !mr.intoExisting && track && track.clips.find(c => c !== mr.clip &&
        c.kind === 'midi' && c.start < takeEnd - 1e-6 && c.start + clipBeats(c) > mr.clip.start + 1e-6);
      if (neighbour) {
        for (const n of mr.clip.notes) {
          n.start = Math.max(0, n.start + mr.clip.start - neighbour.start);
          neighbour.notes.push(n);
          neighbour.length = Math.max(neighbour.length, Math.ceil(n.start + n.length));
        }
        track.clips.splice(track.clips.indexOf(mr.clip), 1);
        mr.clip = neighbour;
        toast(tr('toast_take_merged', 'Added {n} notes to {name}',
          { n: mr.clip.notes.length, name: neighbour.name || tr('word_pattern', 'the pattern') }), 'green');
      } else {
        toast(tr('toast_recorded_notes', 'Recorded {n} notes', { n: mr.clip.notes.length }), 'green');
      }
      Timeline.render();
      App.selectClip(mr.clip.id);
    } else {
      toast(tr('toast_nothing_recorded', 'Nothing recorded'));
    }
  },

  previewNote(track, pitch, durSec = 0.3) {
    this.ensureCtx();
    this.ctx.resume();
    const v = this.makeVoice(this.ctx, this.trackInput(track.id), track.instrument, pitch, this.ctx.currentTime, 0.85);
    v.stop(this.ctx.currentTime + durSec);
  },

  previewSample(buffer) {
    this.ensureCtx();
    this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.master);
    src.start();
    src.stop(this.ctx.currentTime + Math.min(buffer.duration, 3));
  },

  // ----- real drum kit (bundled CC0 samples, decoded on first use) -----
  DRUMKIT: {},
  // Same rules as ensureMelodic: a failed piece must be retryable rather than
  // silently missing for the rest of the session, and "ready" has to mean it.
  ensureDrumkit() {
    if (this._drumkitReady) return Promise.resolve();
    if (this._drumkitLoading) return this._drumkitLoading;
    this.ensureCtx();
    const names = ['kick', 'snare', 'clap', 'hat_closed', 'hat_open', 'tom'];
    const todo = names.filter(nm => !this.DRUMKIT[nm]);
    if (!todo.length) { this._drumkitReady = true; return Promise.resolve(); }
    const failed = [];
    this._drumkitLoading = Promise.all(todo.map(async (nm) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch('assets/oneshots/' + nm + '.wav');
          if (!res.ok) throw new Error('http ' + res.status);
          this.DRUMKIT[nm] = await this.ctx.decodeAudioData(await res.arrayBuffer());
          return;
        } catch (e) {
          if (attempt) { failed.push(nm); console.warn('[fabu] drum sample failed to load:', nm, e.message); }
          else await new Promise(r => setTimeout(r, 150));
        }
      }
    })).then(() => {
      this._drumkitLoading = null;
      this._drumkitReady = failed.length === 0;
    });
    return this._drumkitLoading;
  },
  makeDrumkitVoice(ac, dest, pitch, t, vel = 0.9) {
    const nm = DRUMKIT_MAP[((pitch % 12) + 12) % 12];
    const buf = nm && this.DRUMKIT[nm];
    if (!buf) { this.ensureDrumkit(); return { stop() {}, kill() {} }; } // load for next time
    const src = ac.createBufferSource();
    src.buffer = buf;
    const g = ac.createGain();
    g.gain.value = clamp(vel, 0, 1) * 0.9;
    src.connect(g); g.connect(dest);
    src.start(t);
    return {
      stop: () => {},  // a hit rings out on its own, like the synth kit
      kill: () => { try { src.stop(); } catch (e) {} try { g.disconnect(); } catch (e) {} }
    };
  },

  // ----- real melodic instruments (bundled CC0 samples, multi-zone) -----
  MELODICBUF: {},
  // Load the sampled instruments. Two things this has to get right, because
  // getting them wrong means an instrument is silently mute:
  //   * a failed fetch must be RETRYABLE. This used to swallow the error and
  //     set _melodicReady anyway, so one hiccup muted that zone for the whole
  //     session with nothing in the console.
  //   * requests are limited to a few at a time. Firing all of them at once
  //     (there are 40-odd now) is what made those hiccups happen.
  ensureMelodic() {
    if (this._melodicReady) return Promise.resolve();
    if (this._melodicLoading) return this._melodicLoading;
    this.ensureCtx();
    const all = [...new Set(Object.values(MELODIC).flatMap(m => m.zones.map(z => z.file)))];
    const todo = all.filter(fn => !this.MELODICBUF[fn]);
    if (!todo.length) { this._melodicReady = true; return Promise.resolve(); }

    const LANES = 6;
    let next = 0;
    const failed = [];
    const worker = async () => {
      while (next < todo.length) {
        const fn = todo[next++];
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetch('assets/instr/' + fn + '.mp3');
            if (!res.ok) throw new Error('http ' + res.status);
            this.MELODICBUF[fn] = await this.ctx.decodeAudioData(await res.arrayBuffer());
            break;
          } catch (e) {
            if (attempt) { failed.push(fn); console.warn('[fabu] sample failed to load:', fn, e.message); }
            else await new Promise(r => setTimeout(r, 150));
          }
        }
      }
    };
    this._melodicLoading = Promise.all(Array.from({ length: LANES }, worker)).then(() => {
      this._melodicLoading = null;
      // only "ready" when everything really is; otherwise the next call retries
      this._melodicReady = failed.length === 0;
      this._melodicFailed = failed;
    });
    return this._melodicLoading;
  },
  makeMelodicVoice(ac, dest, instr, pitch, t, vel = 0.9, noAttack = false) {
    const m = MELODIC[instr];
    if (!m) return { stop() {}, kill() {} };
    let zone = m.zones[0], best = 1e9;
    for (const z of m.zones) { const d = Math.abs(pitch - z.root); if (d < best) { best = d; zone = z; } }
    const buf = this.MELODICBUF[zone.file];
    if (!buf) { this.ensureMelodic(); return { stop() {}, kill() {} }; }
    const g = ac.createGain(); g.connect(dest);
    const src = ac.createBufferSource(); src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (pitch - zone.root) / 12);
    src.connect(g);
    const A = noAttack ? 0.004 : (m.attack ?? 0.005);
    const R = m.release ?? 0.15;
    const lvl = 0.92 * vel * (m.gain || 1);   // level-match quieter source samples
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(lvl, t + A);
    const naturalEnd = t + buf.duration / src.playbackRate.value;
    src.start(t);
    try { src.stop(naturalEnd + 0.02); } catch (e) {}
    return {
      stop: (when) => {
        const w = Math.max(when, ac.currentTime);
        g.gain.cancelScheduledValues(w);
        g.gain.setTargetAtTime(0, w, Math.max(0.01, R / 4));
        try { src.stop(Math.min(naturalEnd + 0.02, w + R + 0.2)); } catch (e) {}
      },
      kill: () => { try { src.stop(); } catch (e) {} try { g.disconnect(); } catch (e) {} }
    };
  },

  // hear a Loops-browser pattern before dragging it in; routed through its own
  // bus so a second click can cut it instantly
  auditionSample(sample) {
    this.ensureCtx();
    this.ctx.resume();
    this.stopAudition();
    // real-drum loops need their samples decoded before they will sound
    if (sample.instrument === 'drumkit' && !this._drumkitReady) {
      this.ensureDrumkit().then(() => this.auditionSample(sample));
      return;
    }
    const ac = this.ctx;
    const bus = ac.createGain();
    bus.gain.value = 0.9;
    bus.connect(this.master);
    const spb = 60 / (S.bpm || 120);
    const t0 = ac.currentTime + 0.06;
    let endB = 0;
    for (const n of sample.notes) {
      const t = t0 + n.start * spb;
      const v = this.makeVoice(ac, bus, sample.instrument, n.pitch, t, (n.vel ?? 0.9) * 0.9);
      v.stop(t + n.length * spb);
      endB = Math.max(endB, n.start + n.length);
    }
    const stopMs = (t0 + endB * spb + 0.35 - ac.currentTime) * 1000;
    this._audition = { bus, timer: setTimeout(() => this.stopAudition(), stopMs) };
  },
  stopAudition() {
    const a = this._audition;
    if (!a) return;
    clearTimeout(a.timer);
    try { a.bus.disconnect(); } catch (e) {}  // cuts every voice fed through it
    this._audition = null;
  },

  // ----- voice recording with count-in -----

  micId() { try { return localStorage.getItem('fabu.micId') || ''; } catch (e) { return ''; } },
  setMicId(id) { try { localStorage.setItem('fabu.micId', id || ''); } catch (e) {} },

  async toggleRecord() {
    if (UI.recording) { this.stopRecord(); return; }
    if (typeof Sync !== 'undefined' && Sync.connected && Sync.blockMic()) return;
    this.ensureCtx();
    this.ctx.resume();
    let stream;
    try {
      const id = this.micId();
      // Record the mic RAW. Echo-cancel / noise-suppression / auto-gain and the
      // "voice" pipeline mangle music AND drop the whole output to tinny "phone
      // call" quality (Chromium routes playback through the AEC). Force them all
      // off, standard + legacy Chromium hints, so playback stays full quality.
      const audio = {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        voiceIsolation: false,
        googEchoCancellation: false, googAutoGainControl: false,
        googNoiseSuppression: false, googHighpassFilter: false, googAudioMirroring: false
      };
      if (id) audio.deviceId = { exact: id };
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (e) {
      toast(tr('toast_mic_denied', 'Microphone access denied'), 'red');
      return;
    }
    this.recStream = stream;
    UI.recording = true;
    App.onTransport();
    this.recStartBeat = snapBeat(UI.playhead, S.snap);

    let at = null;
    if (S.countIn) {
      at = await this.countIn();
      if (!UI.recording) { this.releaseStream(); return; } // cancelled meanwhile
    }

    this.recChunks = [];
    // pick a codec the browser actually supports (some default to an empty/odd
    // container and the take comes back silent), and flush periodically
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(m => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m));
    this.mediaRec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    this.mediaRec.ondataavailable = (e) => { if (e.data.size) this.recChunks.push(e.data); };
    this.mediaRec.onstop = () => this.finishRecording();
    this.mediaRec.start(250);
    UI.playhead = this.recStartBeat;
    if (!UI.playing) this.play(at);
    toast(tr('toast_recording', 'Recording'), 'red');
  },

  // Counts in 1-2-3-4, then resolves with the exact ctx time of the next
  // downbeat, where recording starts. No extra "GO" beat.
  countIn(isActive = () => UI.recording) {
    return new Promise((resolve) => {
      const overlay = $('#countOverlay');
      const num = $('#countNum');
      overlay.classList.remove('hidden');
      // clicking the badge (or the cancel hint) stops the count-in
      overlay.onmousedown = () => { UI.recording = false; };
      const spb = this.spb();
      const t0 = this.ctx.currentTime + 0.15;
      for (let i = 0; i < 4; i++) this.click(this.ctx, this.metroGain, t0 + i * spb, i === 0);
      for (let i = 0; i < 4; i++) {
        setTimeout(() => {
          if (!isActive()) return;
          num.textContent = String(i + 1);
          num.style.animation = 'none'; void num.offsetWidth; num.style.animation = '';
        }, Math.max(0, (t0 + i * spb - this.ctx.currentTime) * 1000));
      }
      const downbeat = t0 + 4 * spb;   // the beat right after "4", where recording begins
      setTimeout(() => {
        overlay.classList.add('hidden');
        overlay.onmousedown = null;
        resolve(isActive() ? downbeat : null);
      }, Math.max(0, (downbeat - this.ctx.currentTime) * 1000 - 30));
    });
  },

  stopRecord() {
    if (!UI.recording) return;
    UI.recording = false;
    if (this.mediaRec && this.mediaRec.state !== 'inactive') {
      this.mediaRec.stop(); // finishRecording() runs from onstop
    } else {
      this.releaseStream();
      App.onTransport();
    }
  },

  releaseStream() {
    if (this.recStream) {
      for (const tr of this.recStream.getTracks()) tr.stop();
      this.recStream = null;
    }
  },

  async finishRecording() {
    const mime = this.mediaRec.mimeType || 'audio/webm';
    const blob = new Blob(this.recChunks, { type: mime });
    this.releaseStream();
    App.onTransport();
    if (blob.size < 200) { toast(tr('toast_recording_empty', 'Recording was empty'), 'red'); return; }
    try {
      const bytes = await blob.arrayBuffer();
      const buffer = await this.ctx.decodeAudioData(bytes.slice(0));
      const id = uid('smp');
      const n = Object.keys(Samples).filter(k => Samples[k].name.startsWith('Recording')).length + 1;
      Samples[id] = { id, name: 'Recording ' + n, buffer, bytes, mime };

      pushUndoAction('Record audio');
      let track = S.tracks.find(t => t.id === UI.selTrackId && t.kind === 'audio')
        || S.tracks.find(t => t.kind === 'audio' && t.name.startsWith('Voice'));
      if (!track) {
        track = makeTrack('audio');
        track.name = 'Voice';
        S.tracks.push(track);
        this.rebuildTracks();
      }
      const clip = {
        id: uid('clip'), kind: 'audio', name: Samples[id].name, by: authorName(),
        start: this.recStartBeat, sampleId: id,
        fadeIn: 0, fadeOut: 0, pitch: 0, gain: 1
      };
      // don't clobber existing audio on this lane: give the take its own lane
      const cEnd = clip.start + clipBeats(clip);
      if (track.clips.some(c => c.start < cEnd - 1e-6 && c.start + clipBeats(c) > clip.start + 1e-6)) {
        track = makeTrack('audio'); track.name = 'Voice'; S.tracks.push(track); this.rebuildTracks();
      }
      track.clips.push(clip);
      Timeline.render();
      Windows.refreshAll();
      toast(tr('toast_recording_added', 'Recording added'), 'green');
    } catch (e) {
      toast(tr('toast_decode_fail', 'Could not decode recording'), 'red');
    }
  },

  // ----- export to WAV -----

  async exportWav() { return this.encodeWav(await this.renderSong()); },

  // Render a set of clips (across tracks) offline into one stereo buffer, so a
  // group can be flattened into a real audio clip. Each clip plays through its
  // own track's chain (EQ, volume, effects, reverb) exactly as it sounds now.
  async bounceClips(items, startBeat, lenBeats) {
    this.ensureCtx();
    // the sampled instruments must actually be decoded before we render, or
    // the export comes out silent for every one of them
    await this.ensureMelodic();
    await this.ensureDrumkit();
    const spb = this.spb();
    const lead = 0;   // no lead-in: the bounce must line up exactly with the group's start
    const sr = 44100;
    const lenSec = Math.max(0.05, lenBeats * spb);   // exact footprint so it lines up on the grid
    const oc = new OfflineAudioContext(2, Math.ceil(lenSec * sr), sr);
    const master = oc.createGain(); master.gain.value = 1;
    const rev = this.buildReverb(oc, master, master, this.ecoMode() ? 0 : 0.16);
    master.connect(oc.destination);
    const offFx = { curBeat: startBeat, time0: lead, beatToTime: (b) => lead + (b - startBeat) * spb };
    this._offlineFx = offFx;
    const tracks = new Map();
    for (const it of items) if (!tracks.has(it.track.id)) tracks.set(it.track.id, it.track);
    for (const [tid, track] of tracks) {
      const chain = this.buildChain(oc, master, track);
      chain.gain.gain.value = track.volume;   // bounce at the track's real volume, ignore mute/solo
      this.scheduleAutomation(oc, chain, track, startBeat, lead, spb);
      for (const it of items) {
        if (it.track.id !== tid) continue;
        const c = it.clip;
        const offBeat = c.start - startBeat;
        if (c.kind === 'midi') {
          const clipDest = this.clipFxDest(oc, chain.input, c, rev.pre, offFx);
          const sp = c.speed || 1;
          for (const n of c.notes) {
            if (n.start >= c.length) continue;
            const time = lead + (offBeat + n.start / sp) * spb;
            const durB = Math.min(n.length, c.length - n.start) / sp;
            const v = this.makeVoice(oc, clipDest, track.instrument, n.pitch + (c.pitch || 0) + (c.detune || 0) / 100, time, (n.vel ?? 0.9) * (c.gain ?? 1));
            v.stop(time + durB * spb);
          }
        } else {
          this.scheduleAudioClip(oc, chain.input, c, lead + offBeat * spb, 0, false, rev.pre);
        }
      }
    }
    this._offlineFx = null;
    const buf = await oc.startRendering();
    // tiny fade at the hard cut so it doesn't click
    const fade = Math.min(256, buf.length);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < fade; i++) d[buf.length - 1 - i] *= i / fade;
    }
    return buf;
  },

  // Render each track on its own, so you can take the parts elsewhere.
  // Same chain as the full mix, just one track at a time (mutes/solos ignored
  // so you always get every stem).
  async renderStems(onProgress) {
    this.ensureCtx();
    await this.ensureMelodic();   // same as renderSong: no samples, no sound
    await this.ensureDrumkit();
    const spb = this.spb();
    const lead = 0.05;
    const lenSec = songEndBeat() * spb + 2;
    const sr = 44100;
    const out = [];
    const tracks = S.tracks.filter(t => t.clips.length);
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (onProgress) onProgress(i / tracks.length, t.name);
      const oc = new OfflineAudioContext(2, Math.ceil(lenSec * sr), sr);
      const comp = oc.createDynamicsCompressor();
      comp.threshold.value = -3; comp.knee.value = 8; comp.ratio.value = 3;
      comp.attack.value = 0.006; comp.release.value = 0.2;
      const master = oc.createGain();
      master.gain.value = S.masterVol;
      master.connect(comp);
      const rev = this.buildReverb(oc, master, comp, this.ecoMode() ? 0 : 0.16);
      const ceil = this.makeCeiling(oc);
      comp.connect(ceil);
      ceil.connect(oc.destination);
      const offFx = { curBeat: 0, time0: lead, beatToTime: (b) => lead + b * spb };
      this._offlineFx = offFx;
      const chain = this.buildChain(oc, master, t);
      chain.gain.gain.value = t.volume;       // ignore mute/solo for stems
      this.scheduleAutomation(oc, chain, t, 0, lead, spb);
      for (const c of t.clips) {
        if (c.kind === 'midi') {
          const clipDest = this.clipFxDest(oc, chain.input, c, rev.pre, offFx);
          const sp = c.speed || 1;
          for (const n of c.notes) {
            if (n.start >= c.length) continue;
            const time = lead + (c.start + n.start / sp) * spb;
            const durB = Math.min(n.length, c.length - n.start) / sp;
            const v = this.makeVoice(oc, clipDest, t.instrument, n.pitch + (c.pitch || 0) + (c.detune || 0) / 100, time, (n.vel ?? 0.9) * (c.gain ?? 1));
            v.stop(time + durB * spb);
          }
        } else {
          this.scheduleAudioClip(oc, chain.input, c, lead + c.start * spb, 0, false, rev.pre);
        }
      }
      this._offlineFx = null;
      out.push({ name: t.name, buffer: await oc.startRendering() });
    }
    if (onProgress) onProgress(1, '');
    return out;
  },

  // Render the whole song offline into a stereo AudioBuffer.
  async renderSong() {
    this.ensureCtx();
    // the sampled instruments must actually be decoded before we render, or
    // the export comes out silent for every one of them
    await this.ensureMelodic();
    await this.ensureDrumkit();
    const spb = this.spb();
    const lead = 0.05;
    const lenSec = songEndBeat() * spb + 2;
    const sr = 44100;
    const oc = new OfflineAudioContext(2, Math.ceil(lenSec * sr), sr);

    // match the live master chain exactly. These used to differ (-8/6 offline
    // vs -3/3 live), so every export came out more squashed than what you mixed
    const comp = oc.createDynamicsCompressor();
    comp.threshold.value = -3; comp.knee.value = 8; comp.ratio.value = 3;
    comp.attack.value = 0.006; comp.release.value = 0.2;
    const master = oc.createGain();
    master.gain.value = S.masterVol;
    master.connect(comp);
    const rev = this.buildReverb(oc, master, comp, 0.16);
    const ceil = this.makeCeiling(oc);
    comp.connect(ceil);
    ceil.connect(oc.destination);

    // offline automation context so per-effect keyframes render into the export
    const offFx = { curBeat: 0, time0: lead, beatToTime: (b) => lead + b * spb };
    this._offlineFx = offFx;
    for (const t of S.tracks) {
      if (!this.audible(t)) continue;
      const chain = this.buildChain(oc, master, t);
      this.scheduleAutomation(oc, chain, t, 0, lead, spb);
      for (const c of t.clips) {
        if (c.kind === 'midi') {
          const clipDest = this.clipFxDest(oc, chain.input, c, rev.pre, offFx);
          const sp = c.speed || 1;
          for (const n of c.notes) {
            if (n.start >= c.length) continue;
            const time = lead + (c.start + n.start / sp) * spb;
            const durB = Math.min(n.length, c.length - n.start) / sp;
            const v = this.makeVoice(oc, clipDest, t.instrument, n.pitch + (c.pitch || 0) + (c.detune || 0) / 100, time, (n.vel ?? 0.9) * (c.gain ?? 1));
            v.stop(time + durB * spb);
          }
        } else {
          this.scheduleAudioClip(oc, chain.input, c, lead + c.start * spb, 0, false, rev.pre);
        }
      }
    }
    this._offlineFx = null;

    return oc.startRendering();
  },

  // Encode a rendered buffer to MP3 (lamejs), yielding so a progress bar can move.
  async encodeMp3(buffer, kbps = 192, onProgress) {
    const enc = new lamejs.Mp3Encoder(2, buffer.sampleRate, kbps);
    const L = buffer.getChannelData(0);
    const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    const len = buffer.length;
    const block = 1152;
    const li = new Int16Array(block), ri = new Int16Array(block);
    const chunks = [];
    for (let i = 0; i < len; i += block) {
      const n = Math.min(block, len - i);
      for (let j = 0; j < n; j++) {
        li[j] = Math.max(-1, Math.min(1, L[i + j])) * 32767;
        ri[j] = Math.max(-1, Math.min(1, R[i + j])) * 32767;
      }
      const mp3 = enc.encodeBuffer(li.subarray(0, n), ri.subarray(0, n));
      if (mp3.length) chunks.push(new Uint8Array(mp3));
      if ((i / block) % 40 === 0) {
        if (onProgress) onProgress(i / len);
        await new Promise(r => setTimeout(r, 0)); // let the UI breathe
      }
    }
    const end = enc.flush();
    if (end.length) chunks.push(new Uint8Array(end));
    if (onProgress) onProgress(1);
    let total = 0; for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
    return out.buffer;
  },

  // Encode to real OGG Vorbis with the bundled WASM encoder, yielding for progress.
  async encodeOggVorbis(buffer, quality = 3, onProgress) {
    if (!this._oggEnc) {
      const bytes = new Uint8Array(b64ToBuf(window.FABU_OGG_WASM));
      this._oggEnc = await WasmMediaEncoder.createEncoder('audio/ogg', bytes);
    }
    const enc = this._oggEnc;
    enc.configure({ channels: 2, sampleRate: buffer.sampleRate, vbrQuality: quality });
    const L = buffer.getChannelData(0);
    const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    const len = buffer.length;
    const block = 131072;
    const parts = [];
    for (let i = 0; i < len; i += block) {
      const n = Math.min(block, len - i);
      const out = enc.encode([L.subarray(i, i + n), R.subarray(i, i + n)]);
      if (out.length) parts.push(out.slice()); // the view points into wasm memory, copy it
      if (onProgress) onProgress(i / len);
      await new Promise(r => setTimeout(r, 0)); // keep the progress bar moving
    }
    const tail = enc.finalize();
    if (tail.length) parts.push(tail.slice());
    if (onProgress) onProgress(1);
    let total = 0; for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
    return out.buffer;
  },

  // Encode via MediaRecorder (opus). Real-time, used for ogg/webm when supported.
  encodeOpus(buffer, mime, onProgress) {
    return new Promise((resolve, reject) => {
      const ac = new AudioContext();
      const src = ac.createBufferSource();
      src.buffer = buffer;
      const dest = ac.createMediaStreamDestination();
      src.connect(dest);
      let rec;
      try { rec = new MediaRecorder(dest.stream, { mimeType: mime }); }
      catch (e) { ac.close(); reject(e); return; }
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        ac.close();
        resolve(await new Blob(chunks, { type: mime }).arrayBuffer());
      };
      rec.start();
      src.start();
      const dur = buffer.duration;
      const t0 = performance.now();
      const tick = setInterval(() => {
        if (onProgress) onProgress(Math.min(0.99, (performance.now() - t0) / 1000 / dur));
      }, 100);
      src.onended = () => { clearInterval(tick); if (onProgress) onProgress(1); setTimeout(() => rec.stop(), 120); };
    });
  },

  encodeWav(buffer) {
    const numCh = 2;
    const sr = buffer.sampleRate;
    const len = buffer.length;
    const bytesPerSample = 2;
    const dataSize = len * numCh * bytesPerSample;
    const ab = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(ab);
    const wStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    wStr(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); wStr(8, 'WAVE');
    wStr(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, numCh, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * numCh * bytesPerSample, true);
    dv.setUint16(32, numCh * bytesPerSample, true); dv.setUint16(34, 16, true);
    wStr(36, 'data'); dv.setUint32(40, dataSize, true);
    const L = buffer.getChannelData(0);
    const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    let off = 44;
    for (let i = 0; i < len; i++) {
      dv.setInt16(off, clamp(L[i], -1, 1) * 0x7fff, true); off += 2;
      dv.setInt16(off, clamp(R[i], -1, 1) * 0x7fff, true); off += 2;
    }
    return ab;
  }
};

// pushUndo lives in state.js's world but Engine needs it before app.js defines helpers
function pushUndoAction(label) { Undo.push(label); }
