const SSTV = require('' + __dirname + '/../src/sstv.js'), CW = require('' + __dirname + '/../src/cw.js'), D = require('' + __dirname + '/../src/dsp.js');
const fs = require('fs'); const sr = 48000; const parts = [];
const sil = s => new Float32Array(Math.round(s * sr));
const m = SSTV.MODES.robot36, img = new Uint8ClampedArray(m.w * m.h * 4);
for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) { const i = (y * m.w + x) * 4; const bar = Math.floor(x / (m.w / 7)); const c = [[255,255,255],[255,255,0],[0,255,255],[0,255,0],[255,0,255],[255,0,0],[0,0,255]][bar]; const k = y > 180 ? 0.3 : 1; img[i] = c[0]*k; img[i+1] = c[1]*k; img[i+2] = c[2]*k; img[i+3] = 255; }
parts.push(sil(2), CW.encode('CQ CQ DE BV2XYZ K', sr, 20, 700), sil(3));
parts.push(Float32Array.from(D.afskSamples(D.ax25Encode('BV2XYZ', 'APZUV5', ['WIDE1-1'], ':BV2ABC   :Hello from Zhongli, are you there?{12'), sr)), sil(3));
parts.push(SSTV.encode('robot36', img, sr), sil(4));
const n = parts.reduce((a, p) => a + p.length, 0); const pcm = Buffer.alloc(44 + n * 2); let o = 44;
for (const p of parts) for (const v of p) { pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round((v + (Math.random() - .5) * 0.02) * 26000))), o); o += 2; }
const h = (s, off) => pcm.write(s, off);
h('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); h('WAVE', 8); h('fmt ', 12); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(sr, 24); pcm.writeUInt32LE(sr * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); h('data', 36); pcm.writeUInt32LE(n * 2, 40);
fs.writeFileSync(__dirname + '/e2e.wav', pcm); console.log('seconds', n / sr);
