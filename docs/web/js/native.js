// desktop app bridge. In the app (Tauri) this builds the window.electronAPI
// the rest of fabu talks to; in a browser it does nothing.
'use strict';
(function () {
  const T = window.__TAURI__;
  if (!T || !T.core) return;
  const invoke = T.core.invoke;
  const on = (name, cb) => { T.event.listen(name, (e) => cb(e.payload)); };
  const cmd = (name) => (opts) => invoke(name, { opts: opts || {} });

  window.electronAPI = {
    saveFile: cmd('save_file'),
    writeFile: cmd('write_file'),
    saveToProjects: cmd('save_to_projects'),
    projectsDir: () => invoke('get_projects_dir'),
    revealPath: cmd('reveal_path'),
    openFile: cmd('open_file'),
    openPath: cmd('open_path'),
    getLanguages: () => invoke('get_languages'),
    autosaveWrite: cmd('autosave_write'),
    autosaveRead: () => invoke('autosave_read'),
    libraryWrite: cmd('library_write'),
    libraryRead: () => invoke('library_read'),
    onConfirmClose: (cb) => on('confirm-close', cb),
    confirmClose: () => invoke('close_confirmed'),
    cancelClose: () => invoke('close_cancelled'),
    setDirty: (dirty) => invoke('set_dirty', { dirty: !!dirty }),
    onUpdateReady: (cb) => on('update-ready', cb),
    onUpdateProgress: (cb) => on('update-progress', cb),
    onUpdateError: (cb) => on('update-error', cb),
    onUpdateRestarting: (cb) => on('update-restarting', cb),
    onUpdateDownloaded: (cb) => on('update-downloaded', cb),
    onFullscreen: (cb) => { on('fullscreen-changed', cb); invoke('is_fullscreen').then(cb).catch(() => {}); },
    restartNow: () => invoke('restart_now'),
    getVersion: () => invoke('get_version'),
    checkUpdates: () => invoke('check_updates'),
    installUpdate: () => invoke('install_update')
  };

  // links to websites open in the normal browser
  const external = (url) => /^https?:\/\//i.test(String(url || ''));
  const realOpen = window.open.bind(window);
  window.open = (url, ...rest) => {
    if (external(url)) { invoke('open_external', { url: String(url) }); return null; }
    return realOpen(url, ...rest);
  };
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || !external(a.href)) return;
    if (a.target === '_blank' || !a.href.startsWith(location.origin)) {
      e.preventDefault();
      invoke('open_external', { url: a.href });
    }
  }, true);

  // dragging the window by the top bar (what -webkit-app-region did in electron)
  const DRAG = '#dragbar, #topbar';
  const NO_DRAG = 'button, input, select, textarea, a, #posDisplay';
  const dragTarget = (e) => {
    const t = e.target;
    return t.closest && t.closest(DRAG) && !t.closest(NO_DRAG);
  };
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.detail > 1 || !dragTarget(e)) return;
    invoke('start_drag');
  });
  document.addEventListener('dblclick', (e) => { if (dragTarget(e)) invoke('toggle_maximize'); });

  // MIDI keyboards come in through the app (the mac webview has no Web MIDI)
  const inputs = new Map();
  const access = { inputs, outputs: new Map(), sysexEnabled: false, onstatechange: null };
  const syncPorts = (ports) => {
    const ids = new Set((ports || []).map((p) => p.id));
    for (const id of [...inputs.keys()]) if (!ids.has(id)) inputs.delete(id);
    for (const p of ports || []) {
      if (!inputs.has(p.id)) inputs.set(p.id, { id: p.id, name: p.name, type: 'input', state: 'connected', onmidimessage: null });
    }
    if (access.onstatechange) access.onstatechange({});
  };
  on('midi-ports', syncPorts);
  on('midi-msg', (m) => {
    const inp = inputs.get(m.id);
    if (inp && inp.onmidimessage) inp.onmidimessage({ data: new Uint8Array(m.data) });
  });
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true,
    value: () => invoke('midi_ports').then((p) => { syncPorts(p); return access; })
  });

  // first launch after switching from the electron app: bring its settings,
  // login and recent files along. App.init waits for this.
  let ready = Promise.resolve();
  try {
    if (!localStorage.getItem('fabu.importedOld')) {
      ready = invoke('legacy_storage').then((old) => {
        for (const [k, v] of Object.entries(old || {})) {
          try { localStorage.setItem(k, v); } catch (e) {}
        }
      }).catch(() => {}).then(() => {
        try { localStorage.setItem('fabu.importedOld', '1'); } catch (e) {}
      });
    }
  } catch (e) {}
  window.fabuNativeReady = ready;
})();
