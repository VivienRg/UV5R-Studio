const CW = require('../src/cw.js'); const assert = require('assert');
for (const [wpm, noise, tone] of [[12, 0.05, 700], [20, 0.15, 650], [28, 0.1, 900], [18, 0.3, 800]]) {
  let got = ''; const d = new CW.Decoder(c => got += c, 12000, { wpm: 18 });
  const msg = 'CQ CQ DE BV2XYZ BV2XYZ K';
  const s = CW.encode(msg, 12000, wpm, tone);
  const x = Array.from(s, v => v + (Math.random() - .5) * noise);
  d.push(new Array(6000).fill(0).map(() => (Math.random() - .5) * noise)); for (let i = 0; i < x.length; i += 1024) d.push(x.slice(i, i + 1024)); d.push(new Array(24000).fill(0).map(() => (Math.random() - .5) * noise));
  console.log(wpm + 'wpm noise ' + noise + ':', JSON.stringify(got.trim()), 'est', d.wpm);
}
