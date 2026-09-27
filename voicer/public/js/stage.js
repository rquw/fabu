import { h, clamp, once, seekTo, sleep, prefs } from './util.js';
import { audioCtx, VideoRoute, mic, heardCtxTime, frameClock } from './audio.js';
import { refEnvelope } from './score.js';
import { FPS } from './analyze.js';
import { sfx } from './sfx.js';

// The screen: video + karaoke script + visualizer + countdown.
export class Stage {
  constructor() {
    this.video = h('video', { playsInline: true, preload: 'auto', crossOrigin: 'anonymous', disablePictureInPicture: true });
    this.video.setAttribute('playsinline', '');
    this.subs = h('div', { class: 'subs' });
    this.count = h('div', { class: 'count' });
    this.badge = h('div', { class: 'stage-badge' });
    this.canvas = h('canvas', { class: 'viz' });
    this.frame = h('div', { class: 'stage-frame' }, this.video, this.subs, this.count, this.badge);
    this.el = h('div', { class: 'stage' }, this.frame, this.canvas);
    this.route = null;
    this.clip = null;
    this.src = '';
    this.userEnv = [];
    this.mode = 'idle';
    this.token = 0;
    this.lastLine = -1;
    this.running = true;
    this.draw = this.draw.bind(this);
    requestAnimationFrame(this.draw);
    this.floor = -60; this.peak = -20;
  }

  ensureRoute() {
    if (!this.route) this.route = new VideoRoute(this.video);
    return this.route;
  }

  setBadge(text, color) {
    this.badge.textContent = text || '';
    this.badge.style.display = text ? '' : 'none';
    if (color) this.badge.style.setProperty('--c', color);
  }

  async load(src, clip) {
    if (this.src !== src) {
      this.src = src;
      this.video.src = src;
      if (this.video.readyState < 1) await once(this.video, 'loadedmetadata', 60000);
    }
    if (clip) await this.cue(clip);
  }

  async cue(clip) {
    this.stopAll();
    this.clip = clip;
    this.ref = refEnvelope(clip);
    this.userEnv = [];
    this.renderSubs(0, true);
    await seekTo(this.video, clip.start);
    if (this.video.readyState < 3) await Promise.race([once(this.video, 'canplay', 20000).catch(() => {}), sleep(8000)]);
  }

  stopAll() {
    this.token++;
    this.video.pause();
    if (this.voiceSrc) { try { this.voiceSrc.stop(); } catch {} this.voiceSrc = null; }
    this.count.className = 'count';
    this.mode = 'idle';
  }

  // Plays the current clip once. opts: removal, stereo, voice (AudioBuffer), record (bool)
  async play(opts = {}) {
    const clip = this.clip;
    if (!clip) return null;
    const my = ++this.token;
    const ac = audioCtx();
    const route = this.ensureRoute();
    route.remover.set(opts.removal || 'original', clip.stereo !== false);
    route.backing.gain.value = opts.backing ?? 1;
    await seekTo(this.video, clip.start);
    if (my !== this.token) return null;

    if (opts.countdown) {
      this.mode = 'count';
      for (const n of [3, 2, 1]) {
        if (my !== this.token) return null;
        this.count.textContent = n;
        this.count.className = 'count on';
        void this.count.offsetWidth;
        this.count.classList.add('pop');
        sfx.tick();
        await sleep(900);
        this.count.classList.remove('pop');
      }
      this.count.textContent = 'GO';
      this.count.className = 'count on pop go';
      sfx.go();
      setTimeout(() => { if (this.count.textContent === 'GO') this.count.className = 'count'; }, 600);
    }
    if (my !== this.token) return null;

    this.mode = opts.record ? 'record' : opts.voice ? 'dub' : 'watch';
    this.userEnv = [];
    const dur = clip.end - clip.start;
    const outLat = ac.outputLatency || ac.baseLatency || 0.02;
    const cal = prefs.get('latency', 0) / 1000;
    const estimates = [];
    let voiceStarted = false;

    if (opts.record) mic.start();
    let ended;
    const done = new Promise(r => { ended = r; });
    const stopClock = frameClock(this.video, (P, M) => {
      if (my !== this.token) return;
      const heard = heardCtxTime(P);
      if (M >= clip.start - 0.01 && M < clip.end) estimates.push(heard - (M - clip.start));
      if (opts.voice && !voiceStarted && estimates.length) {
        voiceStarted = true;
        const src = ac.createBufferSource();
        src.buffer = opts.voice;
        src.connect(route.voice);
        route.voice.gain.value = opts.voiceGain ?? 1.4;
        const when = heard - (M - clip.start) + cal * 0;
        const now = ac.currentTime + 0.03;
        if (when >= now) src.start(when);
        else src.start(now, now - when);
        this.voiceSrc = src;
      }
      if (M >= clip.end - 0.02) ended();
    });
    const onEnded = () => ended();
    this.video.addEventListener('ended', onEnded);
    try { await this.video.play(); } catch (e) { stopClock(); this.video.removeEventListener('ended', onEnded); throw e; }
    const guard = setTimeout(ended, (dur + 3) * 1000);
    const wait = setInterval(() => { if (my !== this.token) ended(); }, 100);
    await done;
    clearTimeout(guard); clearInterval(wait);
    stopClock();
    this.video.removeEventListener('ended', onEnded);
    if (my === this.token) this.video.pause();
    if (this.voiceSrc) { const v = this.voiceSrc; setTimeout(() => { try { v.stop(); } catch {} }, 200); this.voiceSrc = null; }
    this.mode = 'idle';
    if (!opts.record) return my === this.token ? {} : null;

    await sleep(250);
    const chunks = mic.stop();
    if (my !== this.token) return null;
    estimates.sort((a, b) => a - b);
    const heard0 = estimates.length ? estimates[estimates.length >> 1] : null;
    if (heard0 == null) return null;
    const micT0 = heard0 + outLat + (mic.inputLatency || 0.015) + cal;
    const pcm = mic.slice(chunks, micT0, dur);
    return { pcm, sr: ac.sampleRate };
  }

