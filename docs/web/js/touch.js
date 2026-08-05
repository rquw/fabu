// ---------- Making the editor work with a finger ----------
'use strict';

// Everything in fabu was written for a mouse: fifty-odd handlers that listen for
// mousedown and then follow mousemove on the window. Rewriting all of them for
// pointer events would touch every interaction in the app at once, so instead
// this translates touch into exactly the event stream those handlers already
// expect. One file to reason about, and the editor itself stays as it was.
//
// A phone does not send a mousemove stream. It sends mousedown and mouseup at
// the END of a gesture and nothing in between, which is why dragging a clip on
// a phone did nothing at all rather than doing something wrong.
//
// The translation is deliberately narrow. Only surfaces you are meant to drag
// on are translated, because translating everything means calling
// preventDefault on everything, and then the page cannot be scrolled.
// Named TouchInput, not Touch: Touch is a real DOM constructor for a single
// touch point, and shadowing a standard global is how you break something a
// year from now for no reason at all.
const TouchInput = {
  // Surfaces where a finger means "drag this", not "scroll the page".
  DRAG: [
    '#lanes', '#ruler', '.clip',
    '.proll-grid', '.proll-keys', '.proll-ruler', '.proll-vel',
    '.autom-canvas', '.fwin-head', '.fwin-rz', '.eq-canvas'
  ].join(','),

  // Things that must keep their own native behaviour even inside a drag
  // surface: a select has to open its menu, a range slider already works with
  // a finger, and a button has to stay a button.
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

  // Build a mouse event that looks enough like the real thing for handlers that
  // read coordinates, buttons and modifiers.
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
    // A card you drag onto the timeline is handled by the long-press path
    // below, which is a different gesture with a different meaning.
    if (el.closest('[draggable="true"]')) return;
    const surface = el.closest(this.DRAG);
    if (!surface) return;

    this.active = true;
    this.id = t.identifier;
    this.target = el;
    // Without this the browser also scrolls, and the clip slides while the
    // whole timeline slides underneath it.
    e.preventDefault();
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
    // Handlers that only listen for a click (selecting a track, opening a
    // menu) still need one, and a translated gesture never produces one.
    if (this.target) this.target.dispatchEvent(this.mouse('click', t, this.target));
    this.target = null;
  },

  // ---------- dragging loops and effects with a finger ----------
  // HTML5 drag and drop does not exist on touch: dragstart simply never fires.
  // Loops and effects are dragged onto the timeline, so without this the whole
  // loop library is unreachable on a phone.
  //
  // Press and hold picks the card up, which also keeps an ordinary tap free to
  // mean "play me this", the way it does with a mouse.
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
      // moving before the hold completes is a scroll, not a pick-up
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

  // A stand-in for the real dataTransfer. The drop handlers only ever set and
  // read string payloads and look at .types and .files, all of which this can
  // answer honestly.
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

  // The ghost card, the dissolve and the drop are all driven by the document
  // level dragover/drop/dragend listeners that already exist, and synthetic
  // events bubble there like real ones, so none of that is repeated here.
  carryTo(t) {
    const under = this.under(t);
    if (under !== this.lastOver) {
      if (this.lastOver) this.fire(this.lastOver, 'dragleave', t);
      this.lastOver = under;
    }
    if (under) this.fire(under, 'dragover', t);
  },

  // What is under the finger, ignoring the card being carried.
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
