import { prefs } from './util.js';

let ctx = null;
export function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Voice remover. Dialogue in films sits dead-center in the stereo mix, so
// throwing away the mid channel (keeping side + bass + air) kills most of it.
// Mono sources get a hard voice-band cut instead.
export class Remover {
  constructor(ac) {
    this.ac = ac;
    this.input = ac.createGain();
    this.output = ac.createGain();

    this.orig = ac.createGain();
    this.input.connect(this.orig).connect(this.output);

    const split = ac.createChannelSplitter(2);
    this.input.connect(split);
    const l = ac.createGain(), r = ac.createGain();
    split.connect(l, 0); split.connect(r, 1);

    const sideL = ac.createGain(); sideL.gain.value = 0.5;
    const sideR = ac.createGain(); sideR.gain.value = -0.5;
    const side = ac.createGain();
    l.connect(sideL).connect(side); r.connect(sideR).connect(side);

    const midL = ac.createGain(); midL.gain.value = 0.5;
    const midR = ac.createGain(); midR.gain.value = 0.5;
    const mid = ac.createGain();
    l.connect(midL).connect(mid); r.connect(midR).connect(mid);

    const bass = ac.createBiquadFilter(); bass.type = 'lowpass'; bass.frequency.value = 150; bass.Q.value = 0.6;
    const bass2 = ac.createBiquadFilter(); bass2.type = 'lowpass'; bass2.frequency.value = 150; bass2.Q.value = 0.6;
    const air = ac.createBiquadFilter(); air.type = 'highpass'; air.frequency.value = 9000;
    const airG = ac.createGain(); airG.gain.value = 0.35;
    const sideBoost = ac.createGain(); sideBoost.gain.value = 1.6;

    this.center = ac.createGain();
    side.connect(sideBoost).connect(this.center);
    mid.connect(bass).connect(bass2).connect(this.center);
    mid.connect(air).connect(airG).connect(this.center);
    this.center.connect(this.output);

    // mono fallback: notch out the speech band
    this.cut = ac.createGain();
    let node = mid;
    for (const [f, q, g] of [[180, 1.2, -18], [350, 1.1, -30], [700, 1, -34], [1300, 1, -34], [2400, 1, -30], [3800, 1.2, -20]]) {
      const b = ac.createBiquadFilter(); b.type = 'peaking'; b.frequency.value = f; b.Q.value = q; b.gain.value = g;
      node.connect(b); node = b;
    }
    const makeup = ac.createGain(); makeup.gain.value = 1.4;
    node.connect(makeup).connect(this.cut);
    this.cut.connect(this.output);

    this.set('original', true);
  }
  set(mode, stereo = true) {
    const m = mode === 'center' && !stereo ? 'cut' : mode;
    const t = this.ac.currentTime;
    this.orig.gain.setTargetAtTime(m === 'original' ? 1 : 0, t, 0.015);
    this.center.gain.setTargetAtTime(m === 'center' ? 1 : 0, t, 0.015);
    this.cut.gain.setTargetAtTime(m === 'cut' ? 1 : 0, t, 0.015);
    this.mode = m;
  }
}

// Wires a <video> through the remover into `dest` (speakers by default).
export class VideoRoute {
  constructor(video, dest) {
    const ac = audioCtx();
    this.ac = ac;
    this.src = ac.createMediaElementSource(video);
    this.remover = new Remover(ac);
    this.backing = ac.createGain();
    this.voice = ac.createGain();
    this.out = ac.createGain();
    this.analyser = ac.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.75;
    this.src.connect(this.remover.input);
    this.remover.output.connect(this.backing).connect(this.out);
    this.voice.connect(this.out);
    this.voice.connect(this.analyser);
    this.out.connect(dest || ac.destination);
  }
}

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; this.t0 = 0; this.on = true;
    this.port.onmessage = e => { this.on = e.data; }; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !this.on) return true;
    if (this.n === 0) this.t0 = currentFrame;
    this.buf.set(ch, this.n); this.n += ch.length;
    if (this.n >= this.buf.length) { this.port.postMessage({ t0: this.t0, d: this.buf }, [this.buf.buffer]); this.buf = new Float32Array(2048); this.n = 0; }
    return true;
  }
}
registerProcessor('cv-tap', Tap);`;

export class Mic {
  constructor() {
    this.stream = null;
    this.chunks = [];
    this.recording = false;
    this.analyser = null;
  }
  get ok() { return !!this.stream && this.stream.getAudioTracks().some(t => t.readyState === 'live'); }
  async open() {
    if (this.ok) return;
    const ac = audioCtx();
    const dev = prefs.get('micId', '');
    const aec = prefs.get('aec', true);
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: dev ? { ideal: dev } : undefined,
        echoCancellation: aec, noiseSuppression: aec, autoGainControl: false, channelCount: 1,
      },
    });
    if (!this.tapLoaded) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ac.audioWorklet.addModule(url);
      this.tapLoaded = true;
    }
    this.source = ac.createMediaStreamSource(this.stream);
    this.analyser = ac.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    this.node = new AudioWorkletNode(ac, 'cv-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    this.node.port.onmessage = e => { if (this.recording) this.chunks.push(e.data); };
    const sink = ac.createGain(); sink.gain.value = 0;
    this.source.connect(this.analyser);
    this.source.connect(this.node).connect(sink).connect(ac.destination);
    const s = this.stream.getAudioTracks()[0].getSettings();
    this.inputLatency = typeof s.latency === 'number' ? s.latency : 0.015;
  }
  close() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    try { this.source && this.source.disconnect(); this.node && this.node.disconnect(); } catch {}
    this.stream = null;
  }
  start() { this.chunks = []; this.recording = true; }
  stop() { this.recording = false; return this.chunks; }
  // Pull [from, from+dur) in context seconds out of the captured chunks.
  slice(chunks, from, dur) {
    const sr = audioCtx().sampleRate;
    const n = Math.round(dur * sr);
    const out = new Float32Array(n);
    const f0 = Math.round(from * sr);
    for (const c of chunks) {
      const a = c.t0 - f0;
      if (a + c.d.length <= 0 || a >= n) continue;
      const s = Math.max(0, -a), e = Math.min(c.d.length, n - a);
      out.set(c.d.subarray(s, e), a + s);
    }
    return out;
  }
}
export const mic = new Mic();

// Maps "what the viewer hears right now" onto AudioContext time, so the mic
// capture and voice playback line up with the picture.
export function heardCtxTime(perfNow) {
  const ac = audioCtx();
  if (ac.getOutputTimestamp) {
    const ts = ac.getOutputTimestamp();
    if (ts.contextTime > 0 && ts.performanceTime > 0) return ts.contextTime + (perfNow - ts.performanceTime) / 1000;
  }
  return ac.currentTime - (ac.outputLatency || ac.baseLatency || 0) + (perfNow - performance.now()) / 1000;
}

export function frameClock(video, cb) {
  let stop = false;
  if (video.requestVideoFrameCallback) {
    const loop = (now, meta) => { if (stop) return; cb(meta.expectedDisplayTime || now, meta.mediaTime); video.requestVideoFrameCallback(loop); };
    video.requestVideoFrameCallback(loop);
  } else {
    const loop = () => { if (stop) return; cb(performance.now(), video.currentTime); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  return () => { stop = true; };
}

export async function listMics() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'audioinput');
  } catch { return []; }
}
