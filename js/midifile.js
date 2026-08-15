// ---------- standard MIDI File import ----------
'use strict';

const MidiFile = {

  GM: ('Piano,Bright Piano,Electric Grand,Honky Tonk,Electric Piano,Electric Piano 2,Harpsichord,Clavinet,' +
    'Celesta,Glockenspiel,Music Box,Vibraphone,Marimba,Xylophone,Tubular Bells,Dulcimer,' +
    'Drawbar Organ,Percussive Organ,Rock Organ,Church Organ,Reed Organ,Accordion,Harmonica,Tango Accordion,' +
    'Nylon Guitar,Steel Guitar,Jazz Guitar,Clean Guitar,Muted Guitar,Overdrive Guitar,Distortion Guitar,Guitar Harmonics,' +
    'Acoustic Bass,Finger Bass,Pick Bass,Fretless Bass,Slap Bass,Slap Bass 2,Synth Bass,Synth Bass 2,' +
    'Violin,Viola,Cello,Contrabass,Tremolo Strings,Pizzicato Strings,Harp,Timpani,' +
    'String Ensemble,String Ensemble 2,Synth Strings,Synth Strings 2,Choir Aahs,Voice Oohs,Synth Voice,Orchestra Hit,' +
    'Trumpet,Trombone,Tuba,Muted Trumpet,French Horn,Brass Section,Synth Brass,Synth Brass 2,' +
    'Soprano Sax,Alto Sax,Tenor Sax,Baritone Sax,Oboe,English Horn,Bassoon,Clarinet,' +
    'Piccolo,Flute,Recorder,Pan Flute,Blown Bottle,Shakuhachi,Whistle,Ocarina,' +
    'Square Lead,Saw Lead,Calliope,Chiff Lead,Charang,Voice Lead,Fifths Lead,Bass and Lead,' +
    'New Age Pad,Warm Pad,Polysynth Pad,Choir Pad,Bowed Pad,Metallic Pad,Halo Pad,Sweep Pad,' +
    'Rain,Soundtrack,Crystal,Atmosphere,Brightness,Goblins,Echoes,Sci-Fi,' +
    'Sitar,Banjo,Shamisen,Koto,Kalimba,Bagpipe,Fiddle,Shanai,' +
    'Tinkle Bell,Agogo,Steel Drums,Woodblock,Taiko Drum,Melodic Tom,Synth Drum,Reverse Cymbal,' +
    'Guitar Fret Noise,Breath Noise,Seashore,Bird Tweet,Telephone Ring,Helicopter,Applause,Gunshot').split(','),

  partName(chan, prog) {
    if (chan === 9) return 'Drums';        // GM channel 10 is always percussion
    return this.GM[prog] || 'Part';
  },

  matchInstrument(chan, prog, trackName) {
    if (chan === 9) return 'drums';
    const hay = ((trackName || '') + ' ' + (this.GM[prog] || '')).toLowerCase();
    const rules = [
      [/drum|percussion|kit\b/, 'drums'],
      [/vibraphone|marimba|xylophone/, 'rvibes'],
      [/glocken|celesta|music box|tubular|bell/, 'rglock'],
      [/harp\b|harpsi/, 'rharp'],           // harpsichord is closer to plucked strings than to a grand
      [/organ|accordion|harmonica/, 'organ'],
      [/guitar|banjo|sitar|koto|shamisen|ukulele|mandolin|pizzicato|pluck/, 'pluck'],
      [/synth bass|808|sub bass/, 'sub'],
      [/bass\b|contrabass|tuba/, 'bass'],
      [/violin|viola|cello|string|fiddle|orchestra/, 'strings'],
      [/choir|voice|vocal|aah|ooh|pad\b|halo|sweep|atmosphere|new age|warm/, 'pad'],
      [/trumpet|trombone|horn|brass|sax|clarinet|oboe|bassoon|lead\b|square|saw\b/, 'synth'],
      [/e[- ]?piano|rhodes|wurli|electric piano|clav/, 'epiano'],
      [/piano|grand|keys/, 'rpiano']
    ];
    for (const [re, id] of rules) if (re.test(hay)) return id;
    return 'rpiano';
  },

  // ---------- parsing ----------
  parse(buf) {
    const d = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const tag = (at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);

    if (buf.byteLength < 14 || tag(0) !== 'MThd') throw new Error('bad');

    const headLen = d.getUint32(4);
    const ntrks = d.getUint16(10);
    const division = d.getInt16(12);
    let p = 8 + headLen;

    if (division <= 0) throw new Error('smpte');
    const ppq = division;

    const tracks = [];
    let tempoBpm = null, timeSig = null;

    for (let t = 0; t < ntrks && p + 8 <= buf.byteLength; t++) {
      if (tag(p) !== 'MTrk') {                 // unknown chunk: the spec says skip it
        p += 8 + d.getUint32(p + 4);
        continue;
      }
      const len = d.getUint32(p + 4);
      const end = Math.min(buf.byteLength, p + 8 + len);
      p += 8;

      const notes = [];
      const open = new Map();                  // (channel<<8|pitch) -> [{tick, vel}]
      const prog = new Map();                  // channel -> instrument in force right now
      const pedal = new Map();                 // channel -> [{ beat, on }] from CC64
      let tick = 0, status = 0, name = '';

      const varint = () => {
        let v = 0, b;
        do { b = u8[p++]; v = (v << 7) | (b & 0x7f); } while ((b & 0x80) && p < end);
        return v;
      };

      while (p < end) {
        tick += varint();
        if (p >= end) break;

        if (u8[p] & 0x80) status = u8[p++];     // otherwise: running status, reuse
        const type = status & 0xf0;
        const chan = status & 0x0f;

        if (status === 0xff) {                  // meta event
          const meta = u8[p++];
          const mlen = varint();
          if (meta === 0x51 && mlen === 3) {
            const us = (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2];
            if (us > 0 && tempoBpm == null) tempoBpm = 60000000 / us;
          } else if (meta === 0x58 && mlen >= 2 && !timeSig) {
            timeSig = [u8[p], Math.pow(2, u8[p + 1])];
          } else if ((meta === 0x03 || meta === 0x01) && mlen && !name) {
            let s = '';
            for (let i = 0; i < mlen; i++) s += String.fromCharCode(u8[p + i]);
            name = s.replace(/[\x00-\x1f]/g, '').trim().slice(0, 40);
          }
          p += mlen;
          continue;
        }
        if (status === 0xf0 || status === 0xf7) { const slen = varint(); p += slen; continue; }

        if (type === 0x90 || type === 0x80) {
          const pitch = u8[p], vel = u8[p + 1];
          p += 2;
          const key = (chan << 8) | pitch;
          if (type === 0x90 && vel > 0) {
            if (!open.has(key)) open.set(key, []);
            open.get(key).push({ tick, vel, prog: prog.get(chan) || 0 });
          } else {
            const stack = open.get(key);
            if (stack && stack.length) {
              const on = stack.shift();         // oldest first, so repeats nest right
              notes.push({
                pitch, chan, prog: on.prog,
                start: on.tick / ppq,
                length: Math.max(1 / 32, (tick - on.tick) / ppq),
                vel: Math.max(0.05, Math.min(1, on.vel / 127))
              });
            }
          }
          continue;
        }

        if (type === 0xb0 && u8[p] === 64) {
          const on = u8[p + 1] >= 64;
          if (!pedal.has(chan)) pedal.set(chan, []);
          const list = pedal.get(chan);
          if (!list.length || !!list[list.length - 1].on !== on) list.push({ beat: tick / ppq, on });
          p += 2;
          continue;
        }
        if (type === 0xc0) { prog.set(chan, u8[p]); p += 1; continue; }
        p += (type === 0xd0) ? 1 : 2;
      }

      for (const [key, stack] of open) {
        for (const on of stack) {
          notes.push({
            pitch: key & 0xff, chan: key >> 8, prog: on.prog,
            start: on.tick / ppq, length: 1,
            vel: Math.max(0.05, Math.min(1, on.vel / 127))
          });
        }
      }

      notes.sort((a, b) => a.start - b.start);
      const byPart = new Map();
      for (const n of notes) {
        const key = n.chan + ':' + (n.prog || 0);
        if (!byPart.has(key)) byPart.set(key, { name, chan: n.chan, prog: n.prog || 0, notes: [], pedal: pedal.get(n.chan) || [] });
        byPart.get(key).notes.push(n);
      }
      for (const part of byPart.values()) if (part.notes.length) tracks.push(part);
      p = end;
    }

    if (!tracks.length) throw new Error('empty');
    return { ppq, tempoBpm, timeSig, tracks };
  },

  isMidiFile(f) { return /\.(mid|midi|smf)$/i.test(f.name) || f.type === 'audio/midi' || f.type === 'audio/x-midi'; },

  // ---------- export ----------
  PPQ: 480,

  varint(n) {
    const out = [n & 0x7f];
    n >>= 7;
    while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
    return out;
  },

  chunk(tag, bytes) {
    const len = bytes.length;
    return [...tag].map(c => c.charCodeAt(0))
      .concat([(len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255], bytes);
  },

  trackEvents(track) {
    const ppq = this.PPQ;
    const ev = [];
    for (const c of track.clips) {
      if (c.kind !== 'midi' || !c.notes) continue;
      const sp = c.speed || 1;
      for (const n of c.notes) {
        if (n.start >= c.length) continue;
        const startBeat = c.start + n.start / sp;
        const lenBeat = Math.min(n.length, c.length - n.start) / sp;
        const on = Math.round(startBeat * ppq);
        const off = Math.max(on + 1, Math.round((startBeat + lenBeat) * ppq));
        const pitch = clamp(Math.round(n.pitch + (c.pitch || 0)), 0, 127);
        const vel = clamp(Math.round((n.vel ?? 0.9) * 127), 1, 127);
        ev.push({ t: on, order: 1, data: [0x90, pitch, vel] });
        ev.push({ t: off, order: 0, data: [0x80, pitch, 0] });
      }
      for (const sp2 of pedalSpans(c)) {
        ev.push({ t: Math.round((c.start + sp2.from) * ppq), order: 2, data: [0xb0, 64, 127] });
        ev.push({ t: Math.round((c.start + sp2.to) * ppq), order: 0, data: [0xb0, 64, 0] });
      }
    }
    ev.sort((a, b) => a.t - b.t || a.order - b.order);
    return ev;
  },

  DEFAULT_TRACK_NAME: /^(instrument|audio|track)\s*\d*$/i,
  DEFAULT_CLIP_NAME: /^(pattern|clip|p\d*|take\s*\d*)$/i,

  exportName(track, i) {
    const given = (track.name || '').trim();
    if (given && !this.DEFAULT_TRACK_NAME.test(given)) return given;

    let best = null, bestLen = -1;
    for (const c of track.clips || []) {
      if (c.kind !== 'midi' || !c.notes || !c.notes.length) continue;
      const cn = (c.name || '').trim();
      if (!cn || this.DEFAULT_CLIP_NAME.test(cn)) continue;
      const len = c.length || 0;
      if (len > bestLen) { bestLen = len; best = cn; }
    }
    if (best) return best;

    const instr = track.instrument && typeof INSTRUMENTS !== 'undefined' && INSTRUMENTS[track.instrument];
    return instr || given || ('Track ' + (i + 1));
  },

  build() {
    const ppq = this.PPQ;
    const tracks = (S.tracks || []).filter(t => t.kind === 'midi' && (t.clips || []).some(c => c.kind === 'midi' && c.notes && c.notes.length));
    if (!tracks.length) return null;

    let head = [];
    const us = Math.round(60000000 / (S.bpm || 120));
    head = head.concat(this.varint(0), [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255]);
    const num = (S.timeSig && S.timeSig[0]) || 4;
    const den = (S.timeSig && S.timeSig[1]) || 4;
    head = head.concat(this.varint(0), [0xff, 0x58, 0x04, num, Math.round(Math.log2(den)), 24, 8]);
    const title = (S.name || 'fabu').slice(0, 40);
    head = head.concat(this.varint(0), [0xff, 0x03, title.length], [...title].map(c => c.charCodeAt(0) & 127));
    head = head.concat(this.varint(0), [0xff, 0x2f, 0x00]);

    const ntrks = tracks.length + 1;
    let out = this.chunk('MThd', [0, 1, (ntrks >> 8) & 255, ntrks & 255, (ppq >> 8) & 255, ppq & 255]);
    out = out.concat(this.chunk('MTrk', head));

    tracks.forEach((t, i) => {
      let body = [];
      const nm = this.exportName(t, i).slice(0, 40);
      body = body.concat(this.varint(0), [0xff, 0x03, nm.length], [...nm].map(c => c.charCodeAt(0) & 127));
      const ch = Math.min(15, i < 9 ? i : i + 1);   // leave channel 10 to percussion
      let last = 0;
      for (const e of this.trackEvents(t)) {
        body = body.concat(this.varint(Math.max(0, e.t - last)));
        body = body.concat([e.data[0] | ch, e.data[1], e.data[2]]);
        last = e.t;
      }
      body = body.concat(this.varint(0), [0xff, 0x2f, 0x00]);
      out = out.concat(this.chunk('MTrk', body));
    });
    return new Uint8Array(out);
  },

  exportFile() {
    const bytes = this.build();
    if (!bytes) { toast(tr('midi_export_empty', 'There are no notes to export yet.'), 'red'); return; }
    const name = ((S.name || 'fabu').replace(/[\\/:*?"<>|]/g, '') || 'fabu') + '.mid';
    App.browserDownload(new Blob([bytes], { type: 'audio/midi' }), name);
    toast(tr('midi_export_done', 'Exported {name}', { name }), 'green');
  },

  // ---------- import ----------
  async importFiles(files, atBeat) {
    for (const f of files) await this.importOne(f, atBeat);
  },

  async importOne(file, atBeat) {
    let midi;
    try {
      midi = this.parse(await file.arrayBuffer());
    } catch (e) {
      const why = e && e.message;
      if (why === 'smpte') toast(tr('midi_smpte', 'That MIDI file uses film timing, which has no beat grid.'), 'red');
      else if (why === 'empty') toast(tr('midi_empty', 'That MIDI file has no notes in it.'), 'red');
      else toast(tr('midi_bad', 'That file could not be read as MIDI.'), 'red');
      return;
    }

    Undo.push('Import MIDI');

    const emptyProject = !S.tracks.some(t => (t.clips || []).length);
    let adopted = null;
    if (emptyProject) {
      const bpm = midi.tempoBpm ? Math.round(midi.tempoBpm) : null;
      if (bpm && bpm >= 20 && bpm <= 400) S.bpm = bpm;
      if (midi.timeSig && midi.timeSig[0] > 0 && midi.timeSig[1] > 0) S.timeSig = [midi.timeSig[0], midi.timeSig[1]];
      const base = (file.name || '').replace(/\.(mid|midi|smf)$/i, '').trim();
      if (base && (!S.name || S.name === 'Untitled')) S.name = base;
      adopted = { bpm: S.bpm, sig: S.timeSig[0] + '/' + S.timeSig[1] };
      const bpmInput = document.getElementById('bpmInput');
      if (bpmInput) bpmInput.value = S.bpm;
      const nameInput = document.getElementById('projName');
      if (nameInput && S.name) nameInput.value = S.name;
      Timeline.drawRuler();
    }
    this._adopted = adopted;

    const start = Math.max(0, atBeat || 0);
    const multi = midi.tracks.length > 1;
    let total = 0, firstClip = null;

    let offset = Infinity;
    for (const mt of midi.tracks) for (const n of mt.notes) if (n.start < offset) offset = n.start;
    if (!isFinite(offset)) offset = 0;

    midi.tracks.forEach((mt, i) => {
      let end = 0;
      for (const n of mt.notes) if (n.start + n.length > end) end = n.start + n.length;
      const notes = mt.notes.map(n => ({
        id: uid('note'),
        pitch: clamp(Math.round(n.pitch), 0, 127),
        start: n.start - offset,
        length: n.length,
        vel: n.vel
      }));
      const bpb = beatsPerBar();
      const length = Math.max(bpb, Math.ceil((end - offset) / bpb) * bpb);

      const track = makeTrack('midi');
      track.name = multi ? tr('midi_track_n', 'Imported Midi {n}', { n: i + 1 }) : tr('midi_track', 'Imported Midi');
      track.instrument = this.matchInstrument(mt.chan, mt.prog, mt.name);
      S.tracks.push(track);

      const gm = this.partName(mt.chan, mt.prog);
      const label = (mt.name && mt.name.toLowerCase().includes(gm.toLowerCase().split(' ')[0].toLowerCase()))
        ? mt.name
        : [mt.name, gm].filter(Boolean).join(' ');
      const clip = {
        id: uid('clip'), kind: 'midi',
        by: typeof authorName === 'function' ? authorName() : null,
        name: label || track.name,
        start, length, notes
      };
      const ped = (mt.pedal || [])
        .map(e => ({ beat: e.beat - offset, on: e.on }))
        .filter(e => e.beat >= -1e-9 && e.beat <= length + 1e-9);
      if (ped.length && ped[0].on === false) ped.shift();   // a lift with no press
      if (ped.length) clip.sustain = ped;
      track.clips.push(clip);
      if (!firstClip) firstClip = clip;
      total += notes.length;
    });

    Engine.rebuildTracks();
    if (typeof KeysPanel !== 'undefined' && KeysPanel.refreshTracks) KeysPanel.refreshTracks();
    Timeline.render();
    Windows.refreshAll();
    if (firstClip) App.selectClip(firstClip.id);
    if (UI.playing) Engine.liveEdit();

    const bpm = midi.tempoBpm ? Math.round(midi.tempoBpm) : null;
    if (this._adopted) {
      toast(tr('midi_adopted', '{n} notes imported. Project set to {bpm} BPM, {sig}.',
        { n: total, bpm: this._adopted.bpm, sig: this._adopted.sig }), 'green');
      return;
    }
    toast(tr('midi_added', '{n} notes imported', { n: total }), 'green');

    if (bpm && Math.abs(bpm - S.bpm) >= 1) {
      const from = Math.round(S.bpm);
      const change = await App.askYesNo({
        title: tr('midi_bpm_title', 'Change BPM from {a} to {b}?', { a: from, b: bpm }),
        body: tr('midi_bpm_body',
          'The MIDI file you imported is written at {b} BPM. Clicking "No" leaves the tempo at your old one, not synchronized to the MIDI file.',
          { b: bpm }),
        yes: tr('yes', 'Yes'),
        no: tr('no', 'No')
      });
      if (change) {
        Undo.push('Change BPM');
        App.setBpm(bpm);
        toast(tr('midi_bpm_changed', 'Tempo set to {b} BPM', { b: bpm }), 'green');
      }
    }
  }
};
window.MidiFile = MidiFile;
