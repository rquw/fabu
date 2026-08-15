// no next button, every step ends when the thing actually happens
const Tutor = {
  SEEN_KEY: 'fabu.tutorSeen',
  active: false,
  step: 0,
  steps: [],

  seen() { return localStorage.getItem(this.SEEN_KEY) === '1'; },
  markSeen() { try { localStorage.setItem(this.SEEN_KEY, '1'); } catch (e) {} },

  maybeStart(clipId) {
    if (this.active || this.seen()) return;
    if (UI.playing) return;
    this._clipId = clipId;
    setTimeout(() => this.start(), 380); // let the clip settle in first
  },

  maybeStartEmpty() {
    if (this.active || this.seen()) return;
    if (UI.playing || !S || S.tracks.length) return;
    setTimeout(() => {
      if (this.active || this.seen() || !S || S.tracks.length) return;
      if (this.homeVisible()) return;
      if (!document.querySelector('.thead-add button')) return;   // nothing to point at
      this.start(true);
    }, 700);
  },

  homeVisible() {
    const home = document.getElementById('home');
    return !!home && home.style.display !== 'none';
  },

  start(fromEmpty) {
    if (this.active) return;
    this.active = true;
    this.step = 0;
    this._instr0 = (S.tracks[0] && S.tracks[0].instrument) || null;

    this.steps = [
      {
        target: () => document.querySelector('.thead-add button'),
        title: tr('tut_first_t', 'Start with an instrument'),
        body: tr('tut_first_b', 'Click Instrument. That gives you a track to put music on.'),
        done: () => S.tracks.length > 0
      },
      {
        target: () => document.querySelector('.lane'),
        title: tr('tut_make_t', 'Make a pattern'),
        body: tr('tut_make_b', 'Double click the empty lane to the right to make a pattern.'),
        done: () => S.tracks.some(tr2 => tr2.clips && tr2.clips.length)
      },
      {
        target: () => document.querySelector('.tinst-btn'),
        title: tr('tut_instr_t', 'Change the sound'),
        body: tr('tut_instr_b', 'Pick a different instrument here. The same notes, a different sound.'),
        done: () => {
          const now = S.tracks[0] && S.tracks[0].instrument;
          return !!now && now !== this._instr0;
        }
      },
      {
        target: () => document.querySelector('.thead-add'),
        title: tr('tut_add_t', 'Stack another layer'),
        body: tr('tut_add_b', 'Add a second track. Layers on top of each other are what makes it a song.'),
        done: () => S.tracks.length >= 2
      },
      {
        target: () => document.querySelector('#btnSamples'),
        title: tr('tut_samp_t', 'Ready made loops'),
        body: tr('tut_samp_b', 'Open the loops. Drag one onto your song and it plays straight away.'),
        done: () => typeof Windows !== 'undefined' && Windows.isOpen('samples')
      },
      {
        target: () => document.querySelector('#btnJam'),
        title: tr('tut_jam_t', 'Play together'),
        body: tr('tut_jam_b', 'Start a room and a friend builds the track live with you. That is it, have fun.'),
        done: () => !!document.getElementById('jamPanel') || !!document.getElementById('mpMenu')
                    || (typeof Sync !== 'undefined' && Sync.connected)
      }
    ];
    if (!fromEmpty) this.steps.splice(0, 2);

    this._buildDom();
    this.show();
    this._watch();
  },

  _watch() {
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (!this.active) { clearInterval(this._timer); return; }
      const s = this.steps[this.step];
      if (!s) { this.finish(); return; }
      if (s.done && s.done()) { this.next(); return; }
      this._place(s.target && s.target());
    }, 240);
  },

  _buildDom() {
    let hl = $('#tutorHighlight');
    if (!hl) { hl = document.createElement('div'); hl.id = 'tutorHighlight'; document.body.appendChild(hl); }
    let card = $('#tutorCard');
    if (!card) { card = document.createElement('div'); card.id = 'tutorCard'; document.body.appendChild(card); }
    this._hl = hl; this._card = card;
  },

  show() {
    let guard = 0;
    while (this.steps[this.step] && guard++ < this.steps.length) {
      const t = this.steps[this.step].target;
      if (!t || t()) break;
      this.step++;
    }
    const s = this.steps[this.step];
    if (!s) return this.finish();
    const el = s.target && s.target();

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
        '<div class="tc-btns"><button class="tc-skip"></button></div>' +
      '</div>';
    this._card.querySelector('.tc-title').textContent = s.title;
    this._card.querySelector('.tc-body').textContent = s.body;
    this._card.querySelector('.tc-step').textContent =
      tr('tut_step', 'Step {n} of {total}', { n: this.step + 1, total: this.steps.length });
    const skip = this._card.querySelector('.tc-skip');
    skip.textContent = tr('tut_skip', 'Skip');
    skip.onclick = () => this.finish();

    this._position(el);
  },

  _place(el) {
    if (!this._hl) return;
    if (!el) { this._hl.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    const pad = 6;
    this._hl.style.display = 'block';
    this._hl.style.left = (r.left - pad) + 'px';
    this._hl.style.top = (r.top - pad) + 'px';
    this._hl.style.width = (r.width + pad * 2) + 'px';
    this._hl.style.height = (r.height + pad * 2) + 'px';
  },

  _position(el) {
    const card = this._card;
    card.style.visibility = 'hidden';
    card.style.display = 'block';
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left, top;
    if (el) {
      const r = el.getBoundingClientRect();
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
    setTimeout(() => { if (this.active) this.show(); }, 260);
  },

  finish() {
    this.active = false;
    clearInterval(this._timer);
    this.markSeen();
    if (this._card) this._card.remove();
    if (this._hl) this._hl.remove();
    this._card = this._hl = null;
  },
};
window.Tutor = Tutor;
