import { audioCtx } from './audio.js';
import { prefs } from './util.js';

function tone(freq, dur, { type = 'sine', vol = 0.18, at = 0, slide = 0 } = {}) {
  if (prefs.get('sfxOff', false)) return;
  const ac = audioCtx();
  const t = ac.currentTime + at;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

export const sfx = {
  tick() { tone(880, 0.09, { type: 'square', vol: 0.07 }); },
  go() { tone(1320, 0.25, { type: 'square', vol: 0.08 }); tone(1760, 0.3, { vol: 0.08, at: 0.05 }); },
  yes() { tone(660, 0.12, { type: 'triangle' }); tone(990, 0.2, { type: 'triangle', at: 0.08 }); },
  no() { tone(220, 0.25, { type: 'sawtooth', vol: 0.07, slide: 0.6 }); },
  click() { tone(1200, 0.03, { type: 'square', vol: 0.04 }); },
  join() { tone(523, 0.1, { type: 'triangle' }); tone(784, 0.14, { type: 'triangle', at: 0.07 }); },
  fanfare() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.35, { type: 'triangle', vol: 0.12, at: i * 0.11 })); },
  drum(n = 14) { for (let i = 0; i < n; i++) tone(90 + Math.random() * 30, 0.06, { type: 'triangle', vol: 0.12, at: i * 0.055 }); },
};
