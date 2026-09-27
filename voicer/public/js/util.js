export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function fmtTime(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
}

export function toast(text, kind = '') {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: 'toast ' + kind }, text);
  box.append(t);
  setTimeout(() => t.classList.add('out'), 3800);
  setTimeout(() => t.remove(), 4300);
}

export function u8ToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToU8(b64) {
  const s = atob(b64 || '');
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export function once(el, ev, timeout = 0) {
  return new Promise((resolve, reject) => {
    let t;
    const fn = e => { clearTimeout(t); el.removeEventListener(ev, fn); resolve(e); };
    el.addEventListener(ev, fn);
    if (timeout) t = setTimeout(() => { el.removeEventListener(ev, fn); reject(new Error(ev + ' timeout')); }, timeout);
  });
}

export async function seekTo(video, t) {
  if (Math.abs(video.currentTime - t) < 0.002 && video.readyState >= 2) return;
  const p = once(video, 'seeked', 15000);
  video.currentTime = t;
  await p;
}

const store = (() => { try { return window.localStorage; } catch { return null; } })();
export const prefs = {
  get(k, d) { try { const v = store && store.getItem('cv.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { store && store.setItem('cv.' + k, JSON.stringify(v)); } catch {} },
};

export const isMobile = matchMedia('(pointer: coarse)').matches;

export function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}

// seeded rng so every client sees the same judges
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
export function hashStr(str) {
  let h1 = 2166136261;
  for (let i = 0; i < str.length; i++) { h1 ^= str.charCodeAt(i); h1 = Math.imul(h1, 16777619); }
  return h1 >>> 0;
}

// MediaRecorder-made webm files often report Infinity until you seek to the end.
export async function fixDuration(video) {
  if (video.readyState < 1) await once(video, 'loadedmetadata', 30000);
  if (isFinite(video.duration) && video.duration > 0) return video.duration;
  await new Promise(resolve => {
    const done = () => { if (isFinite(video.duration)) { video.removeEventListener('durationchange', done); video.removeEventListener('timeupdate', done); resolve(); } };
    video.addEventListener('durationchange', done);
    video.addEventListener('timeupdate', done);
    video.currentTime = 1e7;
    setTimeout(resolve, 8000);
  });
  await seekTo(video, 0).catch(() => {});
  return video.duration;
}
