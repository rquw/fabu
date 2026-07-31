// ---------- Accounts: simple username/password via Supabase RPC (anon key only) ----------
'use strict';

// the public (anon) key, lightly scrambled so it does not sit in plain text
function _dk(enc) {
  const mask = 'fabu-mach-musik';
  const raw = atob(enc);
  let out = '';
  for (let i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ mask.charCodeAt(i % mask.length));
  return out;
}

const Auth = {
  RPC: 'https://utyhyjeqzrqbnszljmdh.supabase.co/rest/v1/rpc',
  get ANON() {
    return _dk('AxgoHU8qAgonRCc8JhMiVy8LPF4kDzFdTi48RSAAFjk0NmdUTwYRZx0WQCQCKQgoD0k1IwsxQCsPKToiFSgMP0E3CCpeZAMjQww8DlQDGHsVBA0iVTQYRhMOCxkTF3o/DioBWgQWHlAYPDIrQ2QAJxYKH1kcPyohFjg6JEQiCyZbYik4QSQvMxYvD2QeKA4+GQ42Ol8mDCBXOnkoVS48bBc4HVlFBwIaGks4WRMMX1gePTAsFAMhJX8fTFYwdQMfSiwcISMHD2MkVFZaSi45EA==');
  },
  user: null,

  init() { this.user = localStorage.getItem('fabu.user') || null; },
  isLoggedIn() { return !!this.user; },

  async rpc(fn, body) {
    const res = await fetch(this.RPC + '/' + fn, {
      method: 'POST',
      headers: { apikey: this.ANON, Authorization: 'Bearer ' + this.ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('net');
    return res.json();
  },

  setUser(u) { this.user = u; localStorage.setItem('fabu.user', u); this.refreshUI(); },
  logout() {
    this.user = null;
    localStorage.removeItem('fabu.user');
    if (typeof Sync !== 'undefined') Sync.disconnect();
    this.refreshUI();
  },

  // Anything that prints the account name has to be redrawn, or it keeps showing
  // whoever was signed in when that panel was first built.
  refreshUI() {
    const acct = document.getElementById('acctModal');
    if (acct) acct.remove();
    if (typeof Windows !== 'undefined' && Windows.isOpen && Windows.isOpen('settings')) {
      const w = Windows.wins.get('settings');
      if (w && w.refresh) w.refresh();
    }
  },

  // Does this account still exist under this name? A username renamed straight
  // in the database leaves the app showing a stale cached name forever.
  // Needs the fabu_user_exists RPC; if it is not there we leave things as they are.
  async userExists(u) {
    try { const r = await this.rpc('fabu_user_exists', { u }); return r === true || r === 'true'; }
    catch (e) { return null; }   // RPC missing / offline -> unknown
  },

  // called once at startup: drop a cached login whose account is gone or renamed
  async verifyCached() {
    if (!this.user) return;
    const ok = await this.userExists(this.user);
    if (ok === false) {
      const was = this.user;
      this.logout();
      toast(tr('auth_stale', 'Signed out: the account "{name}" no longer exists.', { name: was }), 'red');
    }
  },

  // Run cb() once the user is logged in, opening the account modal first if needed.
  require(cb) {
    if (this.isLoggedIn()) { cb(); return; }
    this.open(cb);
  },

  open(onDone) {
    if (document.getElementById('authModal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'authModal';
    wrap.className = 'modal-back';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('auth_title', 'Account')}</div>
        <div class="modal-sub">${tr('auth_sub', 'You need an account to play together.')}</div>
        <div class="auth-tabs">
          <button class="auth-tab" data-tab="login">${tr('auth_login', 'Log in')}</button>
          <button class="auth-tab on" data-tab="register">${tr('auth_register', 'Register')}</button>
        </div>
        <input id="authUser" type="text" placeholder="${tr('auth_username', 'Username')}" spellcheck="false" autocomplete="off">
        <input id="authPass" type="password" placeholder="${tr('auth_password', 'Password')}">
        <div id="authErr" class="auth-err"></div>
        <div class="modal-btns">
          <button id="authCancel" class="fbtn">${tr('cancel', 'Cancel')}</button>
          <button id="authGo" class="fbtn accent">${tr('auth_register', 'Register')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    let mode = 'register'; // most people opening this need an account first
    const err = wrap.querySelector('#authErr');
    const go = wrap.querySelector('#authGo');
    const uEl = wrap.querySelector('#authUser');
    const pEl = wrap.querySelector('#authPass');
    const close = () => wrap.remove();

    wrap.querySelectorAll('.auth-tab').forEach(t => t.addEventListener('click', () => {
      mode = t.dataset.tab;
      wrap.querySelectorAll('.auth-tab').forEach(x => x.classList.toggle('on', x === t));
      go.textContent = mode === 'login' ? tr('auth_login', 'Log in') : tr('auth_register', 'Register');
      err.innerHTML = '';
    }));

    wrap.querySelector('#authCancel').addEventListener('click', close);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });

    const setErr = (text, tone) => { err.innerHTML = ''; err.textContent = text; err.style.color = tone || ''; };
    // a hint the user can act on, e.g. "no such user" -> a Yes button that
    // flips straight to Register with what they already typed
    const setErrAction = (text, btnText, fn) => {
      err.innerHTML = '';
      err.style.color = '';
      const span = document.createElement('span');
      span.textContent = text + ' ';
      const b = document.createElement('button');
      b.className = 'auth-inline';
      b.textContent = btnText;
      b.addEventListener('click', fn);
      err.append(span, b);
    };

    const submit = async () => {
      const u = uEl.value.trim(), p = pEl.value;
      if (!u || !p) { setErr(tr('auth_fill', 'Enter a username and password.')); return; }
      // a private gag: never shown to anyone else and the password still works
      if (/nigga/i.test(p)) toast(tr('auth_pw_joke', "what a funny password! you're a real comedian!"));
      if (mode === 'register' && typeof hasProfanity === 'function' && hasProfanity(u)) {
        setErr(tr('auth_profane', 'Sorry, please pick a different username.'));
        return;
      }
      go.disabled = true; setErr(tr('auth_working', 'Working…'));
      try {
        if (mode === 'register') {
          const r = await this.register(u, p);
          if (r === 'ok') { this.setUser(u.toLowerCase()); toast(tr('auth_welcome', 'Welcome, {name}', { name: u }), 'green'); close(); if (onDone) onDone(); }
          else if (r === 'taken') setErr(tr('auth_taken', 'Username already taken. Try another one.'));
          else if (r === 'invalid') setErr(tr('auth_invalid', 'Use 2 to 20 letters, numbers or _.'));
          else if (r === 'weakpass') setErr(tr('auth_weak', 'Password too short, use at least 6 characters.'));
          else setErr(tr('auth_error', 'Something went wrong.'));
        } else {
          const ok = await this.login(u, p);
          if (ok === true) { this.setUser(u.toLowerCase()); toast(tr('auth_welcome', 'Welcome, {name}', { name: u }), 'green'); close(); if (onDone) onDone(); }
          else {
            // say which half was wrong, instead of the unhelpful "one of these is wrong"
            const exists = await this.userExists(u);
            if (exists === false) {
              setErrAction(tr('auth_no_user', 'No account called "{name}". Want to create one?', { name: u }),
                tr('auth_yes', 'Yes'), () => {
                  const regTab = wrap.querySelector('[data-tab="register"]');
                  if (regTab) regTab.click();
                  setErr('');
                  pEl.focus();
                });
            } else if (exists === true) {
              setErr(tr('auth_wrong_pw', 'Wrong password.'));
            } else {
              setErr(tr('auth_bad', 'Wrong username or password.'));
            }
          }
        }
      } catch (e) {
        setErr(tr('auth_offline', 'Cannot reach the server.'));
      }
      go.disabled = false;
    };
    go.addEventListener('click', submit);
    pEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => uEl.focus(), 50);
  },

  register(u, p) { return this.rpc('fabu_register', { u, p }); },
  async login(u, p) { return this.rpc('fabu_login', { u, p }); },
  changePassword(u, oldp, newp) { return this.rpc('fabu_change_password', { u, oldp, newp }); },
  deleteAccount(u, p) { return this.rpc('fabu_delete_account', { u, p }); },

  // Account management: change password, log out, or delete the account.
  openAccount() {
    if (!this.isLoggedIn()) { this.open(() => this.openAccount()); return; }
    if (document.getElementById('acctModal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'acctModal';
    wrap.className = 'modal-back';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('acct_title', 'Your account')}</div>
        <div class="modal-sub">${tr('acct_signed_in', 'Signed in as {name}', { name: this.user })}</div>

        <div class="acct-section">
          <div class="acct-head">${tr('acct_change_pw', 'Change password')}</div>
          <input id="acctOld" type="password" placeholder="${tr('acct_current_pw', 'Current password')}">
          <input id="acctNew" type="password" placeholder="${tr('acct_new_pw', 'New password')}">
          <div id="acctPwMsg" class="auth-err"></div>
          <button id="acctPwGo" class="fbtn accent">${tr('acct_update_pw', 'Update password')}</button>
        </div>

        <div class="acct-section acct-danger">
          <div class="acct-head">${tr('acct_delete', 'Delete account')}</div>
          <div class="acct-note">${tr('acct_delete_note', 'This permanently removes your account. It cannot be undone.')}</div>
          <input id="acctDelPw" type="password" placeholder="${tr('acct_confirm_pw', 'Confirm with your password')}">
          <div id="acctDelMsg" class="auth-err"></div>
          <button id="acctDelGo" class="fbtn danger">${tr('acct_delete_btn', 'Delete my account')}</button>
        </div>

        <div class="modal-btns">
          <button id="acctLogout" class="fbtn">${tr('acct_logout', 'Log out')}</button>
          <button id="acctClose" class="fbtn accent">${tr('acct_done', 'Done')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    const $q = (s) => wrap.querySelector(s);

    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    $q('#acctClose').addEventListener('click', close);

    $q('#acctLogout').addEventListener('click', () => {
      this.logout();
      toast(tr('acct_logged_out', 'Logged out.'));
      close();
    });

    const pwBtn = $q('#acctPwGo');
    pwBtn.addEventListener('click', async () => {
      const oldp = $q('#acctOld').value, newp = $q('#acctNew').value;
      const msg = $q('#acctPwMsg');
      if (!oldp || !newp) { msg.textContent = tr('acct_fill_pw', 'Fill in both password fields.'); return; }
      pwBtn.disabled = true; msg.style.color = ''; msg.textContent = tr('auth_working', 'Working…');
      try {
        const r = await this.changePassword(this.user, oldp, newp);
        if (r === 'ok') { msg.style.color = 'var(--green)'; msg.textContent = tr('acct_pw_ok', 'Password updated.'); $q('#acctOld').value = ''; $q('#acctNew').value = ''; }
        else if (r === 'weakpass') msg.textContent = tr('auth_weak', 'Password too short.');
        else if (r === 'bad') msg.textContent = tr('acct_pw_bad', 'Current password is wrong.');
        else msg.textContent = tr('auth_error', 'Something went wrong.');
      } catch (e) { msg.textContent = tr('auth_offline', 'Cannot reach the server.'); }
      pwBtn.disabled = false;
    });

    const delBtn = $q('#acctDelGo');
    let armed = false;
    delBtn.addEventListener('click', async () => {
      const msg = $q('#acctDelMsg');
      const p = $q('#acctDelPw').value;
      if (!p) { msg.textContent = tr('acct_confirm_pw', 'Confirm with your password'); return; }
      if (!armed) { armed = true; delBtn.textContent = tr('acct_delete_sure', 'Click again to confirm'); return; }
      delBtn.disabled = true; msg.textContent = tr('auth_working', 'Working…');
      try {
        const ok = await this.deleteAccount(this.user, p);
        if (ok === true) { toast(tr('acct_deleted', 'Account deleted.')); this.logout(); close(); }
        else { msg.textContent = tr('acct_pw_bad', 'Current password is wrong.'); armed = false; delBtn.textContent = tr('acct_delete_btn', 'Delete my account'); }
      } catch (e) { msg.textContent = tr('auth_offline', 'Cannot reach the server.'); }
      delBtn.disabled = false;
    });
  }
};
