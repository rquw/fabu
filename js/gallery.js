// ---------- The loop gallery: publish loops, browse other people's, follow them ----------
'use strict';

// Everything here goes through the same anon-key RPC path the accounts use, so
// there is no second set of credentials and no table this can reach directly.
// Writes carry a token instead of a password: the password is traded for one
// once, at sign-in, and the token is what sits in storage afterwards.
const Gallery = {
  TOKEN_KEY: 'fabu.token',
  CATS: ['drums', 'bass', 'melodic', 'jazz', 'other'],

  token() { try { return localStorage.getItem(this.TOKEN_KEY) || null; } catch (e) { return null; } },
  setToken(t) { try { t ? localStorage.setItem(this.TOKEN_KEY, t) : localStorage.removeItem(this.TOKEN_KEY); } catch (e) {} },

  rpc(fn, body) { return Auth.rpc(fn, body); },

  // Reading is open to everyone. Writing needs a token, and getting one needs
  // the password once. Asking for it at the moment somebody presses Publish is
  // better than a login wall in front of a gallery they only wanted to look at.
  async needToken() {
    const t = this.token();
    if (t) return t;
    if (!Auth.isLoggedIn()) {
      return new Promise((res) => Auth.open(() => this.askPassword().then(res)));
    }
    return this.askPassword();
  },

  askPassword() {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-back';
      wrap.innerHTML = `
        <div class="modal-card">
          <div class="modal-title">${tr('gal_confirm_title', 'Confirm it is you')}</div>
          <div class="modal-sub">${tr('gal_confirm_sub', 'Your password, once. After this fabu stays signed in for the gallery.')}</div>
          <input id="galPw" type="password" placeholder="${tr('auth_password', 'Password')}">
          <div id="galPwErr" class="auth-err"></div>
          <div class="modal-btns">
            <button id="galPwNo" class="fbtn">${tr('cancel', 'Cancel')}</button>
            <button id="galPwGo" class="fbtn accent">${tr('gal_confirm_go', 'Continue')}</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(null); });
      wrap.querySelector('#galPwNo').addEventListener('click', () => done(null));
      const go = wrap.querySelector('#galPwGo');
      const err = wrap.querySelector('#galPwErr');
      const submit = async () => {
        const p = wrap.querySelector('#galPw').value;
        if (!p) return;
        go.disabled = true; err.textContent = tr('auth_working', 'Working…');
        try {
          const t = await this.rpc('fabu_token_new', { u: Auth.user, p });
          if (t) { this.setToken(t); done(t); return; }
          err.textContent = tr('acct_pw_bad', 'Current password is wrong.');
        } catch (e) { err.textContent = tr('auth_offline', 'Cannot reach the server.'); }
        go.disabled = false;
      };
      go.addEventListener('click', submit);
      wrap.querySelector('#galPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      setTimeout(() => wrap.querySelector('#galPw').focus(), 50);
    });
  },

  // A token that has been revoked server-side must not sit in storage pretending
  // to work, or every action fails with an unexplained "not signed in".
  forgetToken() { this.setToken(null); },

  // ---------- publishing ----------

  async publish(loop) {
    if (!loop) return;
    const t = await this.needToken();
    if (!t) return;
    if (typeof hasProfanity === 'function' && hasProfanity(loop.name)) {
      toast(tr('gal_name_profane', 'Please rename the loop before sharing it.'), 'red');
      return;
    }
    const payload = MyLoops.toFile(loop);
    const cat = await this.askCategory(loop);
    if (!cat) return;
    try {
      const id = await this.rpc('fabu_loop_publish', {
        t, nm: loop.name, cat, tempo: Math.round(S.bpm || 120), payload
      });
      if (typeof id === 'number' && id > 0) {
        MyLoops.update(loop.id, { publishedId: id });
        toast(tr('gal_published', '{name} is in the gallery', { name: loop.name }), 'green');
        this.refresh();
      } else if (id === -1) { this.forgetToken(); toast(tr('gal_signed_out', 'Sign in again to publish.'), 'red'); }
      else if (id === -2) toast(tr('gal_too_big', 'That loop is too big to share.'), 'red');
      else if (id === -3) toast(tr('gal_daily', 'You have shared a lot today. Try again tomorrow.'), 'red');
      else if (id === -4) toast(tr('gal_bad_name', 'Give the loop a name first.'), 'red');
      else toast(tr('auth_error', 'Something went wrong.'), 'red');
    } catch (e) { toast(tr('auth_offline', 'Cannot reach the server.'), 'red'); }
  },

  askCategory(loop) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-back';
      wrap.innerHTML = `
        <div class="modal-card">
          <div class="modal-title">${tr('gal_pub_title', 'Share "{name}"', { name: loop.name })}</div>
          <div class="modal-sub">${tr('gal_pub_sub', 'Anyone can find it, play it and use it in their own song. You can take it down again at any time.')}</div>
          <label class="loop-field"><span>${tr('gal_cat', 'Kind of loop')}</span>
            <select id="galCat">${this.CATS.map(c => `<option value="${c}">${sampleCatName(c)}</option>`).join('')}</select></label>
          <div class="modal-btns">
            <button id="galPubNo" class="fbtn">${tr('cancel', 'Cancel')}</button>
            <button id="galPubGo" class="fbtn accent">${tr('gal_pub_go', 'Share it')}</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(null); });
      wrap.querySelector('#galPubNo').addEventListener('click', () => done(null));
      wrap.querySelector('#galPubGo').addEventListener('click', () => done(wrap.querySelector('#galCat').value));
    });
  },

  // ---------- browsing ----------

  sort: 'new',
  cat: '',
  query: '',

  // The gallery shows up in two places: a floating window over a project, and a
  // full page on the home screen. Only the box it draws into differs, so the
  // browser itself is built once and told where to go.
  toggle() {
    if (Windows.isOpen('gallery')) { Windows.close('gallery'); return; }
    const w = Windows.create('gallery', tr('gal_title', 'Loop gallery'), 'i-library',
      { x: 200, y: 110, width: 420, height: 460 });
    this.mount(w.body);
    w.refresh = () => this.refresh();
    App.syncWindowButtons();
  },

  mount(box) {
    this.box = box;
    box.innerHTML = `
      <div class="gal-bar">
        <div class="gal-tabs">
          <button class="gal-tab" data-sort="new">${tr('gal_new', 'Newest')}</button>
          <button class="gal-tab" data-sort="top">${tr('gal_top', 'Most liked')}</button>
          <button class="gal-tab" data-sort="friends">${tr('gal_friends', 'People you follow')}</button>
          <button class="gal-tab" data-sort="mine">${tr('gal_mine', 'Yours')}</button>
        </div>
        <div class="gal-filters">
          <input id="galSearch" type="text" placeholder="${tr('gal_search', 'Search loops or people')}" spellcheck="false">
          <select id="galCatFilter">
            <option value="">${tr('gal_all_cats', 'Every kind')}</option>
            ${this.CATS.map(c => `<option value="${c}">${sampleCatName(c)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="galList" class="gal-list"></div>`;

    const setSort = (s) => {
      this.sort = s;
      box.querySelectorAll('.gal-tab').forEach(b => b.classList.toggle('on', b.dataset.sort === s));
      // searching and filtering by kind mean nothing on your own local loops
      box.querySelector('.gal-filters').classList.toggle('hidden', s === 'mine');
      this.refresh();
    };
    box.querySelectorAll('.gal-tab').forEach(b => b.addEventListener('click', () => setSort(b.dataset.sort)));
    const search = box.querySelector('#galSearch');
    let typing;
    search.addEventListener('input', () => {
      clearTimeout(typing);
      typing = setTimeout(() => { this.query = search.value.trim(); this.refresh(); }, 250);
    });
    box.querySelector('#galCatFilter').addEventListener('change', (e) => { this.cat = e.target.value; this.refresh(); });
    setSort(this.sort);
  },

  // whichever copy is currently on screen
  list() {
    const w = Windows.wins.get('gallery');
    if (w) return w.body.querySelector('#galList');
    return this.box ? this.box.querySelector('#galList') : null;
  },

  async refresh() {
    const list = this.list();
    if (!list) return;
    list.innerHTML = `<div class="gal-note">${tr('gal_loading', 'Loading…')}</div>`;

    // Your own loops live in this browser, not on the server, so this tab needs
    // nothing from the network and works with no account at all.
    if (this.sort === 'mine') {
      const mine = MyLoops.all();
      if (!mine.length) {
        list.innerHTML = `<div class="gal-note">${tr('gal_mine_none', 'No loops of your own yet. Drag a pattern from your song into the Loops window to keep one.')}</div>`;
        return;
      }
      list.innerHTML = '';
      for (const l of mine.slice().reverse()) list.appendChild(this.mineCard(l));
      return;
    }

    // "People you follow" is the one view that means nothing signed out, so it
    // says so rather than showing an empty shelf.
    if (this.sort === 'friends' && !this.token()) {
      list.innerHTML = `<div class="gal-note">${tr('gal_need_signin', 'Sign in to see loops from people you follow.')}</div>`;
      const b = document.createElement('button');
      b.className = 'fbtn accent';
      b.textContent = tr('gal_signin', 'Sign in');
      b.addEventListener('click', async () => { if (await this.needToken()) this.refresh(); });
      list.appendChild(b);
      return;
    }
    let rows;
    try {
      rows = await this.rpc('fabu_loop_list', {
        t: this.token(), cat: this.cat, sort_by: this.sort, q: this.query, lim: 40, off: 0
      });
    } catch (e) {
      list.innerHTML = `<div class="gal-note">${tr('gal_offline', 'The gallery cannot be reached right now. Your own loops are under Yours and still work.')}</div>`;
      return;
    }
    if (!Array.isArray(rows) || !rows.length) {
      list.innerHTML = `<div class="gal-note">${tr('gal_empty', 'Nothing here yet. Share one of your loops and it will be the first.')}</div>`;
      return;
    }
    list.innerHTML = '';
    for (const r of rows) list.appendChild(this.card(r));
  },

  // one of your own loops: play it, publish it, edit it
  mineCard(l) {
    const el = document.createElement('div');
    el.className = 'gal-card';
    el.innerHTML = `
      <div class="gal-main">
        <div class="gal-nm">${escapeHtml(l.name)}</div>
        <div class="gal-meta">
          <span class="gal-tag">${escapeHtml(instrLabel(l.instrument))}</span>
          <span class="gal-tag">${l.length} ${tr('word_beats', 'beats')}</span>
          ${l.from ? `<span class="gal-tag">${escapeHtml(tr('loop_by', 'by {name}', { name: l.from }))}</span>` : ''}
          ${l.publishedId ? `<span class="gal-tag gal-tag-on">${tr('gal_shared', 'shared')}</span>` : ''}
        </div>
      </div>
      <div class="gal-acts">
        <button class="gal-play fbtn" data-tip="${tr('samp_preview', 'Preview')}"><svg class="ic"><use href="#i-play"/></svg></button>
        <button class="gal-pub fbtn accent">${l.publishedId ? tr('gal_pub_again', 'Share again') : tr('gal_pub_go', 'Share it')}</button>
        <button class="gal-more" data-tip="${tr('gal_more', 'More')}">...</button>
      </div>`;
    el.querySelector('.gal-play').addEventListener('click', () =>
      Engine.auditionSample(MyLoops.asPresets().find(p => p.id === l.id)));
    el.querySelector('.gal-pub').addEventListener('click', () => this.publish(l));
    el.querySelector('.gal-more').addEventListener('click', (e) => ctxMenu(e, [
      [tr('loop_edit_title', 'Your loop'), () => Windows.editMyLoop(l.id, () => this.refresh())],
      [tr('loop_share', 'Share as file'), () => {
        const safe = (l.name || 'loop').replace(/[\\/:*?"<>|]/g, '') || 'loop';
        App.browserDownload(new Blob([MyLoops.toFile(l)], { type: 'application/json' }), safe + MyLoops.EXT);
      }],
      [tr('loop_delete', 'Delete'), () => { MyLoops.remove(l.id); this.refresh(); if (Windows._sampRender) Windows._sampRender(); }]
    ]));
    return el;
  },

  card(r) {
    const el = document.createElement('div');
    el.className = 'gal-card';
    const mine = Auth.user && r.author === Auth.user;
    el.innerHTML = `
      <div class="gal-main">
        <div class="gal-nm">${escapeHtml(r.name)}</div>
        <div class="gal-meta">
          <button class="gal-author">${escapeHtml(r.author)}</button>
          <span class="gal-tag">${sampleCatName(r.category)}</span>
          <span class="gal-tag">${r.bpm} ${tr('word_bpm', 'BPM')}</span>
        </div>
      </div>
      <div class="gal-acts">
        <button class="gal-like${r.liked ? ' on' : ''}" data-tip="${tr('gal_like', 'Like')}">
          <svg class="ic"><use href="#i-heart"/></svg><span>${r.likes}</span></button>
        <button class="gal-add fbtn accent" data-tip="${tr('gal_add_tip', 'Put it in your loops')}">${tr('gal_add', 'Add')}</button>
        <button class="gal-more" data-tip="${tr('gal_more', 'More')}">...</button>
      </div>`;

    el.querySelector('.gal-author').addEventListener('click', () => this.openProfile(r.author));

    el.querySelector('.gal-like').addEventListener('click', async () => {
      const t = await this.needToken();
      if (!t) return;
      try {
        const n = await this.rpc('fabu_loop_like', { t, lid: r.id });
        if (n === -1) { this.forgetToken(); toast(tr('gal_signed_out', 'Sign in again.'), 'red'); return; }
        r.liked = !r.liked;
        r.likes = n;
        const b = el.querySelector('.gal-like');
        b.classList.toggle('on', r.liked);
        b.querySelector('span').textContent = n;
      } catch (e) { toast(tr('auth_offline', 'Cannot reach the server.'), 'red'); }
    });

    el.querySelector('.gal-add').addEventListener('click', async () => {
      const btn = el.querySelector('.gal-add');
      btn.disabled = true;
      try {
        const text = await this.rpc('fabu_loop_get', { lid: r.id });
        const loop = text && MyLoops.parseFile(text);
        if (!loop) { toast(tr('gal_gone', 'That loop is no longer there.'), 'red'); return; }
        loop.name = r.name;
        loop.from = r.author;
        if (MyLoops.add(loop)) {
          toast(tr('gal_saved', '{name} is in your loops', { name: loop.name }), 'green');
          if (Windows._sampRender) Windows._sampRender();
        }
      } catch (e) { toast(tr('auth_offline', 'Cannot reach the server.'), 'red'); }
      btn.disabled = false;
    });

    el.querySelector('.gal-more').addEventListener('click', (e) => this.moreMenu(e, r, mine, el));
    return el;
  },

  moreMenu(e, r, mine, cardEl) {
    const items = [];
    if (mine) {
      items.push([tr('gal_take_down', 'Take it down'), async () => {
        const t = await this.needToken();
        if (!t) return;
        try {
          const ok = await this.rpc('fabu_loop_delete', { t, lid: r.id });
          if (ok) { cardEl.remove(); toast(tr('gal_taken_down', 'Taken down.')); }
        } catch (err) { toast(tr('auth_offline', 'Cannot reach the server.'), 'red'); }
      }]);
    } else {
      items.push([tr('gal_report', 'Report this loop'), () => this.report(r, cardEl)]);
    }
    items.push([tr('gal_view_author', 'See {name}', { name: r.author }), () => this.openProfile(r.author)]);
    ctxMenu(e, items);
  },

  report(r, cardEl) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-back';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('gal_report_title', 'Report "{name}"', { name: r.name })}</div>
        <div class="modal-sub">${tr('gal_report_sub', 'Tell us what is wrong with it. Enough reports and it comes down on its own.')}</div>
        <input id="galWhy" type="text" maxlength="200" placeholder="${tr('gal_report_why', 'What is wrong with it?')}">
        <div class="modal-btns">
          <button id="galRepNo" class="fbtn">${tr('cancel', 'Cancel')}</button>
          <button id="galRepGo" class="fbtn danger">${tr('gal_report_go', 'Report it')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('mousedown', (ev) => { if (ev.target === wrap) close(); });
    wrap.querySelector('#galRepNo').addEventListener('click', close);
    wrap.querySelector('#galRepGo').addEventListener('click', async () => {
      const t = await this.needToken();
      if (!t) { close(); return; }
      try {
        await this.rpc('fabu_loop_report', { t, lid: r.id, why: wrap.querySelector('#galWhy').value });
        toast(tr('gal_reported', 'Reported. Thank you.'), 'green');
        cardEl.classList.add('gal-reported');
      } catch (e) { toast(tr('auth_offline', 'Cannot reach the server.'), 'red'); }
      close();
    });
    setTimeout(() => wrap.querySelector('#galWhy').focus(), 50);
  },

  // ---------- profiles ----------

  // Your own profile, from wherever you are. Signing in first is the point of
  // the profile, so it asks rather than doing nothing.
  async openMyProfile() {
    if (!Auth.isLoggedIn()) { Auth.open(() => this.openMyProfile()); return; }
    this.openProfile(Auth.user);
  },

  async openProfile(name) {
    const old = document.getElementById('profModal');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'profModal';
    wrap.className = 'modal-back';
    wrap.innerHTML = `<div class="modal-card"><div class="gal-note">${tr('gal_loading', 'Loading…')}</div></div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap.remove(); });

    let p = null;
    try {
      const rows = await this.rpc('fabu_profile_get', { t: this.token(), who: name });
      p = Array.isArray(rows) ? rows[0] : rows;
    } catch (e) { /* shown below */ }
    if (!p) {
      wrap.querySelector('.modal-card').innerHTML =
        `<div class="gal-note">${tr('gal_no_profile', 'No profile for {name} yet.', { name })}</div>
         <div class="modal-btns"><button class="fbtn" id="profClose">${tr('close', 'Close')}</button></div>`;
      wrap.querySelector('#profClose').addEventListener('click', () => wrap.remove());
      return;
    }
    const mine = Auth.user === p.username;
    wrap.querySelector('.modal-card').innerHTML = `
      <div class="prof-head">
        <span class="prof-dot" style="background:${p.accent || hashColor(p.username)}"></span>
        <span class="prof-name">${escapeHtml(p.username)}</span>
      </div>
      <div class="prof-bio">${escapeHtml(p.bio) || `<i>${tr('prof_no_bio', 'No introduction yet.')}</i>`}</div>
      <div class="prof-stats">
        <span><b>${p.loops}</b> ${tr('prof_loops', 'loops')}</span>
        <span><b>${p.likes}</b> ${tr('prof_likes', 'likes')}</span>
        <span><b>${p.followers}</b> ${tr('prof_followers', 'followers')}</span>
        <span><b>${p.following}</b> ${tr('prof_following', 'following')}</span>
      </div>
      <div class="modal-btns">
        ${mine ? `<button id="profEdit" class="fbtn">${tr('prof_edit', 'Edit profile')}</button>`
               : `<button id="profFollow" class="fbtn${p.i_follow ? '' : ' accent'}">${p.i_follow ? tr('prof_unfollow', 'Unfollow') : tr('prof_follow', 'Follow')}</button>`}
        <button id="profLoops" class="fbtn">${tr('prof_see_loops', 'See their loops')}</button>
        <button id="profClose" class="fbtn accent">${tr('close', 'Close')}</button>
      </div>`;
    wrap.querySelector('#profClose').addEventListener('click', () => wrap.remove());
    wrap.querySelector('#profLoops').addEventListener('click', () => {
      wrap.remove();
      this.query = p.username;
      this.sort = 'new';
      if (!Windows.isOpen('gallery')) this.toggle();
      const s = Windows.wins.get('gallery');
      if (s) { const f = s.body.querySelector('#galSearch'); if (f) f.value = p.username; }
      this.refresh();
    });
    const fb = wrap.querySelector('#profFollow');
    if (fb) fb.addEventListener('click', async () => {
      const t = await this.needToken();
      if (!t) return;
      try {
        const now = await this.rpc('fabu_follow', { t, who: p.username });
        p.i_follow = !!now;
        fb.textContent = now ? tr('prof_unfollow', 'Unfollow') : tr('prof_follow', 'Follow');
        fb.classList.toggle('accent', !now);
      } catch (e) { toast(tr('auth_offline', 'Cannot reach the server.'), 'red'); }
    });
    const eb = wrap.querySelector('#profEdit');
    if (eb) eb.addEventListener('click', () => { wrap.remove(); this.editProfile(p); });
  },

  editProfile(p) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-back';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('prof_edit', 'Edit profile')}</div>
        <label class="loop-field"><span>${tr('prof_bio', 'About you')}</span>
          <input id="profBio" type="text" maxlength="200" value="${escapeHtml(p.bio || '')}"
            placeholder="${tr('prof_bio_ph', 'A line about the music you make')}"></label>
        <label class="loop-field"><span>${tr('prof_accent', 'Your colour')}</span>
          <input id="profAccent" type="color" value="${p.accent || hashColor(p.username)}"></label>
        <div class="modal-btns">
          <button id="profNo" class="fbtn">${tr('cancel', 'Cancel')}</button>
          <button id="profGo" class="fbtn accent">${tr('prof_save', 'Save')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    wrap.querySelector('#profNo').addEventListener('click', close);
    wrap.querySelector('#profGo').addEventListener('click', async () => {
      const t = await this.needToken();
      if (!t) { close(); return; }
      const bio = wrap.querySelector('#profBio').value;
      if (typeof hasProfanity === 'function' && hasProfanity(bio)) {
        toast(tr('prof_bio_profane', 'Please write something else there.'), 'red');
        return;
      }
      try {
        await this.rpc('fabu_profile_set', { t, bio_in: bio, accent_in: wrap.querySelector('#profAccent').value });
        toast(tr('prof_saved', 'Profile saved.'), 'green');
      } catch (e) { toast(tr('auth_offline', 'Cannot reach the server.'), 'red'); }
      close();
    });
  },

  // The same profile as the modal, laid out as a page for the home screen.
  async mountProfile(box, name) {
    box.innerHTML = `<div class="gal-note">${tr('gal_loading', 'Loading…')}</div>`;
    if (!name) {
      box.innerHTML = `<div class="gal-note">${tr('prof_need_signin', 'Sign in and your profile lives here: what you have shared, who follows you, and a line about the music you make.')}</div>`;
      const b = document.createElement('button');
      b.className = 'fbtn accent';
      b.textContent = tr('gal_signin', 'Sign in');
      b.addEventListener('click', () => Auth.open(() => App.showHomePage('profile')));
      box.appendChild(b);
      return;
    }
    let p = null;
    try {
      const rows = await this.rpc('fabu_profile_get', { t: this.token(), who: name });
      p = Array.isArray(rows) ? rows[0] : rows;
    } catch (e) { /* handled below */ }
    // With no server reachable there is still something true to show: the name
    // they are signed in as, and the loops sitting in this browser.
    if (!p) p = { username: name, bio: '', accent: '', loops: 0, likes: 0,
                  followers: 0, following: 0, i_follow: false, offline: true };
    const mine = Auth.user === p.username;

    box.innerHTML = `
      <div class="pf-head">
        <span class="pf-dot" style="background:${p.accent || hashColor(p.username)}"></span>
        <div class="pf-id">
          <div class="pf-name">${escapeHtml(p.username)}</div>
          <div class="pf-bio">${escapeHtml(p.bio) || `<i>${tr('prof_no_bio', 'No introduction yet.')}</i>`}</div>
        </div>
        <div class="pf-btns"></div>
      </div>
      <div class="pf-stats">
        <div class="pf-stat"><b>${p.loops}</b><span>${tr('prof_loops', 'loops')}</span></div>
        <div class="pf-stat"><b>${p.likes}</b><span>${tr('prof_likes', 'likes')}</span></div>
        <div class="pf-stat"><b>${p.followers}</b><span>${tr('prof_followers', 'followers')}</span></div>
        <div class="pf-stat"><b>${p.following}</b><span>${tr('prof_following', 'following')}</span></div>
      </div>
      ${p.offline ? `<div class="gal-note">${tr('prof_offline', 'These counts need the server, which is not answering. Your own loops below are kept in this browser and are unaffected.')}</div>` : ''}
      <div class="pf-sec">${mine ? tr('gal_mine', 'Yours') : tr('prof_their_loops', 'Their loops')}</div>
      <div id="pfLoops" class="gal-list"></div>`;

    const btns = box.querySelector('.pf-btns');
    if (mine) {
      const e = document.createElement('button');
      e.className = 'fbtn'; e.textContent = tr('prof_edit', 'Edit profile');
      e.addEventListener('click', () => this.editProfile(p));
      const f = document.createElement('button');
      f.className = 'fbtn'; f.textContent = tr('gal_following_title', 'People you follow');
      f.addEventListener('click', () => this.openFollowing());
      btns.append(e, f);
    } else {
      const f = document.createElement('button');
      f.className = 'fbtn' + (p.i_follow ? '' : ' accent');
      f.textContent = p.i_follow ? tr('prof_unfollow', 'Unfollow') : tr('prof_follow', 'Follow');
      f.addEventListener('click', async () => {
        const t = await this.needToken();
        if (!t) return;
        try {
          const now = await this.rpc('fabu_follow', { t, who: p.username });
          p.i_follow = !!now;
          f.textContent = now ? tr('prof_unfollow', 'Unfollow') : tr('prof_follow', 'Follow');
          f.classList.toggle('accent', !now);
        } catch (err) { toast(tr('auth_offline', 'Cannot reach the server.'), 'red'); }
      });
      btns.appendChild(f);
    }

    const list = box.querySelector('#pfLoops');
    if (mine) {
      const ml = MyLoops.all();
      if (!ml.length) list.innerHTML = `<div class="gal-note">${tr('gal_mine_none', 'No loops of your own yet.')}</div>`;
      else for (const l of ml.slice().reverse()) list.appendChild(this.mineCard(l));
      return;
    }
    try {
      const rows = await this.rpc('fabu_loop_list', {
        t: this.token(), cat: '', sort_by: 'new', q: p.username, lim: 40, off: 0
      });
      const theirs = (rows || []).filter(r => r.author === p.username);
      if (!theirs.length) list.innerHTML = `<div class="gal-note">${tr('prof_no_loops', 'Nothing shared yet.')}</div>`;
      else for (const r of theirs) list.appendChild(this.card(r));
    } catch (e) {
      list.innerHTML = `<div class="gal-note">${tr('auth_offline', 'Cannot reach the server.')}</div>`;
    }
  },

  // ---------- people you follow ----------

  async openFollowing() {
    const t = await this.needToken();
    if (!t) return;
    const wrap = document.createElement('div');
    wrap.className = 'modal-back';
    wrap.innerHTML = `<div class="modal-card"><div class="gal-note">${tr('gal_loading', 'Loading…')}</div></div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap.remove(); });
    let rows = [];
    try { rows = await this.rpc('fabu_follow_list', { t }); } catch (e) {}
    const card = wrap.querySelector('.modal-card');
    card.innerHTML = `
      <div class="modal-title">${tr('gal_following_title', 'People you follow')}</div>
      <div class="modal-sub">${tr('gal_following_sub', 'Following each other both ways makes you friends.')}</div>
      <div id="folList"></div>
      <div class="modal-btns"><button id="folClose" class="fbtn accent">${tr('close', 'Close')}</button></div>`;
    const list = card.querySelector('#folList');
    if (!rows || !rows.length) {
      list.innerHTML = `<div class="gal-note">${tr('gal_following_none', 'Nobody yet. Follow someone from their loop in the gallery.')}</div>`;
    }
    for (const r of (rows || [])) {
      const row = document.createElement('div');
      row.className = 'req-row';
      row.innerHTML = `<span class="jam-pdot" style="background:${hashColor(r.name)}"></span>
        <span class="jam-pname">${escapeHtml(r.name)}${r.mutual ? ` <i>${tr('gal_mutual', 'friend')}</i>` : ''}</span>
        <span class="req-why">${tr('gal_n_loops', '{n} loops', { n: r.loops })}</span>`;
      const b = document.createElement('button');
      b.className = 'fbtn';
      b.textContent = tr('gal_view', 'View');
      b.addEventListener('click', () => { wrap.remove(); this.openProfile(r.name); });
      row.appendChild(b);
      list.appendChild(row);
    }
    card.querySelector('#folClose').addEventListener('click', () => wrap.remove());
  }
};

window.Gallery = Gallery;
