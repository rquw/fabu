import { FPS, bandDb, normEnv, smooth } from './analyze.js';
import { b64ToU8, clamp, rng, hashStr } from './util.js';

export const JUDGES = [
  { name: 'Rhonda Rhythm', key: 'rhythm', bar: 64, color: '#ff4d6d', hat: 'bow',
    yes: ['Every beat. Chef’s kiss.', 'You FELT that line.', 'Metronome behaviour.'],
    no: ['Where was the groove?', 'Off-beat and proud of it.', 'That rhythm filed for divorce.'] },
  { name: 'Sir Stopwatch', key: 'duration', bar: 62, color: '#ffb703', hat: 'top',
    yes: ['Punctual. Magnificent.', 'Right on the clock.', 'Timing, sir. Impeccable.'],
    no: ['You ran long, old sport.', 'The clip ended. You didn’t.', 'Too early to the party.'] },
  { name: 'Carl Coverage', key: 'coverage', bar: 58, color: '#3ddc97', hat: 'cap',
    yes: ['Nothing left unsaid.', 'Filled every gap.', 'Full coverage, full marks.'],
    no: ['Half the line went missing.', 'Did you forget the words?', 'Gaps you could drive a bus through.'] },
  { name: 'Nana Gloria', key: 'total', bar: 44, color: '#b388ff', hat: 'hair',
    yes: ['Oh sweetie, wonderful!', 'Just like the pictures!', 'I’m telling the whole bingo club.'],
    no: ['Bless your heart.', 'Maybe try singing it?', 'I still love you, dear.'] },
  { name: 'The Critic', key: 'total', bar: 80, color: '#4cc9f0', hat: 'beret',
    yes: ['...Fine. It was good.', 'Grudgingly: bravo.', 'I’ll allow it.'],
    no: ['Derivative.', 'I have seen better at a bus stop.', 'Two thumbs, both down.'] },
];

export function grade(total) {
  if (total >= 92) return 'LEGENDARY';
  if (total >= 82) return 'OSCAR BAIT';
  if (total >= 70) return 'BOX OFFICE HIT';
  if (total >= 55) return 'DIRECT-TO-DVD';
  if (total >= 38) return 'STRAIGHT TO TIKTOK';
  if (total > 0) return 'BLOOPER REEL';
  return 'DEAD AIR';
}

export function refEnvelope(clip) {
  const u8 = b64ToU8(clip.env || '');
  const env = new Float32Array(u8.length);
  for (let i = 0; i < u8.length; i++) env[i] = u8[i] / 255;
  return env;
}

export function takeEnvelope(pcm, sr) {
  return normEnv(bandDb(pcm, sr));
}

function active(env, thr = 0.35) { return env.map(v => (v > thr ? 1 : 0)); }
function dilate(a, r) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) if (a[i]) for (let k = -r; k <= r; k++) { const j = i + k; if (j >= 0 && j < a.length) out[j] = 1; }
  return out;
}
function corr(a, b, lag) {
  let sa = 0, sb = 0, n = 0;
  for (let i = 0; i < a.length; i++) { const j = i + lag; if (j < 0 || j >= b.length) continue; sa += a[i]; sb += b[j]; n++; }
  if (n < 10) return 0;
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    const j = i + lag; if (j < 0 || j >= b.length) continue;
    const x = a[i] - ma, y = b[j] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
function span(act) {
  let first = -1, last = -1, talk = 0;
  for (let i = 0; i < act.length; i++) if (act[i]) { if (first < 0) first = i; last = i; talk++; }
  return { first, last, talk, len: first < 0 ? 0 : last - first + 1 };
}

// 58% rhythm, 32% duration, 10% coverage — same weights as the original.
export function scoreTake(refEnv, userEnv, seedStr = '') {
  const n = Math.min(refEnv.length, userEnv.length) || refEnv.length;
  const ref = smooth(refEnv.subarray(0, n), 2);
  const usr = smooth(userEnv.subarray(0, n), 2);
  const ra = active(ref), ua = active(usr);
  const rs = span(ra), us = span(ua);

  let rhythm = 0, duration = 0, coverage = 0;
  if (us.talk < FPS * 0.15) {
    return finish({ rhythm: 0, duration: 0, coverage: 0, total: 0, silent: true }, seedStr);
  }
  if (rs.talk < FPS * 0.3) {
    // clip without much dialogue: reward restraint-ish, keep it playable
    const quiet = 1 - us.talk / n;
    rhythm = 40 + 40 * quiet; duration = 50 + 30 * quiet; coverage = 60;
  } else {
    let best = -1;
    const maxLag = Math.round(FPS * 0.3);
    for (let l = -maxLag; l <= maxLag; l++) {
      const c = corr(ref, usr, l) * (1 - Math.abs(l) / (maxLag * 4));
      if (c > best) best = c;
    }
    const rd = dilate(ra, 4), ud = dilate(ua, 4);
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < n; i++) {
      if (ua[i] && rd[i]) tp++; else if (ua[i]) fp++;
      if (ra[i] && !ud[i]) fn++;
    }
    const f1 = tp ? (2 * tp) / (2 * tp + fp + fn) : 0;
    rhythm = 100 * clamp(0.55 * clamp((best - 0.08) / 0.62) + 0.45 * f1);

    const talkRatio = Math.min(rs.talk, us.talk) / Math.max(rs.talk, us.talk);
    const spanRatio = Math.min(rs.len, us.len) / Math.max(rs.len, us.len);
    const late = Math.abs(us.first - rs.first) / FPS;
    const end = Math.abs(us.last - rs.last) / FPS;
    duration = 100 * clamp(0.55 * talkRatio + 0.45 * spanRatio - clamp((late - 0.25) / 1.5) * 0.25 - clamp((end - 0.4) / 2) * 0.15);

    let hit = 0;
    for (let i = 0; i < n; i++) if (ra[i] && ud[i]) hit++;
    coverage = 100 * clamp(hit / rs.talk);
  }
  rhythm = Math.round(rhythm); duration = Math.round(duration); coverage = Math.round(coverage);
  const total = Math.round(0.58 * rhythm + 0.32 * duration + 0.1 * coverage);
  return finish({ rhythm, duration, coverage, total }, seedStr);
}

function finish(s, seedStr) {
  const r = rng(hashStr(seedStr + ':' + s.total));
  s.judges = JUDGES.map(j => {
    const v = (j.key === 'total' ? s.total : s[j.key]) + (r() - 0.5) * 10;
    const yes = !s.silent && v >= j.bar;
    const pool = yes ? j.yes : j.no;
    return { yes, line: s.silent ? 'Hello? Anybody there?' : pool[Math.floor(r() * pool.length)] };
  });
  s.judgePts = s.judges.filter(j => j.yes).length;
  s.grade = grade(s.total);
  return s;
}
