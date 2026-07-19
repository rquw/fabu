// First-project tutorial. A short, skippable walkthrough that points at the
// real controls one at a time. Shows once, the first time someone adds a
// pattern to an empty project. No em dashes, no jargon.
const Tutor = {
  SEEN_KEY: 'fabu.tutorSeen',
  active: false,
  step: 0,
  steps: [],

  seen() { return localStorage.getItem(this.SEEN_KEY) === '1'; },
  markSeen() { try { localStorage.setItem(this.SEEN_KEY, '1'); } catch (e) {} },

  // called after a pattern is added; only fires for a fresh user
  maybeStart(clipId) {
    if (this.active || this.seen()) return;
    if (UI.playing) return;
    this._clipId = clipId;
    setTimeout(() => this.start(), 380); // let the clip settle in first
  },

  start() {
    if (this.active) return;
    this.active = true;
    this.step = 0;
    this.steps = [
      {
        target: () => document.querySelector('.clip.sel') || document.querySelector('.clip'),
        title: tr('tut_clip_t', 'You made a pattern'),
        body: tr('tut_clip_b', 'Double click it to open the note editor, then draw a melody by clicking on the grid.'),
      },
      {
        target: () => document.querySelector('.ms-btn.mute'),
        title: tr('tut_ms_t', 'Mute and solo'),
        body: tr('tut_ms_b', 'M silences a track. S plays only that track so you can focus on one sound.'),
      },
      {
        target: () => document.querySelector('.thead-mid select'),
        title: tr('tut_instr_t', 'Change the sound'),
        body: tr('tut_instr_b', 'Pick another instrument from this menu, like keys, bass or drums.'),
      },
      {
        target: () => document.querySelector('.thead-add'),
        title: tr('tut_add_t', 'Stack more layers'),
        body: tr('tut_add_b', 'Add another track here to layer more instruments on top of each other.'),
      },
      {
        target: () => document.querySelector('#btnSamples'),
        title: tr('tut_samp_t', 'Ready made loops'),
        body: tr('tut_samp_b', 'Open this to grab drums, bass and effects. Drag one straight onto your song.'),
      },
      {
        target: () => document.querySelector('#btnJam'),
        title: tr('tut_jam_t', 'Play together'),
        body: tr('tut_jam_b', 'Start a room and a friend can build the track live with you. That is it, have fun.'),
      },
    ];
    this._buildDom();
    this.show();
  },

  _buildDom() {
    let hl = $('#tutorHighlight');
    if (!hl) { hl = document.createElement('div'); hl.id = 'tutorHighlight'; document.body.appendChild(hl); }
    let card = $('#tutorCard');
    if (!card) { card = document.createElement('div'); card.id = 'tutorCard'; document.body.appendChild(card); }
    this._hl = hl; this._card = card;
  },

  show() {
    const s = this.steps[this.step];
    if (!s) return this.finish();
    const el = s.target && s.target();
    const last = this.step === this.steps.length - 1;

    // move the spotlight over the target (or hide it if the target is gone)
    if (el) {
      const r = el.getBoundingClientRect();
      const pad = 6;
      this._hl.style.display = 'block';
      this._hl.style.left = (r.left - pad) + 'px';
      this._hl.style.top = (r.top - pad) + 'px';
      this._hl.style.width = (r.width + pad * 2) + 'px';
      this._hl.style.height = (r.height + pad * 2) + 'px';
    } else {
      this._hl.style.display = 'none';
    }

    this._card.innerHTML =
      '<div class="tc-title"></div>' +
      '<div class="tc-body"></div>' +
      '<div class="tc-row">' +
        '<span class="tc-step"></span>' +
        '<div class="tc-btns">' +
          '<button class="tc-skip"></button>' +
          '<button class="tc-next"></button>' +
        '</div>' +
      '</div>';
    this._card.querySelector('.tc-title').textContent = s.title;
    this._card.querySelector('.tc-body').textContent = s.body;
    this._card.querySelector('.tc-step').textContent =
      tr('tut_step', 'Step {n} of {total}', { n: this.step + 1, total: this.steps.length });
    const skip = this._card.querySelector('.tc-skip');
    skip.textContent = tr('tut_skip', 'Skip');
    skip.onclick = () => this.finish();
    const next = this._card.querySelector('.tc-next');
    next.textContent = last ? tr('tut_done', 'Got it') : tr('tut_next', 'Next');
    next.onclick = () => this.next();

    this._position(el);
  },

  // place the card near the target without running off screen
  _position(el) {
    const card = this._card;
    card.style.visibility = 'hidden';
    card.style.display = 'block';
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left, top;
    if (el) {
      const r = el.getBoundingClientRect();
      // prefer below, then above, then beside
      if (r.bottom + ch + 16 < vh) { top = r.bottom + 12; left = r.left; }
      else if (r.top - ch - 16 > 0) { top = r.top - ch - 12; left = r.left; }
      else { top = r.top; left = r.right + 12; }
    } else {
      top = vh / 2 - ch / 2; left = vw / 2 - cw / 2;
    }
    left = Math.max(12, Math.min(left, vw - cw - 12));
    top = Math.max(12, Math.min(top, vh - ch - 12));
    card.style.left = left + 'px';
    card.style.top = top + 'px';
    card.style.visibility = 'visible';
  },

  next() {
    this.step++;
    if (this.step >= this.steps.length) return this.finish();
    this.show();
  },

  finish() {
    this.active = false;
    this.markSeen();
    if (this._card) this._card.remove();
    if (this._hl) this._hl.remove();
    this._card = this._hl = null;
  },
};
window.Tutor = Tutor;
