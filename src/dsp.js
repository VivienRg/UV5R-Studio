// Audio decoders: DTMF (Goertzel) and AFSK1200 / AX.25 / APRS.
(function (root) {
  const FS = 12000; // internal processing rate

  class Resampler {
    constructor(inRate, outRate = FS) { this.step = inRate / outRate; this.pos = 0; this.last = 0; }
    process(input) {
      const out = [];
      let pos = this.pos;
      while (pos < input.length) {
        const i = Math.floor(pos), f = pos - i;
        const a = i === 0 ? (i - 1 < 0 ? this.last : input[i - 1]) : input[i - 1];
        const s0 = i - 1 < 0 ? this.last : input[i - 1], s1 = input[i];
        out.push(s0 + (s1 - s0) * f);
        pos += this.step;
      }
      this.pos = pos - input.length;
      this.last = input[input.length - 1];
      return out;
    }
  }

  // ---------- DTMF ----------
  const LOW = [697, 770, 852, 941], HIGH = [1209, 1336, 1477, 1633];
  const KEYS = ['123A', '456B', '789C', '*#0D'];
  class DTMFDecoder {
    constructor(onDigit, rate = FS) {
      this.N = Math.round(rate * 0.02); this.rate = rate; this.buf = []; this.onDigit = onDigit;
      this.coeffs = [...LOW, ...HIGH].map(f => 2 * Math.cos(2 * Math.PI * Math.round(f * this.N / rate) / this.N));
      this.prev = null; this.stable = 0; this.emitted = null; this.silent = 0;
    }
    push(samples) { for (const s of samples) { this.buf.push(s); if (this.buf.length >= this.N) { this.frame(this.buf); this.buf = []; } } }
    frame(x) {
      let E = 0; for (const s of x) E += s * s;
      const N = x.length, P = this.coeffs.map(c => { let s1 = 0, s2 = 0; for (const v of x) { const s0 = v + c * s1 - s2; s2 = s1; s1 = s0; } return s1 * s1 + s2 * s2 - c * s1 * s2; });
      let digit = null;
      if (E / N > 1e-5) {
        const norm = E * N / 2;
        const li = P.slice(0, 4).indexOf(Math.max(...P.slice(0, 4)));
        const hi = P.slice(4).indexOf(Math.max(...P.slice(4)));
        const pl = P[li], ph = P[4 + hi];
        const twist = pl / ph;
        const others = P.filter((p, k) => k !== li && k !== 4 + hi).reduce((a, b) => Math.max(a, b), 0);
        if ((pl + ph) / norm > 0.6 && twist > 0.12 && twist < 8 && others < 0.1 * Math.min(pl, ph)) digit = KEYS[li][hi];
      }
      if (digit && digit === this.prev) this.stable++; else this.stable = digit ? 1 : 0;
      this.prev = digit;
      if (!digit) { this.silent++; if (this.silent >= 1) this.emitted = null; }
      else this.silent = 0;
      if (digit && this.stable >= 2 && this.emitted !== digit) { this.emitted = digit; this.onDigit(digit); }
    }
  }
  function dtmfFreqs(d) {
    for (let r = 0; r < 4; r++) { const c = KEYS[r].indexOf(d.toUpperCase()); if (c >= 0) return [LOW[r], HIGH[c]]; }
    return null;
  }
  function dtmfSamples(seq, rate = FS, onMs = 100, offMs = 60) {
    const out = [];
    for (const d of seq) {
      const f = dtmfFreqs(d);
      const n = Math.round(rate * onMs / 1000), z = Math.round(rate * offMs / 1000);
      if (f) for (let i = 0; i < n; i++) out.push(0.4 * Math.sin(2 * Math.PI * f[0] * i / rate) + 0.4 * Math.sin(2 * Math.PI * f[1] * i / rate));
      for (let i = 0; i < z; i++) out.push(0);
    }
    return out;
  }

  // ---------- AFSK1200 ----------
  function crc16x25(bytes) {
    let crc = 0xFFFF;
    for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >>> 1) ^ 0x8408 : crc >>> 1; }
    return crc;
  }
  class AFSKDecoder {
    constructor(onFrame, rate = FS) {
      this.rate = rate; this.spb = rate / 1200; this.win = Math.round(this.spb);
      this.onFrame = onFrame;
      this.ring = new Float32Array(this.win); this.ri = 0;
      this.mi = []; this.k = 0;
      this.tm = []; this.ts = [];
      for (let i = 0; i < this.win; i++) { }
      this.acc = { mc: 0, ms: 0, sc: 0, ss: 0 };
      this.hist = { mc: new Float32Array(this.win), ms: new Float32Array(this.win), sc: new Float32Array(this.win), ss: new Float32Array(this.win) };
      this.n = 0; this.phase = 0; this.lastD = 0; this.lastBit = 0;
      this.lp = 0;
      this.hdlc = { stream: 0, state: false, bitbuf: 0x80, bytes: [] };
    }
    push(samples) {
      const wm = 2 * Math.PI * 1200 / this.rate, ws = 2 * Math.PI * 2200 / this.rate, W = this.win, H = this.hist, A = this.acc;
      for (const x of samples) {
        const j = this.n % W;
        const mc = x * Math.cos(wm * this.n), ms = x * Math.sin(wm * this.n), sc = x * Math.cos(ws * this.n), ss = x * Math.sin(ws * this.n);
        A.mc += mc - H.mc[j]; A.ms += ms - H.ms[j]; A.sc += sc - H.sc[j]; A.ss += ss - H.ss[j];
        H.mc[j] = mc; H.ms[j] = ms; H.sc[j] = sc; H.ss[j] = ss;
        this.n++;
        const d = (A.mc * A.mc + A.ms * A.ms) - (A.sc * A.sc + A.ss * A.ss);
        this.lp += 0.5 * (d - this.lp);
        const v = this.lp;
        if ((v > 0) !== (this.lastD > 0)) this.phase += (0.5 - this.phase) * 0.3;
        this.lastD = v;
        this.phase += 1 / this.spb;
        if (this.phase >= 1) {
          this.phase -= 1;
          const cur = v > 0 ? 1 : 0;
          const bit = cur === this.lastBit ? 1 : 0;
          this.lastBit = cur;
          this.hdlcBit(bit);
        }
      }
    }
    hdlcBit(bit) {
      const s = this.hdlc;
      s.stream = ((s.stream << 1) | bit) & 0xFF;
      if (s.stream === 0x7E) {
        if (s.state && s.bytes.length >= 17) this.frame(s.bytes);
        s.state = true; s.bytes = []; s.bitbuf = 0x80; return;
      }
      if ((s.stream & 0x7F) === 0x7F) { s.state = false; return; }
      if (!s.state) return;
      if ((s.stream & 0x3F) === 0x3E) return; // stuffed zero
      if (bit) s.bitbuf |= 0x100;
      if (s.bitbuf & 1) { s.bytes.push((s.bitbuf >> 1) & 0xFF); s.bitbuf = 0x80; if (s.bytes.length > 400) s.state = false; return; }
      s.bitbuf >>= 1;
    }
    frame(bytes) {
      if (crc16x25(bytes) !== 0xF0B8) return;
      const p = parseAX25(bytes.slice(0, -2));
      if (p) this.onFrame(p);
    }
  }

  function parseAX25(b) {
    const addrs = []; let i = 0;
    while (i + 7 <= b.length) {
      let call = ''; for (let k = 0; k < 6; k++) { const c = b[i + k] >> 1; if (c !== 0x20) call += String.fromCharCode(c); }
      const ssid = (b[i + 6] >> 1) & 0x0F, h = (b[i + 6] & 0x80) && addrs.length >= 2;
      addrs.push(call + (ssid ? '-' + ssid : '') + (h ? '*' : ''));
      const last = b[i + 6] & 1; i += 7;
      if (last) break;
      if (addrs.length > 10) return null;
    }
    if (addrs.length < 2 || i + 2 > b.length) return null;
    const ctrl = b[i], pid = b[i + 1];
    const info = String.fromCharCode(...b.slice(i + 2));
    const [dst, src, ...path] = addrs;
    return { src, dst, path, ctrl, pid, info, text: `${src}>${dst}${path.length ? ',' + path.join(',') : ''}:${info}`, aprs: parseAPRS(info) };
  }

  function parseAPRS(info) {
    const m = info.match(/^[!=\/@](?:\d{6}[hz\/])?(\d{2})(\d{2}\.\d{2})([NS])(.)(\d{3})(\d{2}\.\d{2})([EW])(.)(.*)$/s);
    if (!m) {
      if (info[0] === ':') { const mm = info.match(/^:([^:]{9}):(.*)$/s); if (mm) return { type: 'message', to: mm[1].trim(), message: mm[2] }; }
      if (info[0] === '>') return { type: 'status', status: info.slice(1) };
      return null;
    }
    let lat = +m[1] + +m[2] / 60; if (m[3] === 'S') lat = -lat;
    let lon = +m[5] + +m[6] / 60; if (m[7] === 'W') lon = -lon;
    return { type: 'position', lat: +lat.toFixed(5), lon: +lon.toFixed(5), symbol: m[4] + m[8], comment: m[9].trim() };
  }

  // AFSK modulator (used for self-test and loopback check)
  function ax25Encode(src, dst, path, info) {
    const addr = (c, last) => { const [call, ssid = '0'] = c.split('-'); const o = []; const p = call.padEnd(6, ' '); for (let k = 0; k < 6; k++) o.push(p.charCodeAt(k) << 1); o.push(0x60 | ((+ssid & 15) << 1) | (last ? 1 : 0)); return o; };
    const all = [dst, src, ...path];
    let b = []; all.forEach((c, k) => b = b.concat(addr(c, k === all.length - 1)));
    b.push(0x03, 0xF0); for (const ch of info) b.push(ch.charCodeAt(0));
    const crc = crc16x25(b) ^ 0xFFFF; b.push(crc & 0xFF, crc >> 8);
    return b;
  }
  function afskSamples(frameBytes, rate = FS) {
    const bits = [];
    const flag = () => { for (let k = 0; k < 8; k++) bits.push((0x7E >> k) & 1); };
    for (let i = 0; i < 40; i++) flag();
    let ones = 0;
    for (const by of frameBytes) for (let k = 0; k < 8; k++) { const bit = (by >> k) & 1; bits.push(bit); if (bit) { ones++; if (ones === 5) { bits.push(0); ones = 0; } } else ones = 0; }
    for (let i = 0; i < 4; i++) flag();
    const out = []; let tone = 1, ph = 0, t = 0; const spb = rate / 1200;
    for (const bit of bits) {
      if (!bit) tone ^= 1;
      const f = tone ? 1200 : 2200;
      const end = t + spb;
      while (t < end) { out.push(0.5 * Math.sin(ph)); ph += 2 * Math.PI * f / rate; t += 1; }
    }
    return out;
  }

  const API = { FS, Resampler, DTMFDecoder, dtmfSamples, dtmfFreqs, AFSKDecoder, parseAX25, parseAPRS, ax25Encode, afskSamples, crc16x25 };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.DSP = API;
})(this);
