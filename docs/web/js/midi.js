// Web MIDI input: play (and record) instruments from a physical MIDI keyboard.
// Notes flow through the same Engine.noteOn/noteOff path as the computer keys,
// so recording "just works" when a note-record take is running.
'use strict';
const MIDI = {
  access: null,
  inputs: [],
  enabled: true,

  init() {
    try { this.enabled = localStorage.getItem('fabu.midiOn') !== '0'; } catch (e) {}
    if (!this.supported()) return;
    navigator.requestMIDIAccess().then((a) => {
      this.access = a;
      a.onstatechange = () => this.refresh();
      this.refresh();
    }).catch(() => {});
  },

  supported() { return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess; },

  deviceNames() { return this.inputs.map(i => i.name || 'MIDI device'); },

  refresh() {
    if (!this.access) return;
    this.inputs = [...this.access.inputs.values()];
    for (const inp of this.inputs) {
      inp.onmidimessage = this.enabled ? (e) => this.onMessage(e) : null;
    }
    // keep the Settings panel's device list current
    if (typeof Windows !== 'undefined' && Windows.wins && Windows.wins.get('settings')) {
      const w = Windows.wins.get('settings');
      if (w && w.refresh) w.refresh();
    }
  },

  setEnabled(on) {
    this.enabled = on;
    try { localStorage.setItem('fabu.midiOn', on ? '1' : '0'); } catch (e) {}
    this.refresh();
  },

  // the instrument track a MIDI key should play (same as the on-screen keyboard)
  target() {
    return (typeof KeysPanel !== 'undefined' && KeysPanel.targetTrack && KeysPanel.targetTrack()) || null;
  },

  onMessage(e) {
    const [status, d1, d2] = e.data;
    const cmd = status & 0xf0;
    if (cmd !== 0x90 && cmd !== 0x80) return;   // note on / note off only
    const t = this.target();
    if (!t) return;
    if (cmd === 0x90 && d2 > 0) Engine.noteOn(t.id, d1, Math.max(0.05, d2 / 127));
    else Engine.noteOff(t.id, d1);
  }
};
window.MIDI = MIDI;
