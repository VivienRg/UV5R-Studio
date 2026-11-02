// Baofeng UV-5R memory codec and clone protocol (same wire format CHIRP uses).
(function (root) {
  const MEM_SIZE = 0x2000;
  const CH_COUNT = 128;
  const NAME_BASE = 0x1000;
  const SETTINGS_BASE = 0x0E20;
  const MESSAGE_BASE = 0x1EE0;
  const CHIRP_SIZE = 0x1948;
  const MAGICS = [
    [0x50, 0xBB, 0xFF, 0x20, 0x12, 0x07, 0x25], // BFB291+ firmware
    [0x50, 0xBB, 0xFF, 0x01, 0x25, 0x98, 0x4D]  // original firmware
  ];
  const READ_RANGES = [[0x0000, 0x1800], [0x1EC0, 0x2000]];
  const WRITE_RANGES = [[0x0000, 0x0800], [0x0E20, 0x0E50], [0x1000, 0x1800], [0x1EE0, 0x1EF0]];
  const DTCS = [23,25,26,31,32,36,43,47,51,53,54,65,71,72,73,74,114,115,116,122,125,131,132,134,143,145,152,155,156,162,165,172,174,205,212,223,225,226,243,244,245,246,251,252,255,261,263,265,266,271,274,306,311,315,325,331,332,343,346,351,356,364,365,371,411,412,413,423,431,432,445,446,452,454,455,462,464,465,466,503,506,516,523,526,532,546,565,606,612,624,627,631,632,645,654,662,664,703,712,723,731,732,734,743,754];

  // freq in MHz -> 4 bytes little-endian BCD, 10 Hz units
  function encFreq(mhz) {
    let n = Math.round(mhz * 100000);
    const s = String(n).padStart(8, '0');
    const out = [];
    for (let i = 0; i < 4; i++) {
      const pair = s.substr(6 - i * 2, 2);
      out.push((parseInt(pair[0]) << 4) | parseInt(pair[1]));
    }
    return out;
  }
  function decFreq(b) {
    if (b.every(x => x === 0xFF)) return null;
    if (b.some(x => (x & 0x0F) > 9 || (x >> 4) > 9)) return null;
    let s = '';
    for (let i = 3; i >= 0; i--) s += ((b[i] >> 4) & 0xF).toString() + (b[i] & 0xF).toString();
    return parseInt(s, 10) / 100000;
  }
  function encTone(tone) {
    if (!tone) return 0;
    if (typeof tone === 'number') return Math.round(tone * 10);
    if (tone.ctcss) return Math.round(tone.ctcss * 10);
    if (tone.dcs) {
      const i = DTCS.indexOf(+tone.dcs);
      if (i < 0) throw new Error('Unsupported DCS code ' + tone.dcs);
      return i + 1 + (tone.polarity === 'R' ? 0x69 : 0);
    }
    return 0;
  }
  function decTone(v) {
    if (v === 0 || v === 0xFFFF) return null;
    if (v >= 0x0258) return { ctcss: v / 10 };
    const reverse = v >= 0x6A;
    const code = DTCS[v - (reverse ? 0x6A : 1)];
    return code ? { dcs: code, polarity: reverse ? 'R' : 'N' } : null;
  }

  function emptyImage() { return new Uint8Array(MEM_SIZE).fill(0xFF); }

  function decodeChannel(img, i) {
    const o = i * 16;
    const m = img.subarray(o, o + 16);
    if (m[0] === 0xFF) return null;
    const rx = decFreq(Array.from(m.subarray(0, 4)));
    if (rx === null) return null;
    const tx = decFreq(Array.from(m.subarray(4, 8)));
    const rt = decTone(m[8] | (m[9] << 8));
    const tt = decTone(m[10] | (m[11] << 8));
    let duplex = '', offset = 0;
    if (tx === null) duplex = 'off';
    else if (Math.abs(tx - rx) < 0.000001) duplex = '';
    else if (Math.abs(tx - rx) <= 70) { duplex = tx > rx ? '+' : '-'; offset = +Math.abs(tx - rx).toFixed(6); }
    else { duplex = 'split'; offset = tx; }
    let toneMode = '', rtone = 88.5, ctone = 88.5, dcs = 23, rxDcs = 23, dcsPolarity = 'NN', crossMode = 'Tone->Tone';
    if (tt && tt.ctcss && rt && rt.ctcss && tt.ctcss === rt.ctcss) { toneMode = 'TSQL'; ctone = tt.ctcss; }
    else if (tt && tt.ctcss) { toneMode = 'Tone'; rtone = tt.ctcss; }
    else if (tt && tt.dcs && rt && rt.dcs && tt.dcs === rt.dcs) toneMode = 'DTCS';
    else if (tt || rt) {
      toneMode = 'Cross';
      const kind = t => !t ? '' : t.ctcss ? 'Tone' : 'DTCS';
      crossMode = kind(tt) + '->' + kind(rt);
    }
    if (tt && tt.dcs) dcs = tt.dcs;
    if (rt && rt.dcs) rxDcs = rt.dcs;
    dcsPolarity = (tt && tt.polarity || 'N') + (rt && rt.polarity || 'N');
    const nb = img.subarray(NAME_BASE + i * 16, NAME_BASE + i * 16 + 7);
    let name = '';
    for (const c of nb) { if (c === 0xFF || c === 0x00) break; name += String.fromCharCode(c); }
    return {
      name: name.trim(), rx, duplex, offset, toneMode, rtone, ctone,
      mode: (m[15] & 0x40) ? 'FM' : 'NFM',
      skip: (m[15] & 0x04) ? '' : 'S',
      power: (m[14] & 0x03) ? 'Low' : 'High',
      comment: '', dcs, rxDcs, dcsPolarity, crossMode,
      bcl: !!(m[15] & 0x08), pttid: m[15] & 0x03, scode: m[12] & 0x0F
    };
  }

  function encodeChannel(img, i, ch) {
    const o = i * 16;
    const no = NAME_BASE + i * 16;
    if (!ch) { img.fill(0xFF, o, o + 16); img.fill(0xFF, no, no + 16); return; }
    const wasEmpty = img[o] === 0xFF && img[o + 1] === 0xFF;
    const b = wasEmpty ? new Uint8Array(16) : img.slice(o, o + 16);
    const rx = +ch.rx;
    encFreq(rx).forEach((v, k) => b[k] = v);
    let tx = rx;
    if (ch.duplex === '+') tx = rx + +ch.offset;
    else if (ch.duplex === '-') tx = rx - +ch.offset;
    else if (ch.duplex === 'split') tx = +ch.offset;
    if (ch.duplex === 'off') b.fill(0xFF, 4, 8); else encFreq(tx).forEach((v, k) => b[4 + k] = v);
    let txt = 0, rxt = 0;
    if (ch.toneMode === 'Tone') txt = encTone(+ch.rtone);
    if (ch.toneMode === 'TSQL') { txt = encTone(+ch.ctone); rxt = txt; }
    if (ch.toneMode === 'DTCS') {
      txt = encTone({ dcs: ch.dcs || 23, polarity: (ch.dcsPolarity || 'NN')[0] });
      rxt = encTone({ dcs: ch.rxDcs || ch.dcs || 23, polarity: (ch.dcsPolarity || 'NN')[1] });
    }
    if (ch.toneMode === 'Cross') {
      const parts = String(ch.crossMode || 'Tone->Tone').split('->');
      if (parts[0] === 'Tone') txt = encTone(+ch.rtone);
      if (parts[0] === 'DTCS') txt = encTone({ dcs: ch.dcs || 23, polarity: (ch.dcsPolarity || 'NN')[0] });
      if (parts[1] === 'Tone') rxt = encTone(+ch.ctone);
      if (parts[1] === 'DTCS') rxt = encTone({ dcs: ch.rxDcs || ch.dcs || 23, polarity: (ch.dcsPolarity || 'NN')[1] });
    }
    b[8] = rxt & 0xFF; b[9] = rxt >> 8; b[10] = txt & 0xFF; b[11] = txt >> 8;
    b[12] = (b[12] & 0xE0) | ((rx >= 400 ? 1 : 0) << 4) | ((ch.scode == null ? b[12] : ch.scode) & 0x0F);
    if (wasEmpty) { b[12] = (rx >= 400 ? 1 : 0) << 4; b[13] = 0; }
    b[14] = (b[14] & 0xFC) | (ch.power === 'Low' ? 1 : 0);
    let f = wasEmpty ? 0 : b[15];
    f = ch.mode === 'NFM' ? (f & ~0x40) : (f | 0x40);
    f = ch.skip === 'S' ? (f & ~0x04) : (f | 0x04);
    f = ch.bcl ? (f | 0x08) : (f & ~0x08);
    f = (f & ~0x03) | ((ch.pttid || 0) & 0x03);
    b[15] = f & 0xFF;
    img.set(b, o);
    const name = String(ch.name || '').toUpperCase().replace(/[^ -~]/g, '').slice(0, 7);
    for (let k = 0; k < 7; k++) img[no + k] = k < name.length ? name.charCodeAt(k) : 0xFF;
    if (wasEmpty) img.fill(0xFF, no + 7, no + 16);
  }

  function decodeAll(img) { const a = []; for (let i = 0; i < CH_COUNT; i++) a.push(decodeChannel(img, i)); return a; }
  function encodeAll(img, chans) { const out = img.slice(); for (let i = 0; i < CH_COUNT; i++) encodeChannel(out, i, chans[i] || null); return out; }

  const bounded = (v, lo, hi, fallback = lo) => Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : fallback;
  function decodeSettings(img) {
    const b = img.subarray(SETTINGS_BASE, SETTINGS_BASE + 0x30);
    const line = o => String.fromCharCode(...img.subarray(o, o + 7)).replace(/[\x00\xff].*$/, '').trim();
    return { squelch: bounded(b[0],0,9), save: bounded(b[3],0,4), vox: bounded(b[4],0,10), backlight: bounded(b[6],0,10), dualWatch: !!b[7], beep: !!b[8], timeout: bounded(b[9],0,40), voice: bounded(b[14],0,2), scanResume: b[18] & 3, pttDelay: bounded(b[20],0,50), autoLock: !!b[24], startupMode: b[38] & 1, roger: !!b[39], startup1: line(MESSAGE_BASE), startup2: line(MESSAGE_BASE + 7) };
  }
  function encodeSettings(img, s) {
    const out = img.slice(), b = out.subarray(SETTINGS_BASE, SETTINGS_BASE + 0x30);
    b[0]=bounded(s.squelch,0,9); b[3]=bounded(s.save,0,4); b[4]=bounded(s.vox,0,10); b[6]=bounded(s.backlight,0,10); b[7]=s.dualWatch?1:0; b[8]=s.beep?1:0; b[9]=bounded(s.timeout,0,40); b[14]=bounded(s.voice,0,2); b[18]=(b[18]&~3)|bounded(s.scanResume,0,2); b[20]=bounded(s.pttDelay,0,50); b[24]=s.autoLock?1:0; b[38]=(b[38]&~1)|(s.startupMode?1:0); b[39]=s.roger?1:0;
    const put = (o, v) => { out.fill(0xFF,o,o+7); String(v||'').toUpperCase().replace(/[^ -~]/g,'').slice(0,7).split('').forEach((c,i)=>out[o+i]=c.charCodeAt(0)); };
    put(MESSAGE_BASE,s.startup1); put(MESSAGE_BASE+7,s.startup2); return out;
  }
  function toChirpImage(img, id) {
    const out = new Uint8Array(CHIRP_SIZE); out.fill(0xFF); if (id) out.set(Array.from(id).slice(0,8),0); out.set(img.subarray(0,0x1800),8); out.set(img.subarray(0x1EC0,0x2000),0x1808); return out;
  }
  function fromImage(data) {
    const d = data instanceof Uint8Array ? data : new Uint8Array(data), img = emptyImage(); let id = null;
    if (d.length === MEM_SIZE) img.set(d);
    else if (d.length === MEM_SIZE + 8) { id=Array.from(d.subarray(0,8)); img.set(d.subarray(8,8+MEM_SIZE)); }
    else if (d.length === CHIRP_SIZE) { id=Array.from(d.subarray(0,8)); img.set(d.subarray(8,0x1808),0); img.set(d.subarray(0x1808),0x1EC0); }
    else throw new Error('That file is not a supported UV-5R image');
    return {img,id};
  }

  // ---- Clone protocol over Web Serial ----
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  class Link {
    constructor(port) { this.port = port; this.buf = []; this.waiters = []; }
    async open() {
      await this.port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
      this.running = true;
      (async () => {
        try {
          while (this.running) {
            const { value, done } = await this.reader.read();
            if (done) break;
            for (const v of value) this.buf.push(v);
            this.waiters.splice(0).forEach(w => w());
          }
        } catch (e) { /* port closed */ }
      })();
    }
    async close() {
      this.running = false;
      try { await this.reader.cancel(); } catch { }
      try { this.reader.releaseLock(); } catch { }
      try { this.writer.releaseLock(); } catch { }
      try { await this.port.close(); } catch { }
    }
    async write(bytes) { await this.writer.write(new Uint8Array(bytes)); }
    flush() { this.buf.length = 0; }
    async read(n, timeout = 1500) {
      const t0 = Date.now();
      while (this.buf.length < n) {
        const left = timeout - (Date.now() - t0);
        if (left <= 0) break;
        await Promise.race([new Promise(r => this.waiters.push(r)), sleep(Math.min(left, 50))]);
      }
      return this.buf.splice(0, Math.min(n, this.buf.length));
    }
  }

  async function ident(link, log) {
    for (const magic of MAGICS) {
      link.flush();
      for (const b of magic) { await link.write([b]); await sleep(10); }
      const ack = await link.read(1, 1000);
      if (ack[0] !== 0x06) { log && log('No answer to handshake ' + magic.slice(3).map(h).join(' ')); await sleep(1000); continue; }
      await link.write([0x02]);
      let id = await link.read(8, 1500);
      const extra = await link.read(4, 150); id = id.concat(extra);
      if (id.length < 8) throw new Error('Radio sent a short ident. Check the cable is fully seated.');
      await link.write([0x06]);
      const ack2 = await link.read(1, 1000);
      if (ack2[0] !== 0x06) throw new Error('Radio refused ident acknowledgement.');
      return id;
    }
    throw new Error('Radio did not answer. Turn it on, push the cable fully in (two clicks), and try again.');
  }
  const h = v => v.toString(16).padStart(2, '0').toUpperCase();

  async function readBlock(link, addr, size, first) {
    await link.write([0x53, addr >> 8, addr & 0xFF, size]);
    if (!first) {
      const ack = await link.read(1);
      if (ack[0] !== 0x06) throw new Error('No ack before block 0x' + addr.toString(16));
    }
    const hdr = await link.read(4);
    if (hdr.length < 4 || hdr[0] !== 0x58 || ((hdr[1] << 8) | hdr[2]) !== addr || hdr[3] !== size)
      throw new Error('Bad block header at 0x' + addr.toString(16));
    const data = await link.read(size);
    if (data.length !== size) throw new Error('Short block at 0x' + addr.toString(16));
    await link.write([0x06]);
    await sleep(30);
    return data;
  }

  async function download(port, progress, log) {
    const link = new Link(port); await link.open();
    try {
      const id = await ident(link, log);
      const img = emptyImage();
      let total = 0, done = 0, first = true;
      READ_RANGES.forEach(([a, b]) => total += (b - a) / 0x40);
      for (const [a, b] of READ_RANGES) {
        for (let addr = a; addr < b; addr += 0x40) {
          img.set(await readBlock(link, addr, 0x40, first), addr);
          first = false; done++; progress && progress(done / total);
        }
      }
      const firmware = Array.from(img.subarray(0x1EF0,0x1EFE)).filter(v => v !== 0xFF && v !== 0).map(v => String.fromCharCode(v)).join('');
      return { img, ident: id, firmware };
    } finally { await link.close(); }
  }

  async function upload(port, img, progress, log, expectedIdent) {
    const link = new Link(port); await link.open();
    try {
      const actual = await ident(link, log);
      if (expectedIdent && Array.from(expectedIdent).slice(0,8).some((v,i) => v !== actual[i])) throw new Error('This image belongs to a different radio. Read this radio before writing it.');
      let total = 0, done = 0;
      WRITE_RANGES.forEach(([a, b]) => total += (b - a) / 0x10);
      for (const [a, b] of WRITE_RANGES) {
        for (let addr = a; addr < b; addr += 0x10) {
          await link.write([0x58, addr >> 8, addr & 0xFF, 0x10, ...img.subarray(addr, addr + 0x10)]);
          const ack = await link.read(1);
          if (ack[0] !== 0x06) throw new Error('Radio refused block 0x' + addr.toString(16));
          done++; progress && progress(done / total);
        }
      }
    } finally { await link.close(); }
  }

  // ---- CHIRP CSV ----
  const CSV_HDR = ['Location', 'Name', 'Frequency', 'Duplex', 'Offset', 'Tone', 'rToneFreq', 'cToneFreq', 'DtcsCode', 'DtcsPolarity', 'RxDtcsCode', 'CrossMode', 'Mode', 'TStep', 'Skip', 'Power', 'Comment', 'URCALL', 'RPT1CALL', 'RPT2CALL', 'DVCODE'];
  function parseCSV(text) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    const hdr = rows.shift().map(s => s.trim());
    const ix = k => hdr.indexOf(k);
    const out = new Array(CH_COUNT).fill(null);
    for (const r of rows) {
      if (r.length < 3 || !r[ix('Frequency')]) continue;
      const loc = parseInt(r[ix('Location')]);
      const pw = (r[ix('Power')] || '').toLowerCase();
      const ch = {
        name: r[ix('Name')] || '', rx: parseFloat(r[ix('Frequency')]), duplex: r[ix('Duplex')] || '',
        offset: parseFloat(r[ix('Offset')] || 0), toneMode: r[ix('Tone')] || '',
        rtone: parseFloat(r[ix('rToneFreq')] || 88.5), ctone: parseFloat(r[ix('cToneFreq')] || 88.5),
        mode: r[ix('Mode')] === 'NFM' ? 'NFM' : 'FM', skip: r[ix('Skip')] === 'S' ? 'S' : '',
        power: (pw.startsWith('low') || pw.startsWith('1')) ? 'Low' : 'High', comment: ix('Comment') >= 0 ? r[ix('Comment')] : '',
        dcs: +(r[ix('DtcsCode')] || 23), rxDcs: +(r[ix('RxDtcsCode')] || r[ix('DtcsCode')] || 23),
        dcsPolarity: r[ix('DtcsPolarity')] || 'NN', crossMode: r[ix('CrossMode')] || 'Tone->Tone'
      };
      if (!['', '+', '-', 'split', 'off'].includes(ch.duplex)) ch.duplex = '';
      if (!['', 'Tone', 'TSQL', 'DTCS', 'Cross'].includes(ch.toneMode)) ch.toneMode = '';
      if (loc >= 0 && loc < CH_COUNT && !isNaN(ch.rx)) out[loc] = ch;
    }
    return out;
  }
  function toCSV(chans) {
    const esc = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = [CSV_HDR.join(',')];
    chans.forEach((c, i) => {
      if (!c) return;
      lines.push([i, c.name, (+c.rx).toFixed(6), c.duplex, (+c.offset || 0).toFixed(6), c.toneMode, (+c.rtone).toFixed(1), (+c.ctone).toFixed(1), String(c.dcs||23).padStart(3,'0'), c.dcsPolarity||'NN', String(c.rxDcs||c.dcs||23).padStart(3,'0'), c.crossMode||'Tone->Tone', c.mode, '5.00', c.skip, c.power, c.comment, '', '', '', ''].map(esc).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  const API = { MEM_SIZE, CHIRP_SIZE, CH_COUNT, DTCS, encFreq, decFreq, encTone, decTone, emptyImage, decodeChannel, encodeChannel, decodeAll, encodeAll, decodeSettings, encodeSettings, toChirpImage, fromImage, download, upload, parseCSV, toCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.UV5R = API;
})(this);
