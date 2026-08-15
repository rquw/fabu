// ---------- touch ----------
'use strict';

const TouchInput = {
  DRAG: [
    '#lanes', '#ruler', '.clip',
    '.proll-grid', '.proll-keys', '.proll-ruler', '.proll-vel',
    '.autom-canvas', '.fwin-head', '.fwin-rz', '.eq-canvas'
  ].join(','),

  NATIVE: 'input,select,textarea,button,option,a,[contenteditable]',

  active: false,
  id: null,

  install() {
    if (this._on) return;
    this._on = true;
    document.addEventListener('touchstart', (e) => this.start(e), { passive: false });
    document.addEventListener('touchmove', (e) => this.move(e), { passive: false });
    document.addEventListener('touchend', (e) => this.end(e), { passive: false });
    document.addEventListener('touchcancel', (e) => this.end(e), { passive: false });
    this.installDrag();
  },

  mouse(type, t, target) {
    return new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: t.clientX, clientY: t.clientY,
      screenX: t.screenX, screenY: t.screenY,
      button: 0, buttons: type === 'mouseup' ? 0 : 1
    });
  },

  start(e) {
    if (this.active || e.touches.length !== 1) return;
    const t = e.touches[0];
    const el = document.elementFromPoint(t.clientX, t.clientY);
    if (!el) return;
    if (el.closest(this.NATIVE)) return;
    if (el.closest('[draggable="true"]')) return;   // long press
    const surface = el.closest(this.DRAG);
    if (!surface) return;

    this.active = true;
    this.id = t.identifier;
    this.target = el;
    e.preventDefault();   // else it scrolls too
    el.dispatchEvent(this.mouse('mousedown', t, el));
  },

  find(e) {
    for (const t of e.changedTouches) if (t.identifier === this.id) return t;
    return null;
  },

  move(e) {
    if (!this.active) return;
    const t = this.find(e) || e.touches[0];
    if (!t) return;
    e.preventDefault();
    window.dispatchEvent(this.mouse('mousemove', t));
  },

  end(e) {
    if (!this.active) return;
    const t = this.find(e) || e.changedTouches[0];
    this.active = false;
    this.id = null;
    if (!t) return;
    e.preventDefault();
    window.dispatchEvent(this.mouse('mouseup', t));
    if (this.target) this.target.dispatchEvent(this.mouse('click', t, this.target));
    this.target = null;
  },

  // ---------- cards ----------
  HOLD_MS: 320,

  installDrag() {
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const card = el && el.closest('[draggable="true"]');
      if (!card || (el.closest && el.closest('button') && !card.contains(el.closest('button')))) return;
      this.holdFrom = { x: t.clientX, y: t.clientY };
      this.holdCard = card;
      clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => this.pickUp(card, t), this.HOLD_MS);
    }, { passive: false });

    document.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (!t) return;
      if (this.holdTimer && this.holdFrom &&
          Math.hypot(t.clientX - this.holdFrom.x, t.clientY - this.holdFrom.y) > 12) {
        clearTimeout(this.holdTimer); this.holdTimer = null;
      }
      if (!this.carrying) return;
      e.preventDefault();
      this.carryTo(t);
    }, { passive: false });

    const release = (e) => {
      clearTimeout(this.holdTimer); this.holdTimer = null;
      if (!this.carrying) return;
      const t = e.changedTouches[0];
      e.preventDefault();
      this.drop(t);
    };
    document.addEventListener('touchend', release, { passive: false });
    document.addEventListener('touchcancel', release, { passive: false });
  },

  makeDT() {
    const data = {};
    return {
      _data: data,
      effectAllowed: 'copy', dropEffect: 'copy',
      files: [],
      get types() { return Object.keys(data); },
      setData(k, v) { data[k] = String(v); },
      getData(k) { return data[k] || ''; },
      clearData(k) { if (k) delete data[k]; else for (const x in data) delete data[x]; },
      setDragImage() {}
    };
  },

  fire(target, type, t) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    ev.clientX = t.clientX; ev.clientY = t.clientY;
    ev.dataTransfer = this.dt;
    target.dispatchEvent(ev);
    return ev;
  },

  pickUp(card, t) {
    this.holdTimer = null;
    this.carrying = card;
    this.dt = this.makeDT();
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
    this.fire(card, 'dragstart', t);
    this.carryTo(t);
  },

  carryTo(t) {
    const under = this.under(t);
    if (under !== this.lastOver) {
      if (this.lastOver) this.fire(this.lastOver, 'dragleave', t);
      this.lastOver = under;
    }
    if (under) this.fire(under, 'dragover', t);
  },

  under(t) {
    const carried = this.carrying;
    const hidden = [];
    if (carried) { hidden.push([carried, carried.style.pointerEvents]); carried.style.pointerEvents = 'none'; }
    const el = document.elementFromPoint(t.clientX, t.clientY);
    for (const [e, v] of hidden) e.style.pointerEvents = v;
    return el;
  },

  drop(t) {
    const card = this.carrying;
    const target = this.under(t);
    this.carrying = null;
    if (target) this.fire(target, 'drop', t);
    if (this.lastOver && this.lastOver !== target) this.fire(this.lastOver, 'dragleave', t);
    this.lastOver = null;
    if (card) this.fire(card, 'dragend', t);
    this.dt = null;
  }
};

window.TouchInput = TouchInput;
if (window.matchMedia && matchMedia('(pointer: coarse)').matches) {
  if (document.body) TouchInput.install();
  else document.addEventListener('DOMContentLoaded', () => TouchInput.install());
}
