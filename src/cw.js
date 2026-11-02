// Morse (CW / MCW tone over FM) encoder and adaptive decoder.
(function (root) {
  const CODE = {
    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
    N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
    '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...',
    ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', '_': '..--.-', '"': '.-..-.', '$': '...-..-', '@': '.--.-.'
  };
  const PROSIGN = { '<AR>': '.-.-.', '<SK>': '...-.-', '<BT>': '-...-', '<KN>': '-.--.', '<AS>': '.-...', '<SOS>': '...---...' };
  const REV = {}; for (const [k, v] of Object.entries(CODE)) REV[v] = k; for (const [k, v] of Object.entries(PROSIGN)) if (!REV[v]) REV[v] = k; REV['...---...'] = '<SOS>';

  function toElements(text) {
    const out = []; const t = text.toUpperCase();
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '<') { const j = t.indexOf('>', i); const p = t.slice(i, j + 1); if (PROSIGN[p]) { out.push(PROSIGN[p]); i = j; continue; } }
      if (/\s/.test(t[i])) { if (out.length && out[out.length - 1] !== ' ') out.push(' '); continue; }
      if (CODE[t[i]]) out.push(CODE[t[i]]);
    }
    return out;
  }
  function textToMorse(text) { return toElements(text).map(e => e === ' ' ? '/' : e).join(' '); }

  // Audio for a message. wpm character speed, fwpm Farnsworth overall speed (<= wpm).
  function encode(text, rate, wpm = 18, tone = 700, fwpm = null, amp = 0.5) {
    const u = 1.2 / wpm;
    const fu = fwpm && fwpm < wpm ? ((60 / fwpm) - 31 * u) / 19 : u; // spacing unit for Farnsworth
    const segs = [];
    const els = toElements(text);
    els.forEach((sym, k) => {
      if (sym === ' ') { segs.push([0, 7 * fu - 3 * fu]); return; }
      [...sym].forEach((c, j) => { segs.push([1, c === '.' ? u : 3 * u]); if (j < sym.length - 1) segs.push([0, u]); });
      if (k < els.length - 1) segs.push([0, 3 * fu]);
    });
    segs.push([0, 0.2]);
    const total = Math.ceil(segs.reduce((a, s) => a + s[1], 0) * rate);
    const out = new Float32Array(total); let n = 0; const ramp = Math.round(0.005 * rate);
    for (const [on, dur] of segs) {
      const len = Math.round(dur * rate);
      for (let i = 0; i < len && n < total; i++, n++) {
        if (!on) continue;
        const env = Math.min(1, i / ramp, (len - i) / ramp);
        out[n] = amp * env * Math.sin(2 * Math.PI * tone * n / rate);
      }
    }
    return out;
  }

  class Decoder {
    constructor(onChar, rate, opts = {}) {
      this.rate = rate; this.onChar = onChar;
      this.block = Math.round(rate * 0.004); // 4 ms blocks
      this.tone = opts.tone || 700; this.autoTone = opts.autoTone !== false;
      this.unit = 1.2 / (opts.wpm || 18);
      this.buf = []; this.hist = [];
      this.peak = 1e-9; this.floor = 1e-9; this.state = false; this.run = 0; this.sym = '';
      this.t = 0; this.lastEdge = 0; this.wordPending = false; this.charPending = false;
      this.setTone(this.tone);
    }
    setTone(f) { this.tone = f; this.coef = 2 * Math.cos(2 * Math.PI * f / this.rate); }
    get wpm() { return Math.round(1.2 / this.unit); }
    push(samples) {
      for (const s of samples) {
        this.buf.push(s);
        if (this.autoTone) { this.hist.push(s); if (this.hist.length > this.rate * 0.6) this.hist.splice(0, this.hist.length - this.rate * 0.6); }
        if (this.buf.length >= this.block) { this.frame(this.buf); this.buf = []; }
      }
      if (this.autoTone && (this._ac = (this._ac || 0) + samples.length) > this.rate * 0.5) { this._ac = 0; this.findTone(); }
    }
    findTone() {
      const x = this.hist.slice(-2048); if (x.length < 2048) return;
      let best = 0, bf = this.tone, tot = 0, nb = 0;
      for (let f = 400; f <= 1000; f += 20) { nb++;
        const c = 2 * Math.cos(2 * Math.PI * f / this.rate); let s1 = 0, s2 = 0;
        for (const v of x) { const s0 = v + c * s1 - s2; s2 = s1; s1 = s0; }
        const p = s1 * s1 + s2 * s2 - c * s1 * s2; tot += p; if (p > best) { best = p; bf = f; }
      }
      if (best > 12 * tot / nb && Math.abs(bf - this.tone) > 30) this.setTone(bf);
    }
    frame(x) {
      const dt = x.length / this.rate; this.t += dt;
      let s1 = 0, s2 = 0, E = 0; const c = this.coef; for (const v of x) { const s0 = v + c * s1 - s2; s2 = s1; s1 = s0; E += v * v; }
      const P = Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2);
      const pure = P / (E * x.length / 2 + 1e-12); // ~1 for a clean tone on our pitch
      const p = Math.sqrt(P) / x.length;
      this.peak = Math.max(p, this.peak * 0.997);
      if (!this.state) this.floor = this.floor < 1e-8 ? p : this.floor * 0.98 + p * 0.02;
      const th = Math.max(this.floor * 5, this.floor + (this.peak - this.floor) * (this.state ? 0.35 : 0.55));
      const on = this.peak > this.floor * 6 && p > th && (this.state ? pure > 0.25 : pure > 0.45);
      if (on !== this.state) {
        const dur = this.t - this.lastEdge; this.lastEdge = this.t;
        if (this.state) this.mark(dur); else this.space(dur);
        this.state = on;
      } else if (!on) {
        const gap = this.t - this.lastEdge;
        if (this.charPending && gap > 2.5 * this.unit) { this.flushChar(); }
        if (this.wordPending && gap > 6 * this.unit) { this.onChar(' '); this.wordPending = false; }
      }
    }
    mark(d) {
      if (d < 0.012) return;
      this.marks = this.marks || []; this.marks.push(d);
      this.short = this.short || this.unit; this.long = this.long || 3 * this.unit;
      // while unsure of speed, a mark much longer than the others tells us dots vs dashes
      this.charPending = true;
    }
    classify(d) {
      const th = (this.short + this.long) / 2;
      if (d < th) { this.short = this.short * 0.75 + d * 0.25; return '.'; }
      this.long = this.long * 0.75 + d * 0.25; return '-';
    }
    space(d) { /* handled by gap timer */ }
    flushChar() {
      if (this.marks && this.marks.length) {
        const mn = Math.min(...this.marks), mx = Math.max(...this.marks);
        if (mx > 2 * mn) { this.short = this.short * 0.5 + mn * 0.5; this.long = this.long * 0.5 + mx * 0.5; } // re-anchor speed from this letter
        this.sym = this.marks.map(d => this.classify(d)).join('');
        this.marks = [];
        this.short = Math.min(0.24, Math.max(0.024, this.short)); this.long = Math.max(this.long, 2 * this.short);
        this.unit = this.short;
      }
      if (!this.sym) return; const ch = REV[this.sym] || '*'; this.sym = ''; this.charPending = false; this.wordPending = true; this.onChar(ch);
    }
  }
  const API = { CODE, PROSIGN, encode, Decoder, textToMorse };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.CW = API;
})(this);
