// ---------- Standard MIDI File import ----------
// Drop a .mid on the timeline and it becomes real, editable patterns rather
// than an opaque blob. Everything is converted to BEATS, not seconds, so the
// notes land on the bar grid and follow the project tempo like any other clip.
// (js/midi.js is the unrelated Web MIDI *input* feature: live keyboards.)
'use strict';

const MidiFile = {

  // ---------- parsing ----------

  // Reads a Standard MIDI File into { ppq, tempoBpm, tracks: [{ name, notes }] }
  // where each note is { pitch, start, length, vel } measured in beats.
  parse(buf) {
    const d = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const tag = (at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);

    if (buf.byteLength < 14 || tag(0) !== 'MThd') throw new Error('bad');

    const headLen = d.getUint32(4);
    const ntrks = d.getUint16(10);
    const division = d.getInt16(12);
    let p = 8 + headLen;

    // SMPTE timing (negative division) is film-frame based: there is no musical
    // beat grid to map it onto, so refuse instead of importing nonsense.
    if (division <= 0) throw new Error('smpte');
    const ppq = division;

    const tracks = [];
    let tempoBpm = null;

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
          } else if ((meta === 0x03 || meta === 0x01) && mlen && !name) {
            let s = '';
            for (let i = 0; i < mlen; i++) s += String.fromCharCode(u8[p + i]);
            name = s.replace(/[\x00-\x1f]/g, '').trim().slice(0, 40);
          }
          p += mlen;
          continue;
        }
        // sysex. The length must be read into a variable first: `p += varint()`
        // captures the old p before varint() advances it, losing one byte and
        // shifting every following event by whatever the last data byte was.
        if (status === 0xf0 || status === 0xf7) { const slen = varint(); p += slen; continue; }

        if (type === 0x90 || type === 0x80) {
          const pitch = u8[p], vel = u8[p + 1];
          p += 2;
          const key = (chan << 8) | pitch;
          // a note-on with velocity 0 is the common way of writing note-off
          if (type === 0x90 && vel > 0) {
            if (!open.has(key)) open.set(key, []);
            open.get(key).push({ tick, vel });
          } else {
            const stack = open.get(key);
            if (stack && stack.length) {
              const on = stack.shift();         // oldest first, so repeats nest right
              notes.push({
                pitch, chan,
                start: on.tick / ppq,
                length: Math.max(1 / 32, (tick - on.tick) / ppq),
                vel: Math.max(0.05, Math.min(1, on.vel / 127))
              });
            }
          }
          continue;
        }

        // program change and channel aftertouch carry one data byte, the rest two
        p += (type === 0xc0 || type === 0xd0) ? 1 : 2;
      }

      // notes still held when the track ends (sloppily written files): close them
      for (const [key, stack] of open) {
        for (const on of stack) {
          notes.push({
            pitch: key & 0xff, chan: key >> 8,
            start: on.tick / ppq, length: 1,
            vel: Math.max(0.05, Math.min(1, on.vel / 127))
          });
        }
      }

      notes.sort((a, b) => a.start - b.start);
      if (notes.length) tracks.push({ name, notes });
      p = end;
    }

    if (!tracks.length) throw new Error('empty');
    return { ppq, tempoBpm, tracks };
  },

  isMidiFile(f) { return /\.(mid|midi|smf)$/i.test(f.name) || f.type === 'audio/midi' || f.type === 'audio/x-midi'; },

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
    const start = Math.max(0, atBeat || 0);
    const multi = midi.tracks.length > 1;
    let total = 0, firstClip = null;

    // One offset for the WHOLE file, not one per track. Shifting each track by
    // its own first note would drop them all onto the same beat and destroy the
    // timing between them: a bass entering at bar 3 must stay two bars behind
    // the piano, not start with it.
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
      // round out to whole bars so the clip lines up with the grid
      const length = Math.max(4, Math.ceil((end - offset) / 4) * 4);

      const track = makeTrack('midi');
      track.name = multi ? tr('midi_track_n', 'Imported Midi {n}', { n: i + 1 }) : tr('midi_track', 'Imported Midi');
      track.instrument = 'rpiano';
      S.tracks.push(track);

      const clip = {
        id: uid('clip'), kind: 'midi',
        by: typeof authorName === 'function' ? authorName() : null,
        name: mt.name || track.name,
        start, length, notes
      };
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

    // The file's own tempo is not forced onto the project (that would rewrite
    // the timing of everything already there), but the user should be told it.
    const bpm = midi.tempoBpm ? Math.round(midi.tempoBpm) : null;
    toast(bpm && Math.abs(bpm - S.bpm) >= 1
      ? tr('midi_added_bpm', '{n} notes imported. The file was written at {bpm} BPM.', { n: total, bpm })
      : tr('midi_added', '{n} notes imported', { n: total }), 'green');
  }
};
window.MidiFile = MidiFile;
