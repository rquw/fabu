// WebSocket to the room server, with auto-reconnect that resumes your seat.
export class Net extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.pid = null;
    this.token = null;
    this.code = null;
    this.name = '';
    this.face = 0;
    this.retry = 0;
    this.closedByUs = false;
    this.skew = 0;
    this.queue = [];
    this.opus = true;
  }
  get url() {
    const base = window.CV_SERVER || location.origin;
    return base.replace(/^http/, 'ws') + '/ws';
  }
  now() { return Date.now() + this.skew; }

  connect(first) {
    this.closedByUs = false;
    this.first = first;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      if (this.code) this.send({ t: 'join', code: this.code, pid: this.pid, token: this.token, name: this.name, face: this.face, opus: this.opus });
      else if (this.first) this.send({ ...this.first, opus: this.opus });
      for (const m of this.queue.splice(0)) this.send(m);
      this.emit('open');
    };
    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'welcome') {
        this.pid = msg.pid; this.token = msg.token; this.code = msg.code;
        try { sessionStorage.setItem('cv.seat', JSON.stringify({ code: this.code, pid: this.pid, token: this.token })); } catch {}
      }
      if (msg.t === 'state' && msg.room.now) this.skew = msg.room.now - Date.now();
      if (msg.t === 'error' && msg.code === 'no_room') { this.code = null; try { sessionStorage.removeItem('cv.seat'); } catch {} }
      this.emit(msg.t, msg);
    };
    ws.onclose = e => {
      this.emit('down', e);
      if (this.closedByUs || e.code === 4000 || e.code === 4001 || e.code === 4002) return;
      const wait = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => { if (!this.closedByUs) this.connect(); }, wait);
    };
  }

  create(name, face) { this.name = name; this.face = face; this.code = null; this.connect({ t: 'create', name, face }); }
  join(code, name, face) {
    this.name = name; this.face = face; this.code = code.toUpperCase();
    try {
      const seat = JSON.parse(sessionStorage.getItem('cv.seat') || 'null');
      if (seat && seat.code === this.code) { this.pid = seat.pid; this.token = seat.token; }
    } catch {}
    this.connect();
  }
  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    else if (msg.t !== 'ping') this.queue.push(msg);
  }
  leave() {
    this.send({ t: 'leave' });
    this.closedByUs = true;
    try { sessionStorage.removeItem('cv.seat'); } catch {}
    setTimeout(() => { try { this.ws.close(); } catch {} }, 100);
    this.code = null; this.pid = null; this.token = null;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { const f = e => fn(e.detail); this.addEventListener(type, f); return () => this.removeEventListener(type, f); }

  upload(path, body, headers = {}, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', (window.CV_SERVER || '') + path);
      xhr.setRequestHeader('x-pid', this.pid);
      xhr.setRequestHeader('x-token', this.token);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let res = {};
        try { res = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(res); else reject(new Error(res.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Network error while uploading.'));
      xhr.send(body);
      this.xhr = xhr;
    });
  }
}
