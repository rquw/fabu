import { h, sleep } from './util.js';
import { JUDGES } from './score.js';
import { sfx } from './sfx.js';

export const FACES = ['🦊', '🐸', '🐼', '🦁', '🐙', '👽', '🤖', '🐷', '🦄', '🐵', '🐧', '🐯', '💀', '🤠', '🧛', '🐶'];

export function avatar(p, size = '') {
  return h('div', { class: 'avatar ' + size, style: { '--c': p.color || '#ffd23f' } }, FACES[p.face % FACES.length] || '🙂');
}

function judgeFace(j) {
  const hat = {
    bow: '<path d="M30 12 l-12 -8 v16 z M30 12 l12 -8 v16 z" fill="#ff8fab"/><circle cx="30" cy="12" r="4" fill="#ff4d6d"/>',
    top: '<rect x="18" y="-6" width="24" height="18" rx="2" fill="#222"/><rect x="12" y="10" width="36" height="5" rx="2" fill="#222"/><rect x="18" y="6" width="24" height="3" fill="#ff4d6d"/>',
    cap: '<path d="M12 18 q18 -22 36 0 z" fill="#1d7c55"/><rect x="36" y="15" width="18" height="4" rx="2" fill="#1d7c55"/>',
    hair: '<circle cx="18" cy="14" r="9" fill="#ddd"/><circle cx="30" cy="9" r="10" fill="#eee"/><circle cx="42" cy="14" r="9" fill="#ddd"/>',
    beret: '<ellipse cx="30" cy="14" rx="20" ry="7" fill="#222"/><rect x="29" y="4" width="2" height="5" fill="#222"/>',
  }[j.hat];
  return `<svg viewBox="0 -8 60 70" class="jface"><circle cx="30" cy="36" r="22" fill="${j.color}"/>${hat}
    <g class="eyes"><circle cx="22" cy="33" r="3.2" fill="#111"/><circle cx="38" cy="33" r="3.2" fill="#111"/></g>
    <path class="mouth" d="M21 46 q9 0 18 0" stroke="#111" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`;
}

export function judgePanel() {
  const el = h('div', { class: 'judges' }, JUDGES.map(j => h('div', { class: 'judge' },
    h('div', { class: 'bubble' }),
    h('div', { class: 'jwrap', html: judgeFace(j) }),
    h('div', { class: 'paddle' }),
    h('div', { class: 'jname' }, j.name))));
  return el;
}

export async function revealJudges(panel, score, { fast = false } = {}) {
  const cards = [...panel.querySelectorAll('.judge')];
  cards.forEach(c => { c.className = 'judge'; c.querySelector('.bubble').textContent = ''; c.querySelector('.paddle').textContent = ''; });
  if (!fast) { sfx.drum(10); await sleep(650); }
  for (let i = 0; i < cards.length; i++) {
    const j = score.judges[i] || { yes: false, line: '' };
    const c = cards[i];
    c.classList.add('show', j.yes ? 'yes' : 'no');
    c.querySelector('.paddle').textContent = j.yes ? '★' : '✗';
    c.querySelector('.bubble').textContent = j.line;
    c.querySelector('.mouth').setAttribute('d', j.yes ? 'M20 44 q10 10 20 0' : 'M20 49 q10 -8 20 0');
    if (!fast) { j.yes ? sfx.yes() : sfx.no(); await sleep(420); }
  }
}

export function gauge() {
  const el = h('div', { class: 'gauge' },
    h('div', { class: 'gauge-ring', html: '<svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="track"/><circle cx="60" cy="60" r="52" class="fill"/></svg>' }),
    h('div', { class: 'gauge-num' }, h('b', {}, '0'), h('small', {}, '%')),
    h('div', { class: 'gauge-grade' }, ''));
  return el;
}

export async function setGauge(el, score, { fast = false } = {}) {
  const fill = el.querySelector('.fill');
  const num = el.querySelector('b');
  const grade = el.querySelector('.gauge-grade');
  const C = 2 * Math.PI * 52;
  fill.style.strokeDasharray = C;
  grade.textContent = '';
  const target = score.total;
  const t0 = performance.now();
  const dur = fast ? 1 : 1100;
  await new Promise(r => {
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      const v = target * e;
      num.textContent = Math.round(v);
      fill.style.strokeDashoffset = C * (1 - v / 100);
      fill.style.stroke = v >= 80 ? '#3ddc97' : v >= 55 ? '#ffd23f' : '#ff3e7f';
      if (k < 1) requestAnimationFrame(step); else r();
    };
    step();
  });
  grade.textContent = score.grade;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}

export function subBars(score) {
  const row = (label, v, w) => h('div', { class: 'sub' },
    h('span', {}, label, h('small', {}, ` ${w}%`)), h('div', { class: 'bar' }, h('i', { style: { width: v + '%' } })), h('b', {}, v));
  return h('div', { class: 'subs-bars' },
    row('Rhythm', score.rhythm, 58), row('Duration', score.duration, 32), row('Coverage', score.coverage, 10));
}

export function floatEmoji(container, e) {
  const el = h('div', { class: 'float-emoji', style: { left: (10 + Math.random() * 80) + '%' } }, e);
  container.append(el);
  setTimeout(() => el.remove(), 2600);
}

export function modal(title, body, { onClose, wide } = {}) {
  const close = () => { wrap.remove(); onClose && onClose(); };
  const wrap = h('div', { class: 'modal-wrap', onclick: e => { if (e.target === wrap) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : '') },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'btn ghost tiny', onclick: close, 'aria-label': 'Close' }, '✕')),
      body));
  document.body.append(wrap);
  return { close, el: wrap };
}
