import { h, $, fmtTime, fmtBytes, toast, prefs, clamp } from './util.js';
import { decodeAudio, voiceDb, detectCuts, speechSpans, buildBoundaries, clipsFromBoundaries, clipEnvelope, thumbnails } from './analyze.js';
import { transcribe, linesFor, relineText } from './asr.js';
import { Stage } from './stage.js';
import { audioCtx } from './audio.js';

// Upload -> find cuts -> group into clips -> write the script -> pick clips.
export class Studio {
  constructor({ mode = 'solo', onDone, onProgress, onCancel }) {
    this.mode = mode;
    this.onDone = onDone;
    this.onProgress = onProgress || (() => {});
    this.onCancel = onCancel;
    this.stage = new Stage();
    this.clips = [];
    this.words = null;
    this.asrState = 'idle';
    this.abort = new AbortController();
    this.el = h('section', { class: 'screen studio' });
    this.renderPick();
  }

  destroy() { this.abort.abort(); this.stage.destroy(); if (this.src && this.mode !== 'host') URL.revokeObjectURL(this.src); }

  renderPick() {
    const input = h('input', { type: 'file', accept: 'video/*,.mkv,.mov,.m4v', hidden: true, onchange: () => input.files[0] && this.useFile(input.files[0]) });
    const drop = h('label', { class: 'drop' },
      input,
      h('div', { class: 'drop-icon' }, '🎬'),
      h('div', { class: 'drop-title' }, 'Drop a movie clip here'),
      h('div', { class: 'drop-sub' }, 'MP4, MOV, WEBM, MKV — one scene or a whole compilation. Cuts get found automatically.'),
      h('span', { class: 'btn big primary' }, 'Choose video'));
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) this.useFile(f); });
    this.el.replaceChildren(
      h('div', { class: 'studio-head' },
        h('button', { class: 'btn ghost', onclick: () => this.onCancel && this.onCancel() }, '← Back'),
        h('h2', {}, this.mode === 'host' ? 'Pick the clips for your party' : 'Studio')),
      drop,
      h('p', { class: 'fine' }, this.mode === 'host'
        ? 'The video gets uploaded to the room server temporarily so your friends can stream it, and is deleted when the room closes.'
        : 'Solo mode never uploads anything. The video stays on this device.'));
  }

  async useFile(file) {
    if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v|webm|mkv|ogv|avi)$/i.test(file.name)) return toast('That doesn’t look like a video.', 'bad');
    this.file = file;
    this.finishedClips = null;
    this.finishedOnce = false;
    this.words = null;
    this.asrState = 'idle';
    this.cur = null;
    this.src = URL.createObjectURL(file);
    this.stageBusy = true;
    this.renderWork();
    this.onFile && this.onFile(file);
    try { await this.analyse(); } catch (e) {
      console.error(e);
      if (!this.abort.signal.aborted) { toast('Analysis failed: ' + e.message, 'bad'); this.renderPick(); }
    }
  }

  setProgress(stage, p) {
    if (this.progEl) {
      this.progEl.querySelector('.prog-stage').textContent = stage;
      this.progEl.querySelector('.bar i').style.width = (p * 100).toFixed(1) + '%';
    }
    this.onProgress({ stage, pct: Math.round(p * 100) });
  }

  renderWork() {
    this.progEl = h('div', { class: 'prog card' },
      h('div', { class: 'prog-stage' }, 'Warming up…'),
      h('div', { class: 'bar' }, h('i')),
      h('div', { class: 'fine' }, `${this.file.name} · ${fmtBytes(this.file.size)}`));
    this.el.replaceChildren(
      h('div', { class: 'studio-head' },
        h('button', { class: 'btn ghost', onclick: () => { this.abort.abort(); this.abort = new AbortController(); this.renderPick(); } }, '← Other video'),
        h('h2', {}, 'Analysing')),
      this.progEl);
  }

  async analyse() {
    const sig = this.abort.signal;
    this.setProgress('Reading the soundtrack', 0.02);
    try {
      this.audio = await decodeAudio(this.file, p => this.setProgress('Reading the soundtrack', p * 0.12));
      this.vdb = voiceDb(this.audio);
      this.spans = speechSpans(this.vdb);
    } catch (e) {
      console.warn('audio decode failed', e);
      toast('Couldn’t read this file’s audio. Scoring and the auto script won’t work — MP4 (H.264 + AAC) is the safest bet.', 'bad');
      this.audio = null; this.vdb = new Float32Array(0); this.spans = [];
    }
    if (sig.aborted) return;
    const sens = prefs.get('cutSens', 0.5);
    const res = await detectCuts(this.src, { sensitivity: sens, signal: sig, onProgress: p => this.setProgress('Finding the cuts', 0.12 + p * 0.8) });
    if (sig.aborted) return;
    this.duration = res.duration;
    this.cuts = res.cuts;
    this.aspect = res.width && res.height ? res.width / res.height : 16 / 9;
    this.minLen = prefs.get('minLen', 3);
    this.maxLen = prefs.get('maxLen', 20);
    this.rebuild();
    this.setProgress('Done', 1);
    this.renderEditor();
    this.makeThumbs();
    if (prefs.get('autoScript', true) && this.audio) this.runAsr();
  }

  rebuild(keepBounds) {
    const bounds = keepBounds || buildBoundaries(this.cuts, this.duration, this.spans, { minLen: this.minLen, maxLen: this.maxLen });
    this.bounds = [...new Set(bounds.map(b => Math.round(b * 1000) / 1000))].sort((a, b) => a - b);
    const old = this.clips || [];
    this.clips = clipsFromBoundaries(this.bounds, this.duration, this.spans).map(c => {
      const prev = old.find(o => Math.abs(o.start - c.start) < 0.05 && Math.abs(o.end - c.end) < 0.05);
      return prev ? prev : { ...c, lines: [], thumb: '', stereo: this.audio ? this.audio.stereo : true };
    });
    for (const c of this.clips) if (!c.edited && this.words) c.lines = linesFor(this.words, c.start, c.end);
  }

  async makeThumbs() {
    const want = this.clips.filter(c => !c.thumb);
    if (!want.length) return;
    try {
      await thumbnails(this.src, want.map(c => Math.min(c.end - 0.05, c.start + Math.min(1, (c.end - c.start) / 3))), (i, url) => {
        want[i].thumb = url;
        const img = this.el.querySelector(`[data-clip="${this.clips.indexOf(want[i])}"] img`);
        if (img) img.src = url;
      });
    } catch (e) { console.warn(e); }
  }

  async runAsr() {
    this.asrState = 'run';
    this.updateAsr('Loading speech model…', 0);
    try {
      this.words = await transcribe(this.audio, this.vdb, { signal: this.abort.signal, onProgress: p => this.updateAsr(p.stage, p.pct) });
      this.asrState = 'done';
      for (const c of this.clips) if (!c.edited) c.lines = linesFor(this.words, c.start, c.end);
      this.updateAsr(`Script ready · ${this.words.length} words`, 1);
      if (this.list) this.renderClips();
      if (this.cur != null) this.select(this.cur, true);
      if (this.finishedOnce) this.finish(true);
    } catch (e) {
      console.error(e);
      this.asrState = 'fail';
      const msg = /fetch|network/i.test(e.message) ? 'couldn\u2019t download the speech model' : e.message.slice(0, 80);
      this.updateAsr(`Auto script failed (${msg}). Type lines by hand or retry.`, 0, true);
      const box = $('.asr-status', this.el);
      if (box && !box.querySelector('button')) box.append(h('button', { class: 'btn tiny', onclick: e2 => { e2.target.remove(); this.runAsr(); } }, 'Retry'));
    }
  }

  updateAsr(text, p, bad) {
    const el = $('.asr-status', this.el);
    if (!el) return;
    el.querySelector('span').textContent = text;
    el.querySelector('.bar i').style.width = (p * 100).toFixed(0) + '%';
    el.classList.toggle('bad', !!bad);
    el.classList.toggle('done', this.asrState === 'done');
  }

  renderEditor() {
    const removal = h('div', { class: 'seg' },
      ...[['original', 'Original'], ['center', 'Voices removed'], ['mute', 'Muted']].map(([k, label]) =>
        h('button', { class: 'seg-b' + (k === (prefs.get('removal', 'center')) ? ' on' : ''), 'data-k': k, onclick: e => {
          prefs.set('removal', k);
          e.target.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target));
        } }, label)));
    const minIn = h('input', { type: 'range', min: 1, max: 10, step: 0.5, value: this.minLen, oninput: e => { minOut.textContent = e.target.value + 's'; }, onchange: e => {
      this.minLen = +e.target.value; prefs.set('minLen', this.minLen); this.rebuild(); this.renderTimeline(); this.renderClips(); this.makeThumbs();
    } });
    const minOut = h('b', {}, this.minLen + 's');
    const maxIn = h('input', { type: 'range', min: 6, max: 60, step: 1, value: this.maxLen, oninput: e => { maxOut.textContent = e.target.value + 's'; }, onchange: e => {
      this.maxLen = +e.target.value; prefs.set('maxLen', this.maxLen); this.rebuild(); this.renderTimeline(); this.renderClips(); this.makeThumbs();
    } });
    const maxOut = h('b', {}, this.maxLen + 's');

    this.timeline = h('div', { class: 'timeline' });
    this.list = h('div', { class: 'clip-list' });
    this.goBtn = h('button', { class: 'btn big primary', onclick: () => this.finish() });

    const asr = h('div', { class: 'asr-status' }, h('span', {}, this.audio ? 'Auto script off' : 'No audio track'), h('div', { class: 'bar thin' }, h('i')));
    const asrBtn = (!prefs.get('autoScript', true) && this.audio)
      ? h('button', { class: 'btn small', onclick: e => { e.target.remove(); this.runAsr(); } }, 'Write script with AI') : null;

    this.el.replaceChildren(
      h('div', { class: 'studio-head' },
        h('button', { class: 'btn ghost', onclick: () => { this.abort.abort(); this.abort = new AbortController(); this.renderPick(); } }, '← Other video'),
        h('h2', {}, this.file.name),
        h('span', { class: 'pill' }, fmtTime(this.duration)),
        this.audio && !this.audio.stereo ? h('span', { class: 'pill warn', title: 'Mono audio: voices get muffled instead of removed' }, 'mono audio') : null),
      h('div', { class: 'studio-grid' },
        h('div', { class: 'studio-left' },
          this.stage.el,
          h('div', { class: 'studio-play' },
            h('button', { class: 'btn', onclick: () => this.preview('original') }, '▶ Original'),
            h('button', { class: 'btn', onclick: () => this.preview(prefs.get('removal', 'center')) }, '▶ How players hear it'),
            h('button', { class: 'btn ghost', onclick: () => this.stage.stopAll() }, '■')),
          this.timeline,
          h('div', { class: 'studio-opts card' },
            h('div', { class: 'opt' }, h('label', {}, 'During recording players hear'), removal),
            h('div', { class: 'opt' }, h('label', {}, 'Shortest clip ', minOut), minIn),
            h('div', { class: 'opt' }, h('label', {}, 'Longest clip ', maxOut), maxIn),
            h('div', { class: 'opt' }, h('label', {}, 'Script'), asr, asrBtn),
            h('p', { class: 'fine' }, 'Tap a tick on the timeline to join or split clips there. Scripts are editable — one line per row.'))),
        h('div', { class: 'studio-right' },
          h('div', { class: 'list-head' },
            h('b', {}, 'Clips'),
            h('button', { class: 'btn tiny ghost', onclick: () => { this.clips.forEach(c => c.on = true); this.renderClips(); } }, 'all'),
            h('button', { class: 'btn tiny ghost', onclick: () => { this.clips.forEach(c => c.on = false); this.renderClips(); } }, 'none'),
            h('button', { class: 'btn tiny ghost', onclick: () => { this.clips.forEach(c => c.on = c.talk > 0.8); this.renderClips(); } }, 'with dialogue')),
          this.list,
          h('div', { class: 'studio-go' }, this.goBtn))));
    this.renderTimeline();
    this.renderClips();
    if (this.asrState === 'done') this.updateAsr(`Script ready · ${this.words.length} words`, 1);
    const first = this.clips.findIndex(c => c.on);
    this.select(first < 0 ? 0 : first);
  }

  renderTimeline() {
    const tl = this.timeline;
    if (!tl) return;
    const D = this.duration;
    tl.replaceChildren();
    const segs = h('div', { class: 'tl-segs' });
    this.clips.forEach((c, i) => segs.append(h('div', {
      class: 'tl-seg' + (c.on ? ' on' : '') + (i === this.cur ? ' cur' : ''),
      style: { left: (c.start / D * 100) + '%', width: ((c.end - c.start) / D * 100) + '%' },
      title: `Clip ${i + 1}`, onclick: () => this.select(i),
    })));
    const speech = h('div', { class: 'tl-speech' });
    for (const [a, b] of this.spans) speech.append(h('i', { style: { left: (a / D * 100) + '%', width: ((b - a) / D * 100) + '%' } }));
    const ticks = h('div', { class: 'tl-ticks' });
    const all = [...new Set([...this.cuts.map(c => c.t), ...this.bounds.filter(b => b > 0)])];
    for (const t of all) {
      const active = this.bounds.some(b => Math.abs(b - t) < 0.01);
      ticks.append(h('button', {
        class: 'tl-tick' + (active ? ' on' : ''), style: { left: (t / D * 100) + '%' }, title: (active ? 'Join at ' : 'Split at ') + fmtTime(t),
        onclick: () => {
          const b = active ? this.bounds.filter(x => Math.abs(x - t) >= 0.01) : [...this.bounds, t];
          this.rebuild(b); this.renderTimeline(); this.renderClips(); this.makeThumbs();
        },
      }));
    }
    tl.append(segs, speech, ticks);
  }

  renderClips() {
    this.list.replaceChildren(...this.clips.map((c, i) => {
      const ta = h('textarea', {
        rows: Math.max(2, Math.min(5, c.lines.length || 2)), placeholder: this.asrState === 'run' ? 'Listening…' : 'Type the line(s) here',
        value: c.lines.map(l => l.text).join('\n'),
        onchange: e => { c.lines = relineText(c.lines, e.target.value, c.end - c.start); c.edited = true; if (i === this.cur) this.select(i, true); },
        onclick: e => e.stopPropagation(),
      });
      return h('div', { class: 'clip-card' + (c.on ? ' on' : '') + (i === this.cur ? ' cur' : ''), 'data-clip': i, onclick: () => this.select(i) },
        h('div', { class: 'clip-thumb' }, h('img', { src: c.thumb || '', alt: '' }), h('span', {}, (c.end - c.start).toFixed(1) + 's')),
        h('div', { class: 'clip-body' },
          h('div', { class: 'clip-top' },
            h('b', {}, `#${i + 1}`), h('span', { class: 'fine' }, `${fmtTime(c.start)} – ${fmtTime(c.end)}`),
            c.talk < 0.8 ? h('span', { class: 'pill dim' }, 'no dialogue?') : null,
            h('label', { class: 'switch', onclick: e => e.stopPropagation() },
              h('input', { type: 'checkbox', checked: c.on, onchange: e => { c.on = e.target.checked; e.target.closest('.clip-card').classList.toggle('on', c.on); this.renderTimeline(); this.updateGo(); } }),
              h('i'))),
          ta,
          h('div', { class: 'clip-nudge' },
            h('span', { class: 'fine' }, 'start'),
            h('button', { class: 'btn tiny ghost', onclick: e => { e.stopPropagation(); this.nudge(i, 'start', -0.1); } }, '−'),
            h('button', { class: 'btn tiny ghost', onclick: e => { e.stopPropagation(); this.nudge(i, 'start', 0.1); } }, '+'),
            h('span', { class: 'fine' }, 'end'),
            h('button', { class: 'btn tiny ghost', onclick: e => { e.stopPropagation(); this.nudge(i, 'end', -0.1); } }, '−'),
            h('button', { class: 'btn tiny ghost', onclick: e => { e.stopPropagation(); this.nudge(i, 'end', 0.1); } }, '+'))));
    }));
    this.updateGo();
  }

  nudge(i, key, d) {
    const c = this.clips[i];
    c[key] = clamp(+(c[key] + d).toFixed(3), 0, this.duration);
    if (c.end - c.start < 0.8) c[key] -= d;
    if (!c.edited && this.words) c.lines = linesFor(this.words, c.start, c.end);
    this.renderClips(); this.renderTimeline(); this.select(i, true);
  }

  updateGo() {
    const n = this.clips.filter(c => c.on).length;
    this.goBtn.textContent = n ? (this.mode === 'host' ? `Use ${n} clip${n > 1 ? 's' : ''}` : `Play ${n} clip${n > 1 ? 's' : ''} →`) : 'Pick at least one clip';
    this.goBtn.disabled = !n;
  }

  withEnv(c) {
    return { ...c, env: this.vdb.length ? clipEnvelope(this.vdb, c.start, c.end, c.lines) : '' };
  }

  async select(i, force) {
    if (i === this.cur && !force) return;
    this.cur = i;
    this.el.querySelectorAll('.clip-card').forEach(el => el.classList.toggle('cur', +el.dataset.clip === i));
    this.el.querySelectorAll('.tl-seg').forEach((el, k) => el.classList.toggle('cur', k === i));
    const c = this.clips[i];
    if (!c) return;
    try { await this.stage.load(this.src, this.withEnv(c)); } catch (e) { console.warn(e); }
  }

  async preview(removal) {
    audioCtx();
    if (this.cur == null) return;
    await this.select(this.cur, true);
    try { await this.stage.play({ removal }); } catch (e) { toast('Playback blocked: ' + e.message, 'bad'); }
  }

  finish(auto) {
    if (!auto) this.stage.stopAll();
    this.finishedOnce = true;
    const clips = this.clips.filter(c => c.on).map(c => {
      const o = this.withEnv(c);
      return { start: o.start, end: o.end, lines: o.lines, env: o.env, thumb: o.thumb, stereo: o.stereo };
    });
    this.onDone(clips, { file: this.file, src: this.src, aspect: this.aspect, asrPending: this.asrState === 'run' }, !!auto);
  }
}
