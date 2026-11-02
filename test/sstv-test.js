const SSTV = require('../src/sstv.js'); const D = require('../src/dsp.js');
function testImg(w, h) { const a = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; a[i] = x / w * 255; a[i + 1] = y / h * 255; a[i + 2] = ((x >> 5) + (y >> 5)) % 2 ? 230 : 30; a[i + 3] = 255; } return a; }
for (const mk of Object.keys(SSTV.MODES)) {
  const m = SSTV.MODES[mk]; const src = testImg(m.w, m.h);
  const txRate = 48000; let s = SSTV.encode(mk, src, txRate);
  // receive at 44.1k with a 0.05% clock error, noise, then resample to 24k
  const r1 = new D.Resampler(txRate * 1.0005, 44100); let rx = r1.process(Array.from(s)).map(v => v + (Math.random() - .5) * 0.1);
  let got = null, start = null;
  const dec = new SSTV.Decoder(24000, { onStart: k => start = k, onDone: r => got = r });
  const r2 = new D.Resampler(44100, 24000);
  const lead = new Array(44100).fill(0).map(() => (Math.random() - .5) * .1);
  for (const chunk of [lead, rx]) for (let i = 0; i < chunk.length; i += 4096) dec.push(r2.process(chunk.slice(i, i + 4096)));
  dec.push(new Array(48000).fill(0));
  let err = 0, n = 0; if (got) for (let i = 0; i < src.length; i++) if (i % 4 !== 3) { const x = (i >> 2) % m.w; if (x > 4 && x < m.w - 4) { err += Math.abs(src[i] - got.rgba[i]); n++; } }
  console.log(mk.padEnd(9), 'detected', start, ' mean abs error', got ? (err / n).toFixed(1) : 'NO IMAGE', ' seconds', (s.length / txRate).toFixed(1));
}
