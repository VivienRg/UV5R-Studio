'use strict';
// v1.1: Morse, speech-to-text, translation, conversation, SSTV images, settings and Certified mode.
(function () {
  const LANGS = [['en', 'English'], ['zh-TW', 'Chinese (Traditional, Taiwan)'], ['zh-CN', 'Chinese (Simplified)'], ['fr', 'French'], ['id', 'Indonesian'], ['de', 'German'], ['es', 'Spanish'], ['ja', 'Japanese'], ['ko', 'Korean'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['tl', 'Filipino'], ['ms', 'Malay'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['hi', 'Hindi']];
  const langName = c => (LANGS.find(l => l[0] === c) || [c, c])[1];
  const ST = Object.assign({ call: '', lic: '', ack: false, certified: false, txLevel: 50, idCw: true, myLang: 'en', radioLang: 'zh-TW', autoTr: true, model: 'claude-haiku-5-5', stt: true, sttModel: 'Xenova/whisper-base', mic: '', voice: '', rate: 170, sstvMode: 'robot36', cwWpm: 18, cwFwpm: 18, cwTone: 700, convTr: false, lead: 300 }, load('settings') || {});
  const saveST = () => localStorage.setItem('settings', JSON.stringify(ST));
  let SIG = null, VOICES = [], hasKey = false;
  const validCall = c => /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,3}[A-Z]$/.test(c || '');
  const canTX = () => !!(ST.certified && SIG && SIG.valid && validCall(ST.call) && ST.ack && ST.lic);
  const go = v => $(`.rail button[data-view="${v}"]`).click();
  const utf8 = s => { try { return decodeURIComponent(escape(s)); } catch { return s; } };
  const toBytes = s => unescape(encodeURIComponent(s));

  // ---------- conversation store ----------
  let CONV = load('conv') || [];
  const saveConv = () => { if (CONV.length > 400) CONV = CONV.slice(-400); localStorage.setItem('conv', JSON.stringify(CONV)); };
  function addMsg(m) { m.t = m.t || Date.now(); m.id = m.id || (Date.now() + Math.random()); CONV.push(m); saveConv(); renderThread(); return m; }
  function updMsg(m) { saveConv(); renderThread(); }

  // ---------- transmit engine ----------
  let txCtx = null, txBusy = false, txSrc = null, pvCtx = null;
  async function getTxCtx() {
    if (!txCtx) txCtx = new AudioContext();
    const dev = $('#outDev').value;
    if (dev && txCtx.setSinkId && txCtx.sinkId !== dev) { try { await txCtx.setSinkId(dev); } catch { } }
    if (txCtx.state === 'suspended') await txCtx.resume();
    return txCtx;
  }
  const concat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Float32Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
  function play(ctx, s, delayMs = 0) {
    return new Promise(res => {
      const lvl = ST.txLevel / 50, b = ctx.createBuffer(1, Math.max(1, s.length), ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < s.length; i++) d[i] = Math.max(-1, Math.min(1, s[i] * lvl));
      const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.onended = () => res();
      txSrc = src; src.start(ctx.currentTime + delayMs / 1000);
    });
  }
  function setTx(on, label) {
    $('#dotTx').className = 'dot' + (on ? ' tx' : canTX() ? ' on' : '');
    $('#txState').textContent = on ? 'Sending ' + label : canTX() ? 'Transmit allowed as ' + ST.call : 'Transmit locked';
    if (on) lcd('TX', label.slice(0, 8).toUpperCase(), ST.call || 'SENDING');
  }
  async function transmit(label, make, opts = {}) {
    if (!canTX()) { toast('Transmit is locked. Turn on Certified mode in Settings.', true); go('settings'); return false; }
    if (txBusy) { toast('Already sending. Wait or press Stop.', true); return false; }
    txBusy = true; setTx(true, label);
    try {
      const ctx = await getTxCtx(), sr = ctx.sampleRate;
      let s = await make(sr);
      if (ST.idCw && opts.id !== false) s = concat(s, new Float32Array(Math.round(0.4 * sr)), CW.encode('DE ' + ST.call, sr, Math.max(18, ST.cwWpm), ST.cwTone));
      await play(ctx, s, ST.lead);
      addLog({ type: 'tx', detail: label, dur: +(s.length / sr).toFixed(1) });
      return true;
    } catch (e) { toast('Send failed: ' + e.message, true); return false; }
    finally { txBusy = false; txSrc = null; setTx(false); }
  }
  function stopTx() { try { txSrc && txSrc.stop(); } catch { } }
  async function listen(make) { if (!pvCtx) pvCtx = new AudioContext(); if (pvCtx.state === 'suspended') await pvCtx.resume(); const s = await make(pvCtx.sampleRate); return play(pvCtx, s, 0); }

  // DTMF now goes through the transmit gate
  sendTones = async function (seq) {
    seq = String(seq).toUpperCase().replace(/[^0-9A-D*#]/g, ''); if (!seq) return toast('Use digits 0–9, A–D, * and #', true);
    await transmit('DTMF ' + seq, sr => Float32Array.from(DSP.dtmfSamples(seq, sr, +$('#dtOn').value, +$('#dtOff').value)), { id: seq.length > 1 });
  };

  // ---------- speech-to-text (Whisper in a worker) ----------
  const SP = { w: null, id: 0, pend: new Map(), files: {}, device: '', ready: false, chain: Promise.resolve() };
  function worker() {
    if (SP.w) return SP.w;
    SP.w = new Worker('speech-worker.js', { type: 'module' });
    SP.w.onmessage = e => {
      const d = e.data;
      if (d.progress) { SP.files[d.progress.file] = d.progress.pct || 0; const v = Object.values(SP.files); const pct = v.reduce((a, b) => a + b, 0) / v.length; $('#sttProg').style.width = pct + '%'; $('#sttState').textContent = `Downloading speech model… ${Math.round(pct)}%`; }
      if (d.ready) { SP.ready = true; SP.device = d.ready.device; $('#sttProg').style.width = '100%'; $('#sttState').textContent = `Speech model ready (${d.ready.model.split('/')[1]}, ${d.ready.device === 'webgpu' ? 'GPU' : 'CPU'}).`; renderFacts(); }
      if (d.id && SP.pend.has(d.id)) { const p = SP.pend.get(d.id); SP.pend.delete(d.id); d.ok ? p.res(d) : p.rej(new Error(d.error)); }
    };
    SP.w.onerror = e => { $('#sttState').textContent = 'Speech engine did not start: ' + (e.message || 'unknown error'); };
    return SP.w;
  }
  const call = (msg, tr) => new Promise((res, rej) => { const id = ++SP.id; SP.pend.set(id, { res, rej }); worker().postMessage(Object.assign({ id }, msg), tr || []); });
  function transcribe(f32, lang) {
    const job = SP.chain.then(() => call({ cmd: 'transcribe', model: ST.sttModel, audio: f32, language: lang ? lang.split('-')[0] : null }, [f32.buffer]).then(r => r.text));
    SP.chain = job.catch(() => { }); return job;
  }
  const junk = t => !t || /^[\s.,!?…-]*$/.test(t) || /^(thank you\.?|thanks for watching!?|you|bye\.?|\[.*\]|\(.*\))$/i.test(t.trim());

  async function translate(text, code) {
    if (!hasKey) throw new Error('Add an Anthropic API key in Settings to translate.');
    return api.translate({ text, target: langName(code), model: ST.model });
  }

  // ---------- receive hooks ----------
  let rs24 = null, rs16 = null, rsRate = 0, pre16 = [], cap = null, flags = {};
  const cwDec = new CW.Decoder(onCwChar, 12000, { wpm: ST.cwWpm, tone: ST.cwTone });
  const sstv = new SSTV.Decoder(24000, { onStart: sstvStart, onLine: sstvLine, onDone: sstvDone });
  window.FEAT = {
    audio(x, r12, rate) {
      if (rate !== rsRate) { rs24 = new DSP.Resampler(rate, 24000); rs16 = new DSP.Resampler(rate, 16000); rsRate = rate; }
      if ($('#sstvOn').checked) sstv.push(rs24.process(x));
      cwDec.autoTone = $('#cwAuto').checked; if (sstv.state !== 'img') cwDec.push(r12);
      const p = rs16.process(x);
      if (cap) { cap.push(p); if (cap.length > 16000 * 60 / 4096 * 4) { /* cap at ~60 s */ } }
      pre16.push(p); if (pre16.length > 3) pre16.shift();
      if (++this._k % 12 === 0) $('#cwInfo').textContent = `Pitch ${cwDec.tone} Hz · about ${cwDec.wpm} wpm`;
    },
    _k: 0,
    activityStart() { flags = { sstv: sstv.state === 'img' }; cap = pre16.slice(); },
    activityEnd(entry) {
      const chunks = cap; cap = null;
      if (!ST.stt || !chunks || flags.sstv || flags.cw || flags.pkt || sstv.state === 'img') return;
      let n = chunks.reduce((a, c) => a + c.length, 0); const tail = Math.round(1.4 * 16000);
      if (n - tail < 0.8 * 16000) return;
      const f = new Float32Array(Math.min(n - tail, 16000 * 60)); let k = 0;
      for (const c of chunks) for (const v of c) { if (k >= f.length) break; f[k++] = v; }
      const m = addMsg({ dir: 'in', mode: 'voice', text: '', pending: 'Transcribing…', ch: entry.ch });
      setTimeout(() => { if (entry.clip) { m.clip = entry.clip; updMsg(m); } }, 2500);
      transcribe(f, null).then(async text => {
        if (junk(text)) { CONV = CONV.filter(x => x !== m); saveConv(); renderThread(); return; }
        m.text = text; m.pending = ''; updMsg(m);
        entry.detail += ` · "${text}"`; api.saveLog(S.log);
        if (ST.autoTr && hasKey) { m.pending = 'Translating…'; updMsg(m); try { m.translation = await translate(text, ST.myLang); m.trLang = ST.myLang; } catch (e) { m.trErr = e.message; } m.pending = ''; updMsg(m); }
      }).catch(e => { m.pending = ''; m.text = ''; m.trErr = 'Speech-to-text failed: ' + e.message; updMsg(m); });
    },
    frame(f) {
      flags.pkt = true;
      if (f.aprs && f.aprs.type === 'message') {
        const text = utf8(f.aprs.message).replace(/\{[^{}]*$/, '');
        const m = addMsg({ dir: 'in', mode: 'packet', text, from: f.src, to: f.aprs.to });
        if (ST.autoTr && hasKey) translate(text, ST.myLang).then(t => { m.translation = t; m.trLang = ST.myLang; updMsg(m); }).catch(() => { });
      }
    },
    onView(v) {
      if (v === 'settings') { listOutputs().catch(() => { }); fillMics(); refreshCert(); }
      if (v === 'images') refreshGallery();
      if (v === 'conv') { renderThread(); renderFacts(); }
    }
  };

  // Morse receive
  let cwMsg = null, cwT = null;
  function onCwChar(c) {
    flags.cw = true;
    const out = $('#cwOut'); out.textContent += c; out.scrollTop = out.scrollHeight;
    if (c === '*' && !cwMsg) return;
    if (!cwMsg || Date.now() - cwMsg.last > 8000) cwMsg = addMsg({ dir: 'in', mode: 'morse', text: '' });
    cwMsg.text = (cwMsg.text + c).replace(/^\s+/, ''); cwMsg.last = Date.now(); updMsg(cwMsg);
    clearTimeout(cwT); cwT = setTimeout(() => {
      const m = cwMsg; cwMsg = null; if (!m) return;
      if (m.text.trim().length < 2) { CONV = CONV.filter(x => x !== m); saveConv(); renderThread(); return; }
      addLog({ type: 'cw', detail: m.text.trim() });
      if (ST.autoTr && hasKey && m.text.trim().split(/\s+/).length > 2) translate(m.text.trim(), ST.myLang).then(t => { m.translation = t; m.trLang = ST.myLang; updMsg(m); }).catch(() => { });
    }, 6000);
  }

  // SSTV receive
  function sstvStart(mk, m) {
    flags.sstv = true; const cv = $('#sstvRx'); cv.width = m.w; cv.height = m.h; cv.style.aspectRatio = `${m.w} / ${m.h}`;
    cv.getContext('2d').fillStyle = '#17222A'; cv.getContext('2d').fillRect(0, 0, m.w, m.h);
    $('#sstvRxInfo').textContent = `Receiving ${m.name}, about ${Math.round(m.seconds)} s`;
    lcd('SSTV', m.name.toUpperCase().slice(0, 9), 'IMAGE IN');
    toast('Image coming in: ' + m.name);
  }
  function sstvLine(y, n) {
    const m = sstv.m, cv = $('#sstvRx'); const row = new ImageData(sstv.img.slice(y * m.w * 4, (y + n) * m.w * 4), m.w, n);
    cv.getContext('2d').putImageData(row, 0, y);
    $('#sstvRxProg').style.width = Math.round(sstv.progress * 100) + '%';
  }
  async function sstvDone(r) {
    const cv = $('#sstvRx'); cv.getContext('2d').putImageData(new ImageData(r.rgba, r.w, r.h), 0, 0);
    $('#sstvRxProg').style.width = '100%';
    const mode = SSTV.MODES[r.mode].name;
    $('#sstvRxInfo').textContent = `${r.partial ? 'Partial ' : ''}${mode} received ${fmtTime(Date.now())}`;
    const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
    const p = await api.saveImage(`sstv-${new Date().toISOString().replace(/[:.]/g, '-')}-${r.mode}.png`, await blob.arrayBuffer());
    addMsg({ dir: 'in', mode: 'image', text: mode + (r.partial ? ' (partial)' : ''), image: p });
    addLog({ type: 'image', detail: `Received ${mode}${r.partial ? ' (partial)' : ''}`, image: p });
    refreshGallery();
  }
  async function refreshGallery() {
    const list = await api.listImages(); const g = $('#gallery');
    g.replaceChildren(...(list.length ? list.map(p => el('img', { src: 'app://data/' + p, alt: p.split('/').pop(), title: p.split('/').pop(), onclick: () => { const im = new Image(); im.onload = () => { const cv = $('#sstvRx'); cv.width = im.width; cv.height = im.height; cv.getContext('2d').drawImage(im, 0, 0); }; im.src = 'app://data/' + p; } })) : [el('p', { class: 'empty', text: 'Received images are saved here.' })]));
  }
  $('#btnSstvStop').onclick = () => { if (sstv.state === 'img') sstv.abort(); else toast('No image is being received'); };
  $('#btnImgFolder').onclick = () => api.openDataFolder();

  // SSTV send
  const modeSel = $('#sstvMode');
  modeSel.replaceChildren(...Object.entries(SSTV.MODES).map(([k, m]) => el('option', { value: k, text: `${m.name}  (${Math.round(m.seconds)} s, ${m.w}×${m.h})` })));
  $('#setSstv').replaceChildren(...Object.entries(SSTV.MODES).map(([k, m]) => el('option', { value: k, text: m.name })));
  modeSel.value = ST.sstvMode; $('#setSstv').value = ST.sstvMode;
  let txImage = null;
  function drawTx() {
    const m = SSTV.MODES[modeSel.value], cv = $('#sstvTx'); cv.width = m.w; cv.height = m.h; cv.style.aspectRatio = `${m.w} / ${m.h}`; const g = cv.getContext('2d');
    g.fillStyle = '#26333D'; g.fillRect(0, 0, m.w, m.h);
    if (txImage) { const s = Math.max(m.w / txImage.width, m.h / txImage.height); const w = txImage.width * s, h = txImage.height * s; g.drawImage(txImage, (m.w - w) / 2, (m.h - h) / 2, w, h); }
    else { g.fillStyle = '#8FA0AC'; g.font = `${m.w / 20}px -apple-system, sans-serif`; g.textAlign = 'center'; g.fillText('Choose an image', m.w / 2, m.h / 2); g.textAlign = 'left'; }
    if ($('#sstvOverlay').checked && ST.call) {
      const fs = Math.round(m.w / 11); g.font = `700 ${fs}px -apple-system, Helvetica, sans-serif`; g.lineWidth = Math.max(3, fs / 7); g.strokeStyle = '#000'; g.fillStyle = '#fff';
      g.strokeText(ST.call, fs * 0.4, fs * 1.1); g.fillText(ST.call, fs * 0.4, fs * 1.1);
    }
    $('#sstvTxInfo').textContent = `${m.name}: ${m.w}×${m.h}, takes about ${Math.round(m.seconds)} seconds on air.`;
  }
  modeSel.onchange = () => { ST.sstvMode = modeSel.value; saveST(); drawTx(); };
  $('#sstvOverlay').onchange = drawTx;
  $('#btnSstvPick').onclick = () => $('#sstvFile').click();
  $('#sstvFile').onchange = e => { const f = e.target.files[0]; if (!f) return; const im = new Image(); im.onload = () => { txImage = im; drawTx(); }; im.src = URL.createObjectURL(f); };
  const sstvSamples = sr => { const m = SSTV.MODES[modeSel.value]; const d = $('#sstvTx').getContext('2d').getImageData(0, 0, m.w, m.h).data; return SSTV.encode(modeSel.value, d, sr); };
  $('#btnSstvListen').onclick = () => { if (!txImage) return toast('Choose an image first', true); listen(sstvSamples); };
  $('#btnSstvSend').onclick = async () => {
    if (!txImage) return toast('Choose an image first', true);
    const cv = $('#sstvTx'); const url = cv.toDataURL('image/png');
    const ok = await transmit('SSTV ' + SSTV.MODES[modeSel.value].name, sstvSamples);
    if (ok) { const blob = await new Promise(r => cv.toBlob(r, 'image/png')); const p = await api.saveImage(`sent-${Date.now()}.png`, await blob.arrayBuffer()); addMsg({ dir: 'out', mode: 'image', text: SSTV.MODES[modeSel.value].name, image: p }); }
  };
  $('#btnSstvCancel').onclick = () => { stopTx(); if (pvCtx) { pvCtx.close(); pvCtx = null; } };

  // Morse page
  const cwFields = [['#cwWpm', 'cwWpm'], ['#cwFwpm', 'cwFwpm'], ['#cwTone', 'cwTone']];
  cwFields.forEach(([s, k]) => { $(s).value = ST[k]; $(s).onchange = e => { ST[k] = +e.target.value; if (k === 'cwFwpm' && ST.cwFwpm > ST.cwWpm) { ST.cwFwpm = ST.cwWpm; $(s).value = ST.cwWpm; } saveST(); }; });
  $('#cwText').oninput = e => $('#cwPreview').textContent = CW.textToMorse(e.target.value);
  $('#prosigns').replaceChildren(...['CQ', 'DE', 'K', '<AR>', '<SK>', '<BT>', '<KN>', '73', 'QTH', 'QSL', 'RST 599'].map(p => el('button', { text: p, onclick: () => { const t = $('#cwText'); t.value = (t.value + ' ' + p).trim() + ' '; t.oninput({ target: t }); t.focus(); } })));
  const cwSamples = txt => sr => CW.encode(txt, sr, ST.cwWpm, ST.cwTone, ST.cwFwpm);
  $('#btnCwListen').onclick = () => { const t = $('#cwText').value.trim(); if (t) listen(cwSamples(t)); };
  $('#btnCwSend').onclick = async () => { const t = $('#cwText').value.trim(); if (!t) return toast('Type the message first', true); if (await transmit('CW ' + t, cwSamples(t), { id: !/\bDE\b/i.test(t) })) addMsg({ dir: 'out', mode: 'morse', text: t.toUpperCase() }); };
  $('#btnCwClear').onclick = () => $('#cwOut').textContent = '';
  $('#btnCwCopy').onclick = () => { navigator.clipboard.writeText($('#cwOut').textContent); toast('Copied'); };

  // ---------- conversation UI ----------
  let mode = 'voice', msgNo = +(localStorage.getItem('msgNo') || 1);
  $$('.mode-switch button').forEach(b => b.onclick = () => { mode = b.dataset.mode; $$('.mode-switch button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); }); $('#pktTo').hidden = mode !== 'packet'; previewLine(); });
  $('#convTranslate').checked = ST.convTr;
  $('#convTranslate').onchange = e => { ST.convTr = e.target.checked; saveST(); previewLine(); };
  function previewLine() {
    $('#convLangName').textContent = langName(ST.radioLang);
    $('#convPreview').textContent = mode === 'voice' ? `Spoken${ST.convTr ? ' in ' + langName(ST.radioLang) : ''}` : mode === 'morse' ? `${ST.cwWpm} wpm Morse` : `APRS message from ${ST.call || 'your callsign'}`;
  }
  const TAG = { voice: 'Voice', morse: 'Morse', packet: 'Packet', image: 'Image', dtmf: 'DTMF' };
  function renderThread() {
    const ul = $('#thread'); if (!ul) return;
    if (!CONV.length) return ul.replaceChildren(el('li', { class: 'empty', text: 'Nothing yet. Start the receiver to hear the radio, or type a message below. Received voice is turned into text automatically.' }));
    const atBottom = ul.scrollHeight - ul.scrollTop - ul.clientHeight < 40;
    ul.replaceChildren(...CONV.slice(-150).map(m => el('li', { class: 'msg ' + m.dir },
      el('div', { class: 'meta' }, el('span', { class: 'tag ' + m.mode, text: TAG[m.mode] || m.mode }), el('span', { text: fmtTime(m.t) }), m.from ? el('span', { text: m.from + (m.to ? ' → ' + m.to : '') }) : null, m.dir === 'out' && ST.call ? el('span', { text: ST.call }) : null, m.ch ? el('span', { text: m.ch }) : null),
      m.text ? el('div', { class: 'text', text: m.text }) : null,
      m.pending ? el('div', { class: 'pending', text: m.pending }) : null,
      m.translation ? el('div', { class: 'text tr', 'data-lang': langName(m.trLang || ''), text: m.translation }) : null,
      m.trErr ? el('div', { class: 'pending', text: m.trErr }) : null,
      m.image ? el('img', { src: 'app://data/' + m.image, alt: 'SSTV image' }) : null,
      m.clip ? el('audio', { controls: true, preload: 'none', src: 'app://data/recordings/' + m.clip.split(/[\\/]/).pop() }) : null)));
    if (atBottom) ul.scrollTop = ul.scrollHeight;
  }
  function renderFacts() {
    $('#convFacts').replaceChildren(
      el('dt', { text: 'My language' }), el('dd', { text: langName(ST.myLang) }),
      el('dt', { text: 'Radio language' }), el('dd', { text: langName(ST.radioLang) }),
      el('dt', { text: 'Speech to text' }), el('dd', { text: !ST.stt ? 'Off' : SP.ready ? 'Ready' : 'Loads on first voice' }),
      el('dt', { text: 'Translation' }), el('dd', { text: hasKey ? 'Claude, key saved' : 'Needs API key' }),
      el('dt', { text: 'Transmit' }), el('dd', { text: canTX() ? 'Allowed as ' + ST.call : 'Locked' }));
  }
  $('#btnConvClear').onclick = () => { if (confirm('Clear the conversation thread? The log keeps its history.')) { CONV = []; saveConv(); renderThread(); } };

  async function pickVoice(code) {
    if (ST.voice) return ST.voice;
    if (!VOICES.length) VOICES = await api.ttsVoices();
    const want = code.replace('-', '_'), base = code.split('-')[0];
    const v = VOICES.find(x => x.lang === want) || VOICES.find(x => x.lang.startsWith(base + '_'));
    return v ? v.name : '';
  }
  async function voiceSamples(text, code, sr) {
    if (api.platform !== 'darwin') throw new Error('Spoken output needs macOS system voices.');
    const wav = await api.ttsRender({ text, voice: await pickVoice(code), rate: ST.rate });
    const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    const ctx = new OfflineAudioContext(1, 1, sr); const buf = await ctx.decodeAudioData(ab);
    return buf.getChannelData(0).slice();
  }
  $('#btnConvSend').onclick = async () => {
    const text = $('#convText').value.trim(); if (!text) return toast('Type a message or hold Speak', true);
    if (!canTX()) { toast('Transmit is locked. Turn on Certified mode in Settings.', true); return go('settings'); }
    let out = text, translated = false;
    try {
      if (ST.convTr && mode !== 'morse' && ST.radioLang !== ST.myLang) { $('#convStatus').textContent = 'Translating…'; out = await translate(text, ST.radioLang); translated = true; }
    } catch (e) { $('#convStatus').textContent = ''; return toast(e.message, true); }
    $('#convStatus').textContent = 'Sending…';
    let ok = false;
    if (mode === 'voice') ok = await transmit('Voice', sr => voiceSamples(out, translated ? ST.radioLang : ST.myLang, sr));
    if (mode === 'morse') {
      const bad = [...out.toUpperCase()].filter(c => !/\s/.test(c) && !CW.CODE[c] && c !== '<' && c !== '>');
      if (bad.length) { $('#convStatus').textContent = ''; return toast('Morse can’t send: ' + [...new Set(bad)].join(' '), true); }
      ok = await transmit('CW', cwSamples(out));
    }
    if (mode === 'packet') {
      const to = ($('#pktTo').value.trim().toUpperCase() || 'CQ').slice(0, 9);
      const info = ':' + to.padEnd(9) + ':' + toBytes(out).slice(0, 67) + '{' + (msgNo++ % 1000);
      localStorage.setItem('msgNo', msgNo);
      ok = await transmit('Packet to ' + to, sr => Float32Array.from(DSP.afskSamples(DSP.ax25Encode(ST.call, 'APZUV5', ['WIDE1-1'], info), sr)), { id: false });
    }
    $('#convStatus').textContent = ok ? 'Sent ' + fmtTime(Date.now()) : '';
    if (ok) { addMsg({ dir: 'out', mode, text, translation: translated ? out : '', trLang: ST.radioLang, to: mode === 'packet' ? $('#pktTo').value.toUpperCase() : '' }); $('#convText').value = ''; }
  };
  $('#convText').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#btnConvSend').click(); };

  // hold to speak (computer microphone, not the radio)
  let rec = null;
  async function recStart() {
    if (rec) return;
    try {
      await api.micAccess();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: ST.mic ? { exact: ST.mic } : undefined, channelCount: 1 } });
      const ctx = new AudioContext(), src = ctx.createMediaStreamSource(stream), pr = ctx.createScriptProcessor(4096, 1, 1), rs = new DSP.Resampler(ctx.sampleRate, 16000), chunks = [];
      const g = ctx.createGain(); g.gain.value = 0;
      pr.onaudioprocess = e => chunks.push(rs.process(e.inputBuffer.getChannelData(0)));
      src.connect(pr); pr.connect(g); g.connect(ctx.destination);
      rec = { stream, ctx, chunks, t: Date.now() };
      $('#btnSpeak').classList.add('rec'); $('#btnSpeak').textContent = 'Listening… release to stop';
    } catch (e) { toast('Microphone not available: ' + e.message, true); }
  }
  async function recStop() {
    if (!rec) return; const r = rec; rec = null;
    $('#btnSpeak').classList.remove('rec'); $('#btnSpeak').textContent = 'Hold to speak';
    r.stream.getTracks().forEach(t => t.stop()); r.ctx.close();
    if (Date.now() - r.t < 600) return toast('Hold the button while you talk');
    const n = r.chunks.reduce((a, c) => a + c.length, 0), f = new Float32Array(n); let k = 0; for (const c of r.chunks) for (const v of c) f[k++] = v;
    $('#convStatus').textContent = SP.ready ? 'Transcribing…' : 'Loading speech model (first time only)…';
    try { const t = await transcribe(f, ST.myLang); if (!junk(t)) { const ta = $('#convText'); ta.value = (ta.value ? ta.value + ' ' : '') + t; } $('#convStatus').textContent = 'Check the text, then Send'; }
    catch (e) { $('#convStatus').textContent = ''; toast('Speech-to-text failed: ' + e.message, true); }
  }
  const sp = $('#btnSpeak');
  sp.addEventListener('pointerdown', e => { e.preventDefault(); recStart(); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => sp.addEventListener(ev, recStop));
  sp.addEventListener('keydown', e => { if (e.key === ' ' && !e.repeat) { e.preventDefault(); recStart(); } });
  sp.addEventListener('keyup', e => { if (e.key === ' ') recStop(); });

  // ---------- settings ----------
  const fillLang = sel => sel.replaceChildren(...LANGS.map(([c, n]) => el('option', { value: c, text: n })));
  fillLang($('#setMyLang')); fillLang($('#setRadioLang'));
  const bind = (sel, key, kind = 'value', after) => { const e = $(sel); if (kind === 'checked') e.checked = !!ST[key]; else e.value = ST[key]; e.addEventListener('change', () => { ST[key] = kind === 'checked' ? e.checked : (e.type === 'number' || e.type === 'range') ? +e.value : e.value; saveST(); after && after(); }); };
  bind('#setCall', 'call', 'value', () => { ST.call = ST.call.toUpperCase().trim(); $('#setCall').value = ST.call; if (!validCall(ST.call)) ST.certified = false; saveST(); refreshCert(); drawTx(); previewLine(); });
  bind('#setClass', 'lic', 'value', refreshCert); bind('#setAck', 'ack', 'checked', () => { if (!ST.ack) ST.certified = false; saveST(); refreshCert(); });
  bind('#setTxLevel', 'txLevel'); bind('#setIdCw', 'idCw', 'checked'); bind('#dtLead', 'lead');
  bind('#setMyLang', 'myLang', 'value', () => { previewLine(); renderFacts(); }); bind('#setRadioLang', 'radioLang', 'value', () => { previewLine(); renderFacts(); });
  bind('#setAutoTr', 'autoTr', 'checked'); bind('#setModel', 'model');
  bind('#setStt', 'stt', 'checked'); bind('#setSttModel', 'sttModel', 'value', () => { SP.ready = false; });
  bind('#setMic', 'mic'); bind('#setVoice', 'voice'); bind('#setRate', 'rate');
  bind('#setSstv', 'sstvMode', 'value', () => { modeSel.value = ST.sstvMode; drawTx(); });
  $('#btnSttLoad').onclick = () => { $('#sttState').textContent = 'Starting download…'; call({ cmd: 'load', model: ST.sttModel }).catch(e => $('#sttState').textContent = 'Download failed: ' + e.message); };
  $('#btnKey').onclick = async () => { const k = $('#setKey').value.trim(); hasKey = await api.keySet(k); $('#setKey').value = ''; keyState(); toast(hasKey ? 'API key saved' : 'API key removed'); };
  function keyState() { $('#keyState').innerHTML = ''; $('#keyState').append(hasKey ? el('span', { class: 'ok', text: 'Key saved in the keychain. ' }) : el('span', { text: 'No key yet. ' }), 'Translation uses Claude through your own Anthropic API key.'); $('#btnKey').textContent = hasKey && !$('#setKey').value ? 'Replace' : 'Save'; renderFacts(); }
  async function fillMics() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    $('#setMic').replaceChildren(el('option', { value: '', text: 'System default' }), ...devs.filter(d => d.kind === 'audioinput').map((d, k) => el('option', { value: d.deviceId, text: d.label || 'Microphone ' + (k + 1) })));
    $('#setMic').value = ST.mic;
    if (!VOICES.length) { VOICES = await api.ttsVoices(); $('#setVoice').replaceChildren(el('option', { value: '', text: 'Match radio language' }), ...VOICES.map(v => el('option', { value: v.name, text: `${v.name} (${v.lang.replace('_', '-')})` }))); $('#setVoice').value = ST.voice; }
  }
  async function refreshCert(recheck) {
    if (!SIG || recheck) SIG = await api.sigCheck();
    const row = (k, ok, text) => [el('dt', { text: k }), el('dd', { class: ok ? 'ok' : 'bad', text: (ok ? '✓ ' : '✗ ') + text })];
    $('#certFacts').replaceChildren(
      ...row('App signature', SIG.valid, SIG.valid ? SIG.kind + (SIG.team && SIG.team !== 'not set' ? ', team ' + SIG.team : '') : 'Broken: ' + (SIG.detail || 'reinstall the app')),
      ...row('Callsign', validCall(ST.call), ST.call ? (validCall(ST.call) ? ST.call : ST.call + ' does not look like a callsign') : 'Not set'),
      ...row('Licence', !!ST.lic, ST.lic || 'Not set'),
      ...row('Declaration', ST.ack, ST.ack ? 'Confirmed' : 'Not confirmed'));
    if (ST.certified && !canTX()) { ST.certified = false; saveST(); }
    const ready = SIG.valid && validCall(ST.call) && ST.lic && ST.ack;
    $('#btnCert').textContent = ST.certified ? 'Turn off Certified mode' : 'Turn on Certified mode';
    $('#btnCert').disabled = !ST.certified && !ready;
    $('#certMsg').className = 'small ' + (ST.certified ? 'bad' : 'muted');
    $('#certMsg').textContent = ST.certified ? `Certified mode is on. The app can transmit as ${ST.call}.` : ready ? 'Everything checks out. Turn it on when you are ready to transmit.' : 'Complete the items above to unlock transmit.';
    updateTxUi();
  }
  function updateTxUi() {
    const on = canTX();
    $('#txBadge').textContent = on ? 'Certified · ' + ST.call : 'Receive only'; $('#txBadge').classList.toggle('on', on);
    $$('.tx-btn').forEach(b => { b.disabled = !on; b.title = on ? '' : 'Turn on Certified mode in Settings to transmit'; });
    $('#btnSendSeq').classList.add('tx-btn'); $('#btnSendSeq').disabled = !on;
    setTx(false); renderFacts(); previewLine();
  }
  $('#btnCert').onclick = () => { ST.certified = !ST.certified; saveST(); refreshCert(); toast(ST.certified ? 'Certified mode on: transmit unlocked' : 'Certified mode off: receive only'); };
  $('#btnSigRecheck').onclick = () => refreshCert(true);

  // boot
  (async () => {
    hasKey = await api.keyHas(); keyState();
    await refreshCert();
    drawTx(); renderThread(); previewLine(); refreshGallery();
    $('#outDev').addEventListener('change', () => { if (txCtx) { txCtx.close(); txCtx = null; } });
  })();
})();
