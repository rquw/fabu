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
        if (Windows.isOpen('gallery')) this.refresh();
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

  toggle() {
    if (Windows.isOpen('gallery')) { Windows.close('gallery'); return; }
    const w = Windows.create('gallery', tr('gal_title', 'Loop gallery'), 'i-library',
      { x: 200, y: 110, width: 420, height: 460 });
    w.body.innerHTML = `
      <div class="gal-bar">
        <div class="gal-tabs">
          <button class="gal-tab" data-sort="new">${tr('gal_new', 'Newest')}</button>
          <button class="gal-tab" data-sort="top">${tr('gal_top', 'Most liked')}</button>
          <button class="gal-tab" data-sort="friends">${tr('gal_friends', 'People you follow')}</button>
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
    w.refresh = () => this.refresh();

    const setSort = (s) => {
      this.sort = s;
      w.body.querySelectorAll('.gal-tab').forEach(b => b.classList.toggle('on', b.dataset.sort === s));
      this.refresh();
    };
    w.body.querySelectorAll('.gal-tab').forEach(b => b.addEventListener('click', () => setSort(b.dataset.sort)));
    const search = w.body.querySelector('#galSearch');
    let typing;
    search.addEventListener('input', () => {
      clearTimeout(typing);
      typing = setTimeout(() => { this.query = search.value.trim(); this.refresh(); }, 250);
    });
    w.body.querySelector('#galCatFilter').addEventListener('change', (e) => { this.cat = e.target.value; this.refresh(); });
    setSort(this.sort);
    App.syncWindowButtons();
  },

  async refresh() {
    const w = Windows.wins.get('gallery');
    if (!w) return;
    const list = w.body.querySelector('#galList');
    list.innerHTML = `<div class="gal-note">${tr('gal_loading', 'Loading…')}</div>`;
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
      list.innerHTML = `<div class="gal-note">${tr('auth_offline', 'Cannot reach the server.')}</div>`;
      return;
    }
    if (!Array.isArray(rows) || !rows.length) {
      list.innerHTML = `<div class="gal-note">${tr('gal_empty', 'Nothing here yet. Share one of your loops and it will be the first.')}</div>`;
      return;
    }
    list.innerHTML = '';
    for (const r of rows) list.appendChild(this.card(r));
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
