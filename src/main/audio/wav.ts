/** Turns 16 kHz mono Float32 samples into a 16-bit PCM WAV */
export function encodeWav(samples: Float32Array, sampleRate = 16000): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), o);
    o += 2;
  }
  return buf;
}

/** Turns a 16-bit PCM WAV back into Float32 samples (for tests and re-transcription) */
export function decodeWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  let o = 12;
  let sampleRate = 16000;
  let channels = 1;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(o + 10);
      sampleRate = buf.readUInt32LE(o + 12);
    } else if (id === 'data') {
      const n = Math.floor(size / 2 / channels);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(o + 8 + i * 2 * channels) / 0x8000;
      return { samples: out, sampleRate };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
