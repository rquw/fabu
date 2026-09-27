import { audioCtx, VideoRoute, heardCtxTime, frameClock } from './audio.js';
import { once, seekTo, sleep, clamp } from './util.js';

export function pickMime() {
  const opts = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs="avc1,opus"', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  ];
  if (!window.MediaRecorder) return null;
  return opts.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

function wrapWords(g, words, maxW) {
  const rows = [[]];
  let w = 0;
  for (const word of words) {
    const ww = g.measureText(word.w + ' ').width;
    if (w + ww > maxW && rows[rows.length - 1].length) { rows.push([]); w = 0; }
    rows[rows.length - 1].push({ ...word, width: ww });
    w += ww;
  }
  return rows;
}

// Renders the dub(s) in real time, entirely on this device. Nothing uploads.
export async function renderReel({ src, segments, title = 'CHOICER VOICER', subtitle = '', onProgress, signal, preview }) {
  const mime = pickMime();
  if (mime == null) throw new Error('This browser cannot record video. Try Chrome, Edge or Safari.');
  const ac = audioCtx();
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.playsInline = true;
  video.preload = 'auto';
  video.src = src;
  Object.assign(video.style, { position: 'fixed', left: '-10px', top: '-10px', width: '4px', height: '4px', opacity: '0.01' });
  document.body.append(video);
  if (video.readyState < 1) await once(video, 'loadedmetadata', 60000);

  const dest = ac.createMediaStreamDestination();
  const route = new VideoRoute(video, dest);
  const ar = (video.videoWidth / video.videoHeight) || 16 / 9;
  const W = 1280, H = Math.round(W / ar / 2) * 2;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  if (preview) { preview.innerHTML = ''; canvas.className = 'render-preview'; preview.append(canvas); }

  let scene = { kind: 'card', big: title, small: subtitle };
  let seg = null;
  const fontBig = Math.round(H * 0.1), fontSmall = Math.round(H * 0.04), fontSub = Math.round(H * 0.052);

  const paint = () => {
    g.fillStyle = '#0b0a12';
    g.fillRect(0, 0, W, H);
    if (scene.kind === 'card') {
      const grd = g.createRadialGradient(W / 2, H * 0.4, 10, W / 2, H * 0.4, W * 0.7);
      grd.addColorStop(0, '#3a1152'); grd.addColorStop(1, '#0b0a12');
      g.fillStyle = grd; g.fillRect(0, 0, W, H);
      g.textAlign = 'center';
      g.fillStyle = '#ffd23f';
      g.font = `800 ${fontBig}px "Bricolage Grotesque", system-ui, sans-serif`;
      g.fillText(scene.big, W / 2, H * 0.48);
      g.fillStyle = scene.color || '#ffffff';
      g.font = `600 ${fontSmall}px "Bricolage Grotesque", system-ui, sans-serif`;
      g.fillText(scene.small || '', W / 2, H * 0.48 + fontSmall * 1.8);
      return;
    }
    g.drawImage(video, 0, 0, W, H);
    const t = video.currentTime - seg.clip.start;
    const lines = seg.clip.lines || [];
    const cur = lines.find(l => t >= l.t0 - 0.3 && t < l.t1 + 0.25);
    if (cur) {
      g.font = `800 ${fontSub}px "Bricolage Grotesque", system-ui, sans-serif`;
      const rows = wrapWords(g, cur.words, W * 0.84);
      rows.forEach((row, ri) => {
        const rw = row.reduce((a, b) => a + b.width, 0);
        let x = (W - rw) / 2;
        const y = H - fontSub * (rows.length - ri) - H * 0.05;
        for (const word of row) {
          const p = clamp((t - word.t0) / Math.max(0.05, word.t1 - word.t0));
          g.textAlign = 'left';
          g.lineWidth = fontSub * 0.18; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineJoin = 'round';
          g.strokeText(word.w, x, y);
          g.fillStyle = '#ffffff'; g.fillText(word.w, x, y);
          if (p > 0) {
            g.save(); g.beginPath(); g.rect(x, y - fontSub, g.measureText(word.w).width * p, fontSub * 1.4); g.clip();
            g.fillStyle = '#ffd23f'; g.fillText(word.w, x, y); g.restore();
          }
          x += word.width;
        }
      });
    }
    // tag
    const tag = seg.name ? `🎙 ${seg.name}` : '';
    g.font = `700 ${fontSmall}px "Bricolage Grotesque", system-ui, sans-serif`;
    g.textAlign = 'left';
    if (tag) {
      const tw = g.measureText(tag).width;
      g.fillStyle = 'rgba(11,10,18,0.7)';
      g.beginPath(); g.roundRect(H * 0.03, H * 0.03, tw + fontSmall, fontSmall * 1.7, fontSmall * 0.85); g.fill();
      g.fillStyle = seg.color || '#ffd23f';
      g.fillText(tag, H * 0.03 + fontSmall / 2, H * 0.03 + fontSmall * 1.2);
    }
    g.textAlign = 'right';
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.font = `800 ${Math.round(fontSmall * 0.8)}px "Bricolage Grotesque", system-ui, sans-serif`;
    g.fillText('CHOICER VOICER', W - H * 0.03, H * 0.03 + fontSmall);
    if (scene.kind === 'score') {
      g.fillStyle = 'rgba(11,10,18,0.55)'; g.fillRect(0, 0, W, H);
      g.textAlign = 'center';
      g.fillStyle = '#ffd23f';
      g.font = `800 ${fontBig * 1.3}px "Bricolage Grotesque", system-ui, sans-serif`;
      g.fillText(scene.big, W / 2, H * 0.52);
      g.fillStyle = '#fff';
      g.font = `700 ${fontSmall}px "Bricolage Grotesque", system-ui, sans-serif`;
      g.fillText(scene.small, W / 2, H * 0.52 + fontSmall * 1.8);
    }
  };

  const stream = canvas.captureStream(30);
  dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 160_000 });
  const parts = [];
  rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  const iv = setInterval(paint, 1000 / 30);
  paint();

  const total = segments.reduce((a, s) => a + (s.clip.end - s.clip.start) + 2.2, 3.5);
  let doneT = 0;
  const tick = add => { doneT += add; onProgress && onProgress(clamp(doneT / total)); };

  try {
    rec.start(1000);
    await sleep(1600); tick(1.6);
    for (const s of segments) {
      if (signal && signal.aborted) throw new Error('cancelled');
      seg = s;
      scene = { kind: 'card', big: s.name ? s.name.toUpperCase() : 'TAKE', small: s.caption || '', color: s.color };
      await Promise.all([seekTo(video, s.clip.start), sleep(1000)]);
      tick(1);
      route.remover.set(s.removal || 'center', s.clip.stereo !== false);
      scene = { kind: 'video' };
      const dur = s.clip.end - s.clip.start;
      let started = false, ended;
      const done = new Promise(r => { ended = r; });
      let last = 0;
      const stop = frameClock(video, (P, M) => {
        if (s.voice && !started) {
          started = true;
          const node = ac.createBufferSource();
          node.buffer = s.voice;
          const gain = ac.createGain(); gain.gain.value = 1.4;
          node.connect(gain).connect(route.out);
          const when = heardCtxTime(P) - (M - s.clip.start);
          const now = ac.currentTime + 0.03;
          if (when >= now) node.start(when); else node.start(now, now - when);
          s._node = node;
        }
        const pos = M - s.clip.start;
        if (pos > last) { tick(Math.min(pos - last, 0.5)); last = pos; }
        if (M >= s.clip.end - 0.02) ended();
      });
      const guard = setTimeout(ended, (dur + 3) * 1000);
      await video.play();
      await done;
      clearTimeout(guard);
      stop();
      video.pause();
      if (s._node) try { s._node.stop(); } catch {}
      if (s.score != null) {
        scene = { kind: 'score', big: `${s.score}%`, small: s.grade || '' };
        await sleep(1200);
      }
      tick(1.2);
    }
    scene = { kind: 'card', big: title, small: 'made with Choicer Voicer' };
    await sleep(1500);
    tick(1.5);
    rec.stop();
    await stopped;
  } finally {
    clearInterval(iv);
    try { if (rec.state !== 'inactive') rec.stop(); } catch {}
    try { route.out.disconnect(); } catch {}
    video.pause(); video.removeAttribute('src'); video.load(); video.remove();
  }
  const type = (mime || 'video/webm').split(';')[0];
  return new Blob(parts, { type });
}
