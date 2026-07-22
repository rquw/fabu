// ---------- Audio engine: instruments, playback scheduler, recording, export ----------
'use strict';

const INSTRUMENTS = {
  keys:  'Keys',
  epiano: 'E-Piano',
  organ: 'Organ',
  strings: 'Strings',
  synth: 'Synth Lead',
  bass:  'Bass',
  pluck: 'Pluck',
  bell:  'Bell',
  rpiano: 'Grand Piano',
  rvibes: 'Vibraphone',
  drums: 'Drum Kit',
  drumkit: 'Acoustic Kit'
};

// real recorded melodic instruments (bundled CC0 MP3s in assets/instr), played
// multi-zone: pick the sample whose root is nearest the note, then pitch-shift a little
const MELODIC = {
  rpiano: { name: 'Grand Piano', attack: 0.004, release: 0.18, zones: [{ file: 'piano_c2', root: 36 }, { file: 'piano_c4', root: 60 }, { file: 'piano_c6', root: 84 }] },
  rvibes: { name: 'Vibraphone', attack: 0.003, release: 0.4, zones: [{ file: 'vibes_c3', root: 48 }, { file: 'vibes_c5', root: 72 }] }
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

  // recording
  mediaRec: null,
  recChunks: [],
  recStream: null,
  recStartBeat: 0,
  midiRec: null,        // { trackId, clip, startBeat, held: Map } while note-recording

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
    // a little room reverb makes the synths feel real
    this.rev = this.buildReverb(this.ctx, this.master, this.comp, 0.16);
    if (this.ecoMode()) { try { this.rev.pre.disconnect(this.rev.conv); } catch (e) {} }
    this.comp.connect(this.ctx.destination);
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
  // are CLOSEST TO ENDING (least audible to cut) instead of the oldest — the
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

  // ----- track chains: clips → input → EQ(3 band) → pan → gain → master -----

  buildChain(ac, dest, track) {
    const input = ac.createGain();
    const eqLow = ac.createBiquadFilter();
    eqLow.type = 'lowshelf'; eqLow.frequency.value = 220;
    const eqMid = ac.createBiquadFilter();
    eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 0.9;
    const eqHigh = ac.createBiquadFilter();
    eqHigh.type = 'highshelf'; eqHigh.frequency.value = 4500;
    const pan = ac.createStereoPanner();
    const gain = ac.createGain();
    const sc = ac.createGain();   // sidechain "pump" ducking (1 = no ducking)
    input.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh);
    eqHigh.connect(pan); pan.connect(gain); gain.connect(sc); sc.connect(dest);
    const chain = { input, eqLow, eqMid, eqHigh, pan, gain, sc };
    this.applyParams(chain, track);
    return chain;
  },

  applyParams(chain, track) {
    chain.eqLow.gain.value = track.eq.low;
    chain.eqMid.gain.value = track.eq.mid;
    chain.eqHigh.gain.value = track.eq.high;
    chain.pan.pan.value = track.pan;
    chain.gain.gain.value = this.audible(track) ? track.volume : 0;
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

  AUTOM_PARAMS: ['volume', 'low', 'mid', 'high', 'pan'],

  automAudioParam(chain, param) {
    switch (param) {
      case 'volume': return chain.gain.gain;
      case 'low': return chain.eqLow.gain;
      case 'mid': return chain.eqMid.gain;
      case 'high': return chain.eqHigh.gain;
      case 'pan': return chain.pan.pan;
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
      for (const ap of [c.gain.gain, c.eqLow.gain, c.eqMid.gain, c.eqHigh.gain, c.pan.pan]) {
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
    if (instr === 'keys') return this.makePiano(ac, dest, pitch, t, vel, noAttack);

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
    } else if (instr === 'organ') {
      // drawbar stack with slow vibrato, holds while pressed
      const vib = ac.createOscillator(); vib.frequency.value = 5.6;
      const vibG = ac.createGain(); vibG.gain.value = 2.4;
      vib.connect(vibG);
      for (const [mult, lvl] of [[0.5, 0.5], [1, 1], [2, 0.55], [3, 0.3], [4, 0.2]]) {
        const og = mk('sine', f * mult, 0, lvl * 0.28);
        vibG.connect(oscs[oscs.length - 1].detune);
        og.connect(g);
      }
      oscs.push(vib);
      A = 0.02; D = 0.05; SUS = 1.0; R = 0.08; peak = 0.32;
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
      // straight to sustain with a tiny fade so there's no attack thump/click
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(p * SUS, t + 0.01);
      // no filter sweep — it's mid-note, the filter has already settled
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
      pg.gain.linearRampToValueAtTime(amp, t + (noAttack ? 0.012 : 0.004));
      pg.gain.exponentialRampToValueAtTime(0.0002, t + bodyDecay * decayScale * (noAttack ? 0.6 : 1));
      o.connect(pg); pg.connect(g);
      o.start(t);
      oscs.push(o);
    }
    if (!noAttack) {
      // hammer thock — the attack transient we skip for a mid-note start
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
    const A = noAttack ? 0.01 : (inst.attack ?? 0.005);
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
  // C = kick · D = snare · E = clap · F/F# = closed hat · A/A# = open hat
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

  // A per-clip effect chain: the built-in drive → crush → filter sliders plus
  // any dropped effects from clip.fx (reverb send, dampen, echo, …). Every note
  // or audio source of the clip routes through it. Returns `dest` unchanged
  // when the clip has nothing to apply.
  clipFxDest(ac, dest, clip, revIn) {
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
        f.type = 'lowpass'; f.frequency.value = p.freq ?? 2500; f.Q.value = 0.9;
        node.connect(f); node = f;
      } else if (fx.type === 'echo') {
        const sum = ac.createGain();
        const dl = ac.createDelay(2); dl.delayTime.value = p.time ?? 0.3;
        const fb = ac.createGain(); fb.gain.value = clamp(p.fb ?? 0.35, 0, 0.92);
        const wet = ac.createGain(); wet.gain.value = p.mix ?? 0.35;
        node.connect(sum);
        node.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(wet); wet.connect(sum);
        node = sum;
      } else if (fx.type === 'reverb' && revIn) {
        const send = ac.createGain(); send.gain.value = p.amt ?? 0.35;
        node.connect(send); send.connect(revIn);
      } else if (fx.type === 'lowcut') {
        const f = ac.createBiquadFilter();
        f.type = 'highpass'; f.frequency.value = p.freq ?? 200; f.Q.value = 0.7;
        node.connect(f); node = f;
      } else if (fx.type === 'tremolo') {
        const g2 = ac.createGain();
        const depth = clamp(p.depth ?? 0.6, 0, 1);
        g2.gain.value = 1 - depth / 2;
        const lfo = ac.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = p.rate ?? 5;
        const lg = ac.createGain(); lg.gain.value = depth / 2;
        lfo.connect(lg); lg.connect(g2.gain); lfo.start();
        node.connect(g2); node = g2;
      } else if (fx.type === 'wobble') {
        const f = ac.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 800; f.Q.value = 6;
        const lfo = ac.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = p.rate ?? 3;
        const lg = ac.createGain(); lg.gain.value = (p.amt ?? 0.7) * 1800;
        lfo.connect(lg); lg.connect(f.frequency); lfo.start();
        node.connect(f); node = f;
      } else if (fx.type === 'widen') {
        // Haas widening: delay one side a few ms
        const splitL = ac.createGain(), splitR = ac.createDelay(0.05);
        splitR.delayTime.value = 0.004 + (p.amt ?? 0.6) * 0.02;
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
    const durOut = clipDurSec(clip) / speed;   // speed changes the output length
    if (outOff >= durOut) return;

    const src = ac.createBufferSource();
    src.buffer = this.shiftedBuffer(s, clip.pitch || 0); // shift pitch, keep length
    src.playbackRate.value = speed;
    const g = ac.createGain();

    // effects (built-in sliders + dropped fx) live in the shared per-clip chain
    if (revIn === undefined) revIn = (ac === this.ctx && this.rev) ? this.rev.pre : null;
    const fxDest = this.clipFxDest(ac, dest, clip, revIn);
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

    src.start(when, trimOff + outOff * speed);
    src.stop(T + durOut + 0.03);

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

  // schedule one clip (midi or audio) playing on `t`'s chain into `ev`
  collectClipEvents(ev, c, t, fromBeat) {
    if (c.kind === 'midi') {
      let clipDest = null; // one shared per-clip fx chain, built at play time
      const getDest = () => {
        if (!clipDest) {
          clipDest = this.clipFxDest(this.ctx, this.trackInput(t.id), c, this.rev && this.rev.pre);
          if (clipDest !== this.trackInput(t.id)) this.live.add({ kill: () => { try { clipDest.disconnect(); } catch (e) {} } });
        }
        return clipDest;
      };
      for (const n of c.notes) {
        if (n.start >= c.length) continue;
        const b = this.swingBeat(c.start + n.start, t.swing);
        const durB = Math.min(n.length, c.length - n.start);
        const endB = b + durB;
        if (endB <= fromBeat + 1e-6) continue; // already finished
        const startBeat = Math.max(b, fromBeat);
        const remain = endB - startBeat;
        const midNote = startBeat > b + 1e-6; // seeked INTO this note
        ev.push({
          beat: startBeat,
          fn: (time) => {
            const v = this.makeVoice(this.ctx, getDest(), t.instrument, n.pitch + (c.pitch || 0), time, (n.vel ?? 0.9) * (c.gain ?? 1), midNote);
            const end = time + remain * this.spb();
            v.stop(end);
            this.registerVoice(v, end);
          }
        });
      }
    } else {
      const lenB = clipBeats(c);
      if (c.start + lenB <= fromBeat + 1e-6) return;
      if (c.start >= fromBeat - 1e-6) {
        ev.push({ beat: c.start, fn: (time) => this.scheduleAudioClip(this.ctx, this.trackInput(t.id), c, time, 0) });
      } else {
        const outOff = (fromBeat - c.start) * this.spb();
        ev.push({ beat: fromBeat, fn: (time) => this.scheduleAudioClip(this.ctx, this.trackInput(t.id), c, time, outOff) });
      }
    }
  },

  collectEvents(fromBeat) {
    const ev = [];
    for (const t of S.tracks) {
      for (const c of t.clips) {
        if (c.kind === 'group') {
          // play each child at its absolute position through its original track,
          // so a grouped drum pattern still sounds like drums, etc.
          for (const child of c.children) {
            const ot = getTrack(child.origTrackId) || t;
            const abs = Object.assign({}, child.clip, { start: c.start + (child.clip.start || 0) });
            this.collectClipEvents(ev, abs, ot, fromBeat);
          }
        } else {
          this.collectClipEvents(ev, c, t, fromBeat);
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
    UI.playing = true;
    this.startBeat = UI.playhead;
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

  schedTick() {
    if (!UI.playing) return;
    const horizon = this.ctx.currentTime + 0.15;
    const horizonBeat = this.startBeat + (horizon - this.startCtxTime) / this.spb();
    while (this.evIdx < this.events.length && this.events[this.evIdx].beat < horizonBeat) {
      const e = this.events[this.evIdx++];
      e.fn(Math.max(this.beatToTime(e.beat), this.ctx.currentTime + 0.005));
    }
    if (S.metronome) {
      while (this.nextClickBeat < horizonBeat) {
        const t = this.beatToTime(this.nextClickBeat);
        if (t >= this.ctx.currentTime) {
          this.click(this.ctx, this.metroGain, t, this.nextClickBeat % 4 === 0);
        }
        this.nextClickBeat++;
      }
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
    if (wasPlaying) this.haltPlayback();
    UI.playhead = Math.max(0, beat);
    if (wasPlaying) this.play();
    else App.onTransport();
  },

  // Re-apply clip-level effect edits mid-playback without a full stop/start:
  // kill what's sounding and reschedule from the current beat with the new
  // settings. Track EQ/volume/pan already update live on their own.
  reschedule() {
    if (!UI.playing || !this.ctx) return;
    const beat = this.currentBeat();
    for (const v of this.live) v.kill();
    this.live.clear();
    this.startBeat = beat;
    this.startCtxTime = this.ctx.currentTime + 0.03;
    this.events = this.collectEvents(beat);
    this.evIdx = 0;
    this.nextClickBeat = Math.ceil(beat - 1e-6);
    this.schedTick();
  },

  // Any edit while the song plays (add/delete a clip or note, drop an effect,
  // move something) reschedules from the current beat — debounced so a flurry
  // of edits coalesces. This is what makes deletes stop sounding and effects
  // take hold live, for you AND remote collaborators.
  liveEdit() {
    if (!UI.playing) return;
    clearTimeout(this._reTimer);
    this._reTimer = setTimeout(() => { if (UI.playing) this.reschedule(); }, 150);
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
      this.midiRec.held.set(key, { pitch, beat: this.currentBeat(), vel });
    }
  },

  noteOff(trackId, pitch) {
    const key = trackId + ':' + pitch;
    const v = this.liveKeys.get(key);
    if (v) {
      v.stop(this.ctx.currentTime);
      this.liveKeys.delete(key);
    }
    if (this.midiRec) {
      const h = this.midiRec.held.get(key);
      if (h) {
        this.midiRec.held.delete(key);
        this.commitRecNote(h, this.currentBeat());
      }
    }
  },

  // ----- record played notes into a pattern clip -----

  toggleMidiRecord() {
    if (this.midiRec) { this.finishMidiRecord(); return; }
    this.ensureCtx();
    this.ctx.resume();
    const track = KeysPanel.targetTrack();
    if (!track) { toast(tr('toast_add_instr_first', 'Add an instrument track first'), 'red'); return; }
    const startBeat = snapBeat(UI.playhead, S.snap);
    this.midiRec = { trackId: track.id, clip: null, startBeat, held: new Map() };
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

  commitRecNote(h, endBeat) {
    const mr = this.midiRec;
    const track = getTrack(mr.trackId);
    if (!track) return;
    if (!mr.clip) {
      Undo.push('Record notes');
      mr.clip = {
        id: uid('clip'), kind: 'midi', name: 'Take', by: authorName(),
        start: mr.startBeat, length: 4, notes: []
      };
      track.clips.push(mr.clip);
    }
    // record exactly what was played, no quantizing (quantize by hand later if you want)
    const rel = Math.max(0, h.beat - mr.clip.start);
    const len = Math.max(0.05, endBeat - h.beat);
    mr.clip.notes.push({ id: uid('note'), pitch: h.pitch, start: rel, length: len, vel: h.vel ?? 0.9 });
    mr.clip.length = Math.max(mr.clip.length, Math.ceil(rel + len));
    Timeline.render();
  },

  finishMidiRecord() {
    const mr = this.midiRec;
    if (!mr) return;
    const now = this.currentBeat();
    for (const h of mr.held.values()) this.commitRecNote(h, now); // close held notes
    mr.held.clear();
    this.midiRec = null;
    KeysPanel.syncRecButton();
    if (mr.clip) {
      // if the take overlaps clips already on the track, move it to its own lane
      // (keeps the take exactly where it was played, without clobbering them)
      const track = getTrack(mr.trackId);
      const takeEnd = mr.clip.start + mr.clip.length;
      const overlaps = track && track.clips.some(c => c !== mr.clip &&
        c.start < takeEnd - 1e-6 && c.start + clipBeats(c) > mr.clip.start + 1e-6);
      if (overlaps) {
        track.clips.splice(track.clips.indexOf(mr.clip), 1);
        const nt = makeTrack('midi');
        nt.instrument = track.instrument;
        nt.name = track.name + ' take';
        nt.clips.push(mr.clip);
        S.tracks.push(nt);
        this.rebuildTracks();
        KeysPanel.refreshTracks();
        toast(tr('toast_take_new_lane', 'Take added on a new lane so it does not overlap'), 'green');
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
  ensureDrumkit() {
    if (this._drumkitReady) return Promise.resolve();
    if (this._drumkitLoading) return this._drumkitLoading;
    this.ensureCtx();
    const names = ['kick', 'snare', 'clap', 'hat_closed', 'hat_open', 'tom'];
    this._drumkitLoading = Promise.all(names.map(async (nm) => {
      try {
        const res = await fetch('assets/oneshots/' + nm + '.wav');
        const buf = await res.arrayBuffer();
        this.DRUMKIT[nm] = await this.ctx.decodeAudioData(buf);
      } catch (e) { /* a missing piece just stays silent */ }
    })).then(() => { this._drumkitReady = true; });
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
  ensureMelodic() {
    if (this._melodicReady) return Promise.resolve();
    if (this._melodicLoading) return this._melodicLoading;
    this.ensureCtx();
    const files = [...new Set(Object.values(MELODIC).flatMap(m => m.zones.map(z => z.file)))];
    this._melodicLoading = Promise.all(files.map(async (fn) => {
      try {
        const res = await fetch('assets/instr/' + fn + '.mp3');
        const buf = await res.arrayBuffer();
        this.MELODICBUF[fn] = await this.ctx.decodeAudioData(buf);
      } catch (e) { /* a missing zone just stays silent */ }
    })).then(() => { this._melodicReady = true; });
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
    const A = noAttack ? 0.02 : (m.attack ?? 0.005);
    const R = m.release ?? 0.15;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.92 * vel, t + A);
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
    this.ensureCtx();
    this.ctx.resume();
    let stream;
    try {
      const id = this.micId();
      // record the mic RAW — no echo cancel / noise suppression / auto-gain,
      // which mangle music and vocals. And use the chosen input device.
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
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
    this.mediaRec = new MediaRecorder(stream);
    this.mediaRec.ondataavailable = (e) => { if (e.data.size) this.recChunks.push(e.data); };
    this.mediaRec.onstop = () => this.finishRecording();
    this.mediaRec.start();
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
      const downbeat = t0 + 4 * spb;   // the beat right after "4" — recording begins here
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

  // Render the whole song offline into a stereo AudioBuffer.
  async renderSong() {
    this.ensureCtx();
    const spb = this.spb();
    const lead = 0.05;
    const lenSec = songEndBeat() * spb + 2;
    const sr = 44100;
    const oc = new OfflineAudioContext(2, Math.ceil(lenSec * sr), sr);

    const comp = oc.createDynamicsCompressor();
    comp.threshold.value = -8; comp.ratio.value = 6;
    const master = oc.createGain();
    master.gain.value = S.masterVol;
    master.connect(comp);
    const rev = this.buildReverb(oc, master, comp, 0.16);
    comp.connect(oc.destination);

    for (const t of S.tracks) {
      if (!this.audible(t)) continue;
      const chain = this.buildChain(oc, master, t);
      this.scheduleAutomation(oc, chain, t, 0, lead, spb);
      for (const c of t.clips) {
        if (c.kind === 'midi') {
          const clipDest = this.clipFxDest(oc, chain.input, c, rev.pre);
          for (const n of c.notes) {
            if (n.start >= c.length) continue;
            const time = lead + (c.start + n.start) * spb;
            const durB = Math.min(n.length, c.length - n.start);
            const v = this.makeVoice(oc, clipDest, t.instrument, n.pitch + (c.pitch || 0), time, (n.vel ?? 0.9) * (c.gain ?? 1));
            v.stop(time + durB * spb);
          }
        } else {
          this.scheduleAudioClip(oc, chain.input, c, lead + c.start * spb, 0, false, rev.pre);
        }
      }
    }

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
