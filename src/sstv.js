// SSTV image modes: Robot 36, Martin M1, Scottie S1, PD120. Encoder and streaming decoder.
(function (root) {
  const MODES = {
    robot36: { name: 'Robot 36', vis: 8, w: 320, h: 240, lines: 240, pre: 0,
      seg: y => [['S', 9], ['P1500', 3], ['Y', 88], [y % 2 ? 'P2300' : 'P1500', 4.5], ['P1900', 1.5], [y % 2 ? 'U' : 'V', 44]] },
    martin1: { name: 'Martin M1', vis: 44, w: 320, h: 256, lines: 256, pre: 0,
      seg: () => [['S', 4.862], ['P1500', 0.572], ['G', 146.432], ['P1500', 0.572], ['B', 146.432], ['P1500', 0.572], ['R', 146.432], ['P1500', 0.572]] },
    scottie1: { name: 'Scottie S1', vis: 60, w: 320, h: 256, lines: 256, pre: 9,
      seg: () => [['P1500', 1.5], ['G', 138.24], ['P1500', 1.5], ['B', 138.24], ['S', 9], ['P1500', 1.5], ['R', 138.24]] },
    pd120: { name: 'PD 120', vis: 95, w: 640, h: 496, lines: 248, pre: 0,
      seg: () => [['S', 20], ['P1500', 2.08], ['Y0', 121.6], ['V', 121.6], ['U', 121.6], ['Y1', 121.6]] }
  };
  for (const m of Object.values(MODES)) {
    m.lineMs = m.seg(0).reduce((a, s) => a + s[1], 0);
    let off = 0; for (const [k, d] of m.seg(0)) { if (k === 'S') { m.syncOff = off; m.syncMs = d; break; } off += d; }
    m.seconds = (m.pre + m.lineMs * m.lines) / 1000 + 0.91;
  }
  const byVis = Object.fromEntries(Object.entries(MODES).map(([k, m]) => [m.vis, k]));
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;
  const toY = (r, g, b) => 16 + (65.738 * r + 129.057 * g + 25.064 * b) / 256;
  const toV = (r, g, b) => 128 + (112.439 * r - 94.154 * g - 18.285 * b) / 256;
  const toU = (r, g, b) => 128 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256;
  function yuv2rgb(Y, U, V) {
    const c = 1.164 * (Y - 16);
    return [clamp(c + 1.596 * (V - 128)), clamp(c - 0.813 * (V - 128) - 0.391 * (U - 128)), clamp(c + 2.018 * (U - 128))];
  }

  // --- Encoder: rgba is Uint8ClampedArray of mode w*h*4 ---
  function encode(modeKey, rgba, rate, amp = 0.5) {
    const m = MODES[modeKey];
    const segs = [];
    const tone = (f, ms) => segs.push([f, ms]);
    tone(1900, 300); tone(1200, 10); tone(1900, 300); tone(1200, 30);
    let ones = 0; for (let i = 0; i < 7; i++) { const b = (m.vis >> i) & 1; ones += b; tone(b ? 1100 : 1300, 30); }
    tone(ones % 2 ? 1100 : 1300, 30); tone(1200, 30);
    if (m.pre) tone(1200, m.pre);
    const px = (x, y) => { const i = (y * m.w + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]]; };
    const chan = (k, y, x) => {
      if (k === 'R' || k === 'G' || k === 'B') return px(x, y)['RGB'.indexOf(k)];
      if (modeKey === 'robot36') {
        if (k === 'Y') return toY(...px(x, y));
        const y0 = y & ~1, a = px(x, y0), b = px(x, Math.min(m.h - 1, y0 + 1));
        const avg = [0, 1, 2].map(i => (a[i] + b[i]) / 2);
        return k === 'V' ? toV(...avg) : toU(...avg);
      }
      // PD: line pair
      const r0 = 2 * y, r1 = 2 * y + 1;
      if (k === 'Y0') return toY(...px(x, r0)); if (k === 'Y1') return toY(...px(x, r1));
      const a = px(x, r0), b = px(x, r1), avg = [0, 1, 2].map(i => (a[i] + b[i]) / 2);
      return k === 'V' ? toV(...avg) : toU(...avg);
    };
    const lineSegs = [];
    for (let y = 0; y < m.lines; y++) for (const [k, d] of m.seg(y)) lineSegs.push([k, d, y]);
    // render
    const hdrMs = segs.reduce((a, s) => a + s[1], 0);
    const total = Math.ceil((hdrMs + m.lineMs * m.lines + 30) / 1000 * rate);
    const out = new Float32Array(total); let ph = 0, n = 0, t = 0;
    const emit = (fFn, ms) => { const end = (t + ms) / 1000 * rate; const start = n; while (n < end && n < total) { const f = fFn((n - start) / (end - start)); ph += 2 * Math.PI * f / rate; out[n++] = amp * Math.sin(ph); } t += ms; };
    for (const [f, ms] of segs) emit(() => f, ms);
    const w = m.w;
    for (const [k, d, y] of lineSegs) {
      if (k === 'S') emit(() => 1200, d);
      else if (k[0] === 'P') emit(() => +k.slice(1), d);
      else { const vals = new Float32Array(w); for (let x = 0; x < w; x++) vals[x] = chan(k, y, x); emit(u => 1500 + vals[Math.min(w - 1, Math.floor(u * w))] / 255 * 800, d); }
    }
    while (n < total) { ph += 2 * Math.PI * 1500 / rate; out[n++] = 0; }
    return out;
  }

  // --- Decoder ---
  class Decoder {
    constructor(rate, cb = {}) {
      this.rate = rate; this.cb = cb; this.n = 0;
      this.lo = 2 * Math.PI * 1900 / rate; this.prevI = 0; this.prevQ = 0;
      const L1 = Math.max(2, Math.round(rate / 3800)), L2 = Math.max(2, Math.round(rate / 6000));
      this.ma1 = { L: L1, bi: new Float32Array(L1), bq: new Float32Array(L1), si: 0, sq: 0, k: 0 };
      this.ma2 = { L: L2, bi: new Float32Array(L2), bq: new Float32Array(L2), si: 0, sq: 0, k: 0 };
      this.win = Math.round(rate * 0.01); this.wsum = 0; this.wcnt = 0; this.wins = []; // 10ms means
      this.hist = new Float32Array(Math.round(rate * 1.2)); this.hpos = 0; // recent freq ring
      this.state = 'idle'; this.amp = 0;
    }
    ma(s, i, q) { s.si += i - s.bi[s.k]; s.sq += q - s.bq[s.k]; s.bi[s.k] = i; s.bq[s.k] = q; s.k = (s.k + 1) % s.L; return [s.si / s.L, s.sq / s.L]; }
    push(samples) {
      for (let j = 0; j < samples.length; j++) {
        const x = samples[j]; const a = this.lo * this.n;
        let [i, q] = this.ma(this.ma1, x * Math.cos(a), -x * Math.sin(a)); [i, q] = this.ma(this.ma2, i, q);
        // instantaneous frequency from phase step
        const re = i * this.prevI + q * this.prevQ, im = q * this.prevI - i * this.prevQ;
        this.prevI = i; this.prevQ = q;
        let f = 1900 + Math.atan2(im, re) * this.rate / (2 * Math.PI);
        if (!(f > 900 && f < 2700)) f = f > 2700 ? 2700 : 900;
        this.hist[this.hpos] = f; this.hpos = (this.hpos + 1) % this.hist.length;
        if (this.state === 'img') this.imgSample(f);
        else { this.wsum += f; if (++this.wcnt === this.win) { this.window(this.wsum / this.win); this.wsum = 0; this.wcnt = 0; } }
        this.n++;
      }
      if (this.state === 'img') this.decodeLines();
    }
    histAt(absN) { const back = this.n - absN; if (back < 0 || back >= this.hist.length) return 1500; return this.hist[(this.hpos - back + this.hist.length) % this.hist.length]; }
    window(mean) {
      const w = this.wins; w.push(mean); if (w.length > 70) w.shift();
      const L = v => v > 1820 && v < 1980, S = v => v > 1130 && v < 1270;
      const k = w.length - 1 - 33; // candidate start-bit window index
      if (k < 25) return;
      // need ≥20 leader windows, then start bit (3 windows ~1200), then bits
      if (!(S(w[k]) || S(w[k + 1])) || !S(w[k + 2])) return;
      let lead = 0; for (let i = k - 1; i >= 0 && L(w[i]); i--) lead++;
      if (lead < 20) return;
      const s0 = S(w[k]) ? k : k + 1;
      const bit = i => w[s0 + 3 * (i + 1) + 1];
      let code = 0, ones = 0;
      for (let i = 0; i < 8; i++) { const v = bit(i); if (!(v > 1040 && v < 1360)) return; const b = v < 1200 ? 1 : 0; if (i < 7) { code |= b << i; ones += b; } else if ((ones % 2) !== b) return; }
      const stop = w[s0 + 3 * 9 + 1]; if (!S(stop)) return;
      const mk = byVis[code]; if (!mk) return;
      // locate exact start-bit edge: first sample below 1550 in windows s0-1..s0
      const wStartAbs = this.n - (w.length - s0) * this.win;
      let edge = wStartAbs;
      for (let a = wStartAbs - this.win; a < wStartAbs + this.win; a++) { if (this.histAt(a) < 1550 && this.histAt(a + 4) < 1550) { edge = a; break; } }
      this.begin(mk, edge + Math.round(0.300 * this.rate));
    }
    begin(mk, startAbs) {
      const m = MODES[mk]; this.mode = mk; this.m = m;
      this.state = 'img'; this.wins = [];
      this.buf = new Float32Array(Math.ceil(m.seconds * this.rate) + this.rate);
      this.bstart = startAbs; this.blen = 0;
      for (let a = startAbs; a < this.n; a++) this.buf[this.blen++] = this.histAt(a);
      this.pre = new Float64Array(this.buf.length + 1);
      for (let i = 0; i < this.blen; i++) this.pre[i + 1] = this.pre[i] + this.buf[i];
      this.line = 0; this.lineStart = m.pre / 1000 * this.rate; this.spl = m.lineMs / 1000 * this.rate;
      this.img = new Uint8ClampedArray(m.w * m.h * 4).fill(255);
      this.chroma = null;
      this.cb.onStart && this.cb.onStart(mk, m);
    }
    imgSample(f) { if (this.blen < this.buf.length) { this.buf[this.blen] = f; this.pre[this.blen + 1] = this.pre[this.blen] + f; this.blen++; } }
    mean(a, b) { a = Math.max(0, Math.floor(a)); b = Math.min(this.blen, Math.floor(b)); return b > a ? (this.pre[b] - this.pre[a]) / (b - a) : 1500; }
    decodeLines() {
      const m = this.m, R = this.rate / 1000;
      while (this.line < m.lines && this.lineStart + this.spl * 1.05 + 4 * R < this.blen) {
        // sync tracking
        const exp = this.lineStart + m.syncOff * R, sl = m.syncMs * R; let best = exp, bv = 1e9;
        for (let d = -3 * R; d <= 3 * R; d++) { const v = Math.abs(this.mean(exp + d, exp + d + sl) - 1200); if (v < bv) { bv = v; best = exp + d; } }
        if (bv < 120) this.lineStart += (best - exp) * (this.line < 2 ? 1 : 0.5);
        else {
          // lost lock (dropped audio or a big timing jump): look across the whole line for the sync pulse
          let wb = exp, wv = 1e9; const half = this.spl / 2;
          for (let d = -half; d <= half; d += 2) { const v = Math.abs(this.mean(exp + d, exp + d + sl) - 1200); if (v < wv) { wv = v; wb = exp + d; } }
          if (wv < 80 && wb + this.spl * 1.05 < this.blen + this.spl) this.lineStart += wb - exp;
        }
        this.decodeLine(this.line, this.lineStart);
        this.line++; this.lineStart += this.spl;
      }
      if (this.line >= m.lines) this.finish();
    }
    decodeLine(y, start) {
      const m = this.m, R = this.rate / 1000, w = m.w; let t = start;
      const ch = {};
      let segY = y;
      if (this.mode === 'robot36') { // the separator tone says which chroma this line carries
        const sep = start + (9 + 3 + 88) * R; segY = this.mean(sep + 0.5 * R, sep + 4 * R) > 1900 ? 1 : 0;
      }
      for (const [k, d] of m.seg(segY)) {
        if (k !== 'S' && k[0] !== 'P') {
          const a = new Float32Array(w), pw = d * R / w;
          for (let x = 0; x < w; x++) a[x] = clamp((this.mean(t + x * pw, t + (x + 1) * pw) - 1500) / 800 * 255);
          ch[k] = a;
        }
        t += d * R;
      }
      const put = (row, x, r, g, b) => { const i = (row * w + x) * 4; this.img[i] = r; this.img[i + 1] = g; this.img[i + 2] = b; this.img[i + 3] = 255; };
      if (ch.R) { for (let x = 0; x < w; x++) put(y, x, ch.R[x], ch.G[x], ch.B[x]); this.cb.onLine && this.cb.onLine(y, 1); }
      else if (this.mode === 'pd120') { for (let x = 0; x < w; x++) { put(2 * y, x, ...yuv2rgb(ch.Y0[x], ch.U[x], ch.V[x])); put(2 * y + 1, x, ...yuv2rgb(ch.Y1[x], ch.U[x], ch.V[x])); } this.cb.onLine && this.cb.onLine(2 * y, 2); }
      else { // robot36: even lines carry V, odd carry U
        if (ch.V) { this.chroma = { Y: ch.Y, V: ch.V, y }; for (let x = 0; x < w; x++) put(y, x, ...yuv2rgb(ch.Y[x], 128, ch.V[x])); this.cb.onLine && this.cb.onLine(y, 1); }
        else {
          const p = this.chroma && this.chroma.y === y - 1 ? this.chroma : null; const V = p ? p.V : (this.chroma ? this.chroma.V : new Float32Array(w).fill(128));
          for (let x = 0; x < w; x++) { if (p) put(y - 1, x, ...yuv2rgb(p.Y[x], ch.U[x], V[x])); put(y, x, ...yuv2rgb(ch.Y[x], ch.U[x], V[x])); }
          this.cb.onLine && this.cb.onLine(p ? y - 1 : y, p ? 2 : 1);
        }
      }
    }
    finish() { this.state = 'idle'; const r = { mode: this.mode, w: this.m.w, h: this.m.h, rgba: this.img }; this.buf = null; this.pre = null; this.cb.onDone && this.cb.onDone(r); }
    abort() { if (this.state === 'img') { const r = { mode: this.mode, w: this.m.w, h: this.m.h, rgba: this.img, partial: true }; this.state = 'idle'; this.buf = null; this.cb.onDone && this.cb.onDone(r); } }
    get progress() { return this.state === 'img' ? this.line / this.m.lines : 0; }
  }
  const API = { MODES, encode, Decoder };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.SSTV = API;
})(this);