  // ---- karaoke ----
  renderSubs(t, force) {
    const clip = this.clip;
    const lines = clip && clip.lines || [];
    let idx = lines.findIndex(l => t < l.t1 + 0.25);
    if (idx < 0) idx = lines.length;
    if (idx !== this.lastLine || force) {
      this.lastLine = idx;
      this.subs.innerHTML = '';
      const cur = lines[idx], next = lines[idx + 1];
      if (cur) this.subs.append(h('div', { class: 'line cur' }, cur.words.map(w => h('span', { class: 'w' }, w.w + ' '))));
      if (next) this.subs.append(h('div', { class: 'line next' }, next.text));
    }
    const cur = lines[idx];
    if (!cur) return;
    const spans = this.subs.querySelectorAll('.line.cur .w');
    cur.words.forEach((w, i) => {
      const p = clamp((t - w.t0) / Math.max(0.05, w.t1 - w.t0));
      if (spans[i]) spans[i].style.setProperty('--p', (p * 100).toFixed(1) + '%');
    });
    this.subs.classList.toggle('soon', t < cur.t0 - 0.05);
  }

  // ---- visualizer ----
  draw() {
    if (!this.running) return;
    requestAnimationFrame(this.draw);
    const c = this.canvas;
    const w = c.clientWidth, hgt = c.clientHeight;
    if (!w || !hgt) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const clip = this.clip;
    if (!clip) return;
    const dur = clip.end - clip.start;
    const t = clamp(this.video.currentTime - clip.start, 0, dur);
    if (this.mode !== 'idle' || this.video.paused === false) this.renderSubs(t);
    else if (this.mode === 'idle') this.renderSubs(t);

    // spectrum bars behind everything
    const an = this.mode === 'record' && mic.analyser ? mic.analyser : this.route && (this.mode === 'dub' ? this.route.analyser : null);
    if (an) {
      const bins = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(bins);
      const bars = Math.max(24, Math.floor(w / 9));
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        const lo = Math.floor(Math.pow(i / bars, 1.8) * bins.length * 0.5), hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / bars, 1.8) * bins.length * 0.5));
        let v = 0;
        for (let k = lo; k < hi; k++) v = Math.max(v, bins[k]);
        const bh = (v / 255) * hgt * 0.95;
        const hue = 320 + (i / bars) * 90;
        g.fillStyle = `hsla(${hue % 360}, 95%, 62%, 0.22)`;
        g.fillRect(i * bw + 1, hgt - bh, bw - 2, bh);
      }
    }

    // target shape
    const ref = this.ref || [];
    const mid = hgt / 2;
    const xs = i => (i / (dur * FPS)) * w;
    g.beginPath();
    g.moveTo(0, mid);
    for (let i = 0; i < ref.length; i++) g.lineTo(xs(i), mid - ref[i] * mid * 0.85);
    for (let i = ref.length - 1; i >= 0; i--) g.lineTo(xs(i), mid + ref[i] * mid * 0.85);
    g.closePath();
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.fill();

    // your shape (live while recording, or from the last take)
    if (this.mode === 'record' && mic.analyser && !this.video.paused) {
      const buf = new Float32Array(mic.analyser.fftSize);
      mic.analyser.getFloatTimeDomainData(buf);
      let e = 0;
      for (const v of buf) e += v * v;
      const db = 10 * Math.log10(e / buf.length + 1e-10);
      this.floor = Math.min(this.floor + 0.02, db);
      this.peak = Math.max(this.peak - 0.03, db, this.floor + 25);
      const v = clamp((db - this.floor - 6) / (this.peak - this.floor));
      const idx = Math.floor(t * FPS);
      for (let i = this.userEnv.length; i <= idx; i++) this.userEnv[i] = v;
    }
    const ue = this.userEnv;
    if (ue.length) {
      g.beginPath();
      g.moveTo(0, mid);
      for (let i = 0; i < ue.length; i++) g.lineTo(xs(i), mid - (ue[i] || 0) * mid * 0.85);
      for (let i = ue.length - 1; i >= 0; i--) g.lineTo(xs(i), mid + (ue[i] || 0) * mid * 0.85);
      g.closePath();
      const grd = g.createLinearGradient(0, 0, w, 0);
      grd.addColorStop(0, 'rgba(255,62,127,0.85)');
      grd.addColorStop(1, 'rgba(255,210,63,0.85)');
      g.fillStyle = grd;
      g.fill();
    }

    // playhead
    const px = (t / dur) * w;
    g.fillStyle = this.mode === 'record' ? '#ff3e7f' : '#ffd23f';
    g.fillRect(px - 1, 0, 2, hgt);
    g.beginPath(); g.arc(px, 4, 4, 0, Math.PI * 2); g.fill();
  }

  showTake(env) { this.userEnv = Array.from(env || []); }

  destroy() { this.running = false; this.stopAll(); }
}
