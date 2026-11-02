const U = require('../src/uv5r.js'), D = require('../src/dsp.js');
const assert = require('assert');
let pass = 0; const t = (n, f) => { f(); pass++; console.log('ok', n); };
global.window = {}; require('../src/channels-default.js'); const defs = window.DEFAULT_CHANNELS;
t('bcd', () => { assert.deepStrictEqual(U.encFreq(145.0), [0x00, 0x00, 0x50, 0x14]); assert.strictEqual(U.decFreq(U.encFreq(446.00625)), 446.00625); });
t('invalid BCD and first-byte empty records stay empty', () => { assert.strictEqual(U.decFreq([0xfa,0,0,0]),null); const img=U.emptyImage(); img[1]=0; img[2]=0x57; assert.strictEqual(U.decodeChannel(img,0),null); });
t('DCS normal and reverse roundtrip', () => { for (const polarity of ['N','R']) { const v=U.encTone({dcs:645,polarity}); assert.deepStrictEqual(U.decTone(v),{dcs:645,polarity}); } });
t('roundtrip 112 channels', () => {
  const img = U.encodeAll(U.emptyImage(), defs);
  const back = U.decodeAll(img);
  defs.forEach((c, i) => { const b = back[i]; assert(b, 'ch' + i);
    assert.strictEqual(b.name, c.name); assert(Math.abs(b.rx - c.rx) < 1e-6);
    assert.strictEqual(b.duplex, c.duplex, c.name + ' duplex'); assert.strictEqual(b.mode, c.mode); assert.strictEqual(b.skip, c.skip); assert.strictEqual(b.power, c.power);
    if (c.duplex === 'split') { assert(Math.abs(b.offset - c.offset) < 1e-6); assert.strictEqual(b.toneMode, 'Tone'); assert.strictEqual(b.rtone, 67); } });
  for (let i = 112; i < 128; i++) assert.strictEqual(back[i], null);
});
t('csv roundtrip', () => { const csv = U.toCSV(defs); const p = U.parseCSV(csv); assert.strictEqual(p.filter(Boolean).length, 112); assert.strictEqual(p[50].name, 'ISSVOX'); });
t('settings and CHIRP image preserve unknown bytes', () => { const img=U.emptyImage(); img[0xe22]=0x42; const changed=U.encodeSettings(img,{squelch:5,save:1,vox:2,backlight:4,dualWatch:true,beep:true,timeout:3,voice:1,scanResume:2,pttDelay:5,autoLock:true,startupMode:1,roger:false,startup1:'UV5R',startup2:'STUDIO'}); assert.strictEqual(changed[0xe22],0x42); assert.strictEqual(U.decodeSettings(changed).startup2,'STUDIO'); const f=U.toChirpImage(changed,[1,2,3,4,5,6,7,8]); const back=U.fromImage(f); assert.deepStrictEqual(back.id,[1,2,3,4,5,6,7,8]); assert.strictEqual(back.img[0xe22],0x42); assert.strictEqual(back.img[0x1ee0],0x55); });
t('dtmf decode', () => { const got = []; const d = new D.DTMFDecoder(x => got.push(x)); const s = D.dtmfSamples('123A*#0D9'); const noisy = s.map(v => v + (Math.random() - 0.5) * 0.05); d.push(noisy); d.push(new Array(2000).fill(0)); assert.strictEqual(got.join(''), '123A*#0D9'); });
t('dtmf at 48k via resampler', () => { const got = []; const d = new D.DTMFDecoder(x => got.push(x)); const r = new D.Resampler(48000); const s = D.dtmfSamples('5551212', 48000); for (let i = 0; i < s.length; i += 4096) d.push(r.process(s.slice(i, i + 4096))); d.push(new Array(1000).fill(0)); assert.strictEqual(got.join(''), '5551212'); });
t('afsk aprs decode', () => {
  const got = []; const dec = new D.AFSKDecoder(f => got.push(f));
  const fr = D.ax25Encode('BV2XYZ-9', 'APRS', ['WIDE1-1'], '!2457.60N/12113.50E>Zhongli test');
  const s = D.afskSamples(fr); dec.push(s.map(v => v + (Math.random() - 0.5) * 0.2)); dec.push(new Array(500).fill(0));
  assert.strictEqual(got.length, 1, 'frames ' + got.length); assert.strictEqual(got[0].src, 'BV2XYZ-9'); assert.strictEqual(got[0].aprs.lat, 24.96); assert.strictEqual(got[0].aprs.lon, 121.225);
});
t('afsk at 44.1k via resampler', () => {
  const got = []; const dec = new D.AFSKDecoder(f => got.push(f)); const r = new D.Resampler(44100);
  const s = D.afskSamples(D.ax25Encode('BV2ABC', 'APRS', [], '>Status from Taoyuan'), 44100);
  for (let i = 0; i < s.length; i += 4096) dec.push(r.process(s.slice(i, i + 4096))); dec.push(new Array(500).fill(0));
  assert.strictEqual(got.length, 1); assert.strictEqual(got[0].aprs.type, 'status');
});
console.log(`\n${pass} tests passed`);
