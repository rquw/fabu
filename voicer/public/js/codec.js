// Takes travel as Opus packets in a tiny custom box ("CVO1") when WebCodecs is
// around, otherwise as a plain 16-bit WAV.
const SR = 48000;

function resample(pcm, from, to) {
  if (from === to) return pcm;
  const n = Math.round(pcm.length * to / from);
  const out = new Float32Array(n);
  const k = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * k, i0 = Math.floor(x), f = x - i0;
    out[i] = (pcm[i0] || 0) * (1 - f) + (pcm[i0 + 1] || 0) * f;
  }
  return out;
}

async function opusOk() {
  if (!window.AudioEncoder || !window.AudioDecoder) return false;
  try {
    const a = await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: SR, numberOfChannels: 1, bitrate: 48000 });
    const b = await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: SR, numberOfChannels: 1 });
    return a.supported && b.supported;
  } catch { return false; }
}

export async function encodeTake(pcm, sr) {
  if (await opusOk()) {
    try { return { fmt: 'cvop', blob: await encodeOpus(resample(pcm, sr, SR)) }; } catch (e) { console.warn('opus failed', e); }
  }
  return { fmt: 'wav', blob: encodeWav(resample(pcm, sr, 24000), 24000) };
}

async function encodeOpus(pcm) {
  const packets = [];
  let err = null;
  const enc = new AudioEncoder({ output: c => { const b = new Uint8Array(c.byteLength); c.copyTo(b); packets.push(b); }, error: e => { err = e; } });
  enc.configure({ codec: 'opus', sampleRate: SR, numberOfChannels: 1, bitrate: 48000 });
  const step = 4800;
  for (let i = 0; i < pcm.length; i += step) {
    const part = pcm.slice(i, i + step);
    enc.encode(new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: part.length, numberOfChannels: 1, timestamp: Math.round(i / SR * 1e6), data: part }));
  }
  await enc.flush();
  enc.close();
  if (err) throw err;
  let size = 12;
  for (const p of packets) size += 2 + p.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set([67, 86, 79, 49]);
  dv.setUint32(4, SR, true); dv.setUint32(8, pcm.length, true);
  let o = 12;
  for (const p of packets) { dv.setUint16(o, p.length, true); out.set(p, o + 2); o += 2 + p.length; }
  return new Blob([out], { type: 'application/octet-stream' });
}

function encodeWav(pcm, sr) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  return new Blob([buf], { type: 'audio/wav' });
}

export async function decodeTake(buf, ac) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 67 && u8[1] === 86 && u8[2] === 79 && u8[3] === 49) {
    const dv = new DataView(buf);
    const sr = dv.getUint32(4, true), total = dv.getUint32(8, true);
    const pcm = new Float32Array(total);
    let w = 0, err = null;
    const dec = new AudioDecoder({
      output: d => {
        const n = d.numberOfFrames;
        const tmp = new Float32Array(n);
        d.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' });
        if (w < total) pcm.set(tmp.subarray(0, Math.min(n, total - w)), w);
        w += n; d.close();
      },
      error: e => { err = e; },
    });
    dec.configure({ codec: 'opus', sampleRate: sr, numberOfChannels: 1 });
    let o = 12, ts = 0;
    while (o + 2 <= u8.length) {
      const len = dv.getUint16(o, true);
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: u8.subarray(o + 2, o + 2 + len) }));
      ts += 20000; o += 2 + len;
    }
    await dec.flush();
    dec.close();
    if (err) throw err;
    const ab = ac.createBuffer(1, total, sr);
    ab.copyToChannel(pcm, 0);
    return ab;
  }
  return await ac.decodeAudioData(buf.slice(0));
}
