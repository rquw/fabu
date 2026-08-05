// ---------- Standard MIDI File import ----------
// Drop a .mid on the timeline and it becomes real, editable patterns rather
// than an opaque blob. Everything is converted to BEATS, not seconds, so the
// notes land on the bar grid and follow the project tempo like any other clip.
// (js/midi.js is the unrelated Web MIDI *input* feature: live keyboards.)
'use strict';

const MidiFile = {

  // General MIDI instrument names. Only used to LABEL the lane a part landed
  // on, so you can tell the trumpet line from the bass line while dragging it
  // around. The sound is always piano: a MIDI file is notes, not instruments.
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
            // numerator, then denominator as a power of two (3, 2 => 3/4)
            timeSig = [u8[p], Math.pow(2, u8[p + 1])];
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
            // stamp the note with whatever instrument was selected at the time,
            // so a part that changes instrument later can be split off
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

        // sustain pedal (CC64). Without this, exported piano parts come in
        // sounding clipped and short, because the pedal is where most of a
        // piano performance's length actually lives.
        if (type === 0xb0 && u8[p] === 64) {
          const on = u8[p + 1] >= 64;
          if (!pedal.has(chan)) pedal.set(chan, []);
          const list = pedal.get(chan);
          if (!list.length || !!list[list.length - 1].on !== on) list.push({ beat: tick / ppq, on });
          p += 2;
          continue;
        }
        // program change picks a new instrument for this channel from here on
        if (type === 0xc0) { prog.set(chan, u8[p]); p += 1; continue; }
        // channel aftertouch carries one data byte, everything else two
        p += (type === 0xd0) ? 1 : 2;
      }

      // notes still held when the track ends (sloppily written files): close them
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
      // A MIDI "track" is not a part. Format 0 files put every instrument in one
      // chunk separated only by channel, and a single channel can switch
      // instrument partway through. Split on both so each distinct voice gets
      // its own lane you can drag around on its own.
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

    // An empty project has no opinions worth protecting, so the file's own
    // tempo and time signature are adopted rather than forced into 120 / 4-4.
    // A project with work in it keeps its settings; we only report the file's.
    const emptyProject = !S.tracks.some(t => (t.clips || []).length);
    let adopted = null;
    if (emptyProject) {
      const bpm = midi.tempoBpm ? Math.round(midi.tempoBpm) : null;
      if (bpm && bpm >= 20 && bpm <= 400) S.bpm = bpm;
      if (midi.timeSig && midi.timeSig[0] > 0 && midi.timeSig[1] > 0) S.timeSig = [midi.timeSig[0], midi.timeSig[1]];
      const base = (file.name || '').replace(/\.(mid|midi|smf)$/i, '').trim();
      if (base && (!S.name || S.name === 'Untitled')) S.name = base;
      adopted = { bpm: S.bpm, sig: S.timeSig[0] + '/' + S.timeSig[1] };
      // the tempo box, the bar grid and the project title all read these
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
      // round out to whole bars so the clip lines up with the grid. Uses the
      // project's actual bar length, so a 3/4 file is not padded to 4/4.
      const bpb = beatsPerBar();
      const length = Math.max(bpb, Math.ceil((end - offset) / bpb) * bpb);

      const track = makeTrack('midi');
      track.name = multi ? tr('midi_track_n', 'Imported Midi {n}', { n: i + 1 }) : tr('midi_track', 'Imported Midi');
      // Always piano. A MIDI file is notes; picking sounds is your job.
      track.instrument = 'rpiano';
      S.tracks.push(track);

      // The clip is labelled with what the file called this part, so you can
      // tell the trumpet line from the bass line when dragging lanes around.
      const label = [mt.name, this.partName(mt.chan, mt.prog)].filter(Boolean).join(' ');
      const clip = {
        id: uid('clip'), kind: 'midi',
        by: typeof authorName === 'function' ? authorName() : null,
        name: label || track.name,
        start, length, notes
      };
      // the pedal moves with the notes and is trimmed to the clip
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

    // The file's own tempo is not forced onto the project (that would rewrite
    // the timing of everything already there), but the user should be told it.
    const bpm = midi.tempoBpm ? Math.round(midi.tempoBpm) : null;
    if (this._adopted) {
      toast(tr('midi_adopted', '{n} notes imported. Project set to {bpm} BPM, {sig}.',
        { n: total, bpm: this._adopted.bpm, sig: this._adopted.sig }), 'green');
    } else {
      toast(bpm && Math.abs(bpm - S.bpm) >= 1
        ? tr('midi_added_bpm', '{n} notes imported. The file was written at {bpm} BPM.', { n: total, bpm })
        : tr('midi_added', '{n} notes imported', { n: total }), 'green');
    }
  }
};
window.MidiFile = MidiFile;
