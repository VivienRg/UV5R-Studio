// Simulated UV-5R on a fake Web Serial port, to exercise the clone protocol.
const U = require('../src/uv5r.js');
global.window = {}; require('../src/channels-default.js');
const assert = require('assert');
function fakeRadio(mem) {
  let ctrl; const rx = []; let state = 'idle', magic = [];
  const send = b => setTimeout(() => ctrl.enqueue(new Uint8Array(b)), 2);
  const MAG = [0x50, 0xBB, 0xFF, 0x20, 0x12, 0x07, 0x25];
  function handle() {
    while (rx.length) {
      if (state === 'idle') { magic.push(rx.shift()); if (magic.length === 7) { if (magic.every((v, i) => v === MAG[i])) { send([6]); state = 'ident'; } magic = []; } continue; }
      if (state === 'ident') { if (rx.shift() === 2) { send([0xAA, 0x30, 0x76, 0x04, 0x00, 0x05, 0x20, 0xDD]); state = 'ack'; } continue; }
      if (state === 'ack') { if (rx.shift() === 6) { send([6]); state = 'clone'; } continue; }
      if (state === 'clone') {
        if (rx[0] === 0x53) { if (rx.length < 4) return; const [, a, b, n] = rx.splice(0, 4); const ad = (a << 8) | b; send([0x58, a, b, n, ...mem.subarray(ad, ad + n)]); state = 'wantack'; continue; }
        if (rx[0] === 0x58) { if (rx.length < 20) return; const [, a, b, n] = rx.splice(0, 4); const d = rx.splice(0, n); mem.set(d, (a << 8) | b); send([6]); continue; }
        rx.shift(); continue;
      }
      if (state === 'wantack') { if (rx.shift() === 6) { send([6]); state = 'clone'; } continue; }
    }
  }
  return {
    async open() {
      this.readable = new ReadableStream({ start(c) { ctrl = c; } });
      this.writable = new WritableStream({ write(chunk) { rx.push(...chunk); handle(); } });
    },
    async close() {}
  };
}
(async () => {
  const mem = U.emptyImage(); mem.fill(0x00, 0x0E00, 0x0E10); // pretend settings bytes
  const radio = fakeRadio(mem);
  const img0 = U.encodeAll(U.emptyImage(), window.DEFAULT_CHANNELS);
  await U.upload(radio, img0, null, console.log);
  assert(U.decodeAll(mem).filter(Boolean).length === 112, 'upload wrote 112');
  assert(mem[0x0E00] === 0, 'settings untouched');
  const r = await U.download(fakeRadio(mem), null, console.log);
  const chans = U.decodeAll(r.img);
  assert.strictEqual(chans[0].name, 'EM145'); assert.strictEqual(chans[111].name, 'WX7');
  console.log('protocol sim ok: wrote and read back', chans.filter(Boolean).length, 'channels, ident', r.ident.map(v => v.toString(16)).join(' '));
})().catch(e => { console.error(e); process.exit(1); });
