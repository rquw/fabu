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

  setUser(u) { this.user = u; localStorage.setItem('fabu.user', u); },
  logout() { this.user = null; localStorage.removeItem('fabu.user'); if (typeof Sync !== 'undefined') Sync.disconnect(); },

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
          <button class="auth-tab on" data-tab="login">${tr('auth_login', 'Log in')}</button>
          <button class="auth-tab" data-tab="register">${tr('auth_register', 'Register')}</button>
        </div>
        <input id="authUser" placeholder="${tr('auth_username', 'Username')}" spellcheck="false" autocomplete="off">
        <input id="authPass" type="password" placeholder="${tr('auth_password', 'Password')}">
        <div id="authErr" class="auth-err"></div>
        <div class="modal-btns">
          <button id="authCancel" class="fbtn">${tr('cancel', 'Cancel')}</button>
          <button id="authGo" class="fbtn accent">${tr('auth_login', 'Log in')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    let mode = 'login';
    const err = wrap.querySelector('#authErr');
    const go = wrap.querySelector('#authGo');
    const uEl = wrap.querySelector('#authUser');
    const pEl = wrap.querySelector('#authPass');
    const close = () => wrap.remove();

    wrap.querySelectorAll('.auth-tab').forEach(t => t.addEventListener('click', () => {
      mode = t.dataset.tab;
      wrap.querySelectorAll('.auth-tab').forEach(x => x.classList.toggle('on', x === t));
      go.textContent = mode === 'login' ? tr('auth_login', 'Log in') : tr('auth_register', 'Register');
      err.textContent = '';
    }));

    wrap.querySelector('#authCancel').addEventListener('click', close);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });

    const submit = async () => {
      const u = uEl.value.trim(), p = pEl.value;
      if (!u || !p) { err.textContent = tr('auth_fill', 'Enter a username and password.'); return; }
      go.disabled = true; err.textContent = tr('auth_working', 'Working…');
      try {
        if (mode === 'register') {
          const r = await this.register(u, p);
          if (r === 'ok') { this.setUser(u.toLowerCase()); toast(tr('auth_welcome', 'Welcome, {name}', { name: u }), 'green'); close(); if (onDone) onDone(); }
          else if (r === 'taken') err.textContent = tr('auth_taken', 'That username is taken.');
          else if (r === 'invalid') err.textContent = tr('auth_invalid', 'Use 2 to 20 letters, numbers or _.');
          else if (r === 'weakpass') err.textContent = tr('auth_weak', 'Password too short.');
          else err.textContent = tr('auth_error', 'Something went wrong.');
        } else {
          const ok = await this.login(u, p);
          if (ok === true) { this.setUser(u.toLowerCase()); toast(tr('auth_welcome', 'Welcome, {name}', { name: u }), 'green'); close(); if (onDone) onDone(); }
          else err.textContent = tr('auth_bad', 'Wrong username or password.');
        }
      } catch (e) {
        err.textContent = tr('auth_offline', 'Cannot reach the server.');
      }
      go.disabled = false;
    };
    go.addEventListener('click', submit);
    pEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => uEl.focus(), 50);
  },

  register(u, p) { return this.rpc('fabu_register', { u, p }); },
  async login(u, p) { return this.rpc('fabu_login', { u, p }); }
};
