'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const clone = o => JSON.parse(JSON.stringify(o));
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDate = t => new Date(t).toLocaleString();
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : ''); clearTimeout(t._h); t._h = setTimeout(() => t.className = 'toast', 3800); }

// ---------------- state ----------------
const S = {
  channels: load('channels') || padChannels(clone(window.DEFAULT_CHANNELS)),
  image: null, ident: null, port: null,
  log: [], filter: 'all', groupFilter: 'All',
  saved: load('savedSeq') || [{ label: 'Test burst', seq: '123#' }],
  monitor: localStorage.getItem('monitor') || ''
};
function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function persist() { localStorage.setItem('channels', JSON.stringify(S.channels)); }
function padChannels(a) { const o = new Array(128).fill(null); a.forEach((c, i) => { if (i < 128) o[i] = c; }); return o; }

const GROUPS = [
  ['Emergency', c => /^EM|^MAR(16|06|13)$/.test(c.name)],
  ['Taiwan ham', c => /^(TW|TY|ZL|TP|YANGMEI|LONGTAN|DAYUAN|GUANYIN)/.test(c.name) && !/^TWF/.test(c.name)],
  ['Taiwan FRS', c => /^TWF/.test(c.name)],
  ['International ham', c => /^(EU|US|JP)/.test(c.name)],
  ['Space', c => /^(ISS|SO\d)/.test(c.name)],
  ['Marine', c => /^(MAR|AIS)/.test(c.name)],
  ['PMR446', c => /^PMR/.test(c.name)],
  ['FRS / GMRS', c => /^FRS/.test(c.name)],
  ['MURS', c => /^MURS/.test(c.name)],
  ['Weather', c => /^WX/.test(c.name)]
];
const groupOf = c => (GROUPS.find(([, f]) => f(c)) || ['Other'])[0];
const txFreq = c => c.duplex === 'off' ? null : c.duplex === '+' ? +c.rx + +c.offset : c.duplex === '-' ? +c.rx - +c.offset : c.duplex === 'split' ? +c.offset : +c.rx;
const inHam = f => (f >= 144 && f <= 146) || (f >= 430 && f <= 432);
const rxOk = f => (f >= 136 && f <= 174) || (f >= 400 && f <= 520);
function txClass(c) { const f = txFreq(c); if (f === null) return ['rx', 'RX only']; return inHam(f) ? ['ham', 'Ham'] : ['illegal', 'Not allowed']; }

// ---------------- navigation ----------------
$$('.rail button[data-view]').forEach(b => b.addEventListener('click', () => {
  $$('.rail button').forEach(x => x.classList.toggle('active', x === b));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
  if (b.dataset.view === 'scan') { renderScanGroups(); drawActivity(); }
  if (b.dataset.view === 'log') renderLog();
  if (b.dataset.view === 'dtmf') listOutputs();
  if (window.FEAT) FEAT.onView(b.dataset.view);
}));

// ---------------- LCD ----------------
function lcd(ch, freq, name, flags = '') {
  $('#lcdCh').textContent = ch; $('#lcdFreq').textContent = freq; $('#lcdName').textContent = name; $('#lcdFlags').textContent = flags;
  const l = $('#lcd'); l.classList.remove('flash'); void l.offsetWidth; l.classList.add('flash');
}
function lcdChannel(i) {
  const c = S.channels[i];
  if (!c) return lcd('CH ---', '---.---', 'EMPTY');
  const flags = [c.duplex === 'off' ? 'RX' : c.duplex === 'split' ? 'SPL' : c.duplex, c.toneMode ? 'CT' : '', c.mode === 'NFM' ? 'N' : '', c.power === 'Low' ? 'L' : 'H'].filter(Boolean).join(' ');
  lcd('CH ' + String(i).padStart(3, '0'), (+c.rx).toFixed(4).replace(/0$/, ''), c.name || '-------', flags);
}

// ---------------- channel table ----------------
function renderChips() {
  const groups = ['All', ...GROUPS.map(g => g[0]).filter(g => S.channels.some(c => c && groupOf(c) === g))];
  if (S.channels.some(c => c && groupOf(c) === 'Other')) groups.push('Other');
  const box = $('#groupChips'); box.replaceChildren(...groups.map(g => el('button', { class: 'chip' + (S.groupFilter === g ? ' on' : ''), text: g, onclick: () => { S.groupFilter = g; renderChips(); renderTable(); } })));
}
function cellInput(c, i, key, cls, type = 'text') {
  const v = type === 'number' && c[key] !== '' && c[key] != null ? (key === 'rx' || key === 'offset' ? (+c[key]).toFixed(5).replace(/(\.\d{3}\d*?)0+$/, '$1') : String(c[key])) : (c[key] ?? '');
  return el('input', { class: cls, value: v, type: 'text', inputmode: type === 'number' ? 'decimal' : null, 'aria-label': key + ' ch ' + i, onchange: e => setField(i, key, type === 'number' ? parseFloat(e.target.value) : e.target.value) });
}
function cellSelect(c, i, key, opts) {
  const s = el('select', { 'aria-label': key + ' ch ' + i, onchange: e => setField(i, key, e.target.value) }, ...opts.map(([v, l]) => el('option', { value: v, text: l })));
  s.value = c[key] ?? ''; return s;
}
function row(c, i) {
  const [tc, tl] = txClass(c);
  const tr = el('tr', { class: rxOk(+c.rx) && (c.name || '').length <= 7 ? '' : 'bad', 'data-i': i },
    el('td', { class: 'num', text: String(i).padStart(3, '0') }),
    el('td', {}, cellInput(c, i, 'name', 'w-name')),
    el('td', {}, cellInput(c, i, 'rx', 'w-f', 'number')),
    el('td', {}, cellSelect(c, i, 'duplex', [['', 'Simplex'], ['+', '+ shift'], ['-', '− shift'], ['split', 'Split'], ['off', 'TX off']])),
    el('td', {}, c.duplex === '' || c.duplex === 'off' ? el('span', { class: 'muted', text: '—' }) : cellInput(c, i, 'offset', 'w-f', 'number')),
    el('td', {}, cellSelect(c, i, 'toneMode', [['', 'None'], ['Tone', 'TX tone'], ['TSQL', 'Tone squelch']])),
    el('td', {}, c.toneMode ? cellInput(c, i, c.toneMode === 'TSQL' ? 'ctone' : 'rtone', 'w-hz', 'number') : el('span', { class: 'muted', text: '—' })),
    el('td', {}, cellSelect(c, i, 'mode', [['FM', 'Wide'], ['NFM', 'Narrow']])),
    el('td', {}, cellSelect(c, i, 'power', [['High', 'High'], ['Low', 'Low']])),
    el('td', {}, el('input', { type: 'checkbox', checked: c.skip !== 'S', 'aria-label': 'scan ch ' + i, onchange: e => setField(i, 'skip', e.target.checked ? '' : 'S') })),
    el('td', {}, el('span', { class: 'tx ' + tc, text: tl })),
    el('td', { class: 'notes' }, cellInput(c, i, 'comment', '')),
    el('td', {}, el('button', { class: 'rowbtn', title: 'Show on display', text: '◉', onclick: () => lcdChannel(i) }), el('button', { class: 'rowbtn', title: 'Delete channel', text: '✕', onclick: () => { S.channels[i] = null; persist(); renderAllChannels(); } })));
  return tr;
}
function renderTable() {
  const tb = $('#chanTable tbody'); const rows = []; let lastG = null;
  S.channels.forEach((c, i) => {
    if (!c) return;
    const g = groupOf(c);
    if (S.groupFilter !== 'All' && g !== S.groupFilter) return;
    if (g !== lastG) { const n = S.channels.filter(x => x && groupOf(x) === g).length; rows.push(el('tr', { class: 'group-row' }, el('td', { colspan: 13 }, g, el('span', { text: n + ' channels' })))); lastG = g; }
    rows.push(row(c, i));
  });
  const free = S.channels.findIndex(c => !c);
  if (free >= 0) rows.push(el('tr', {}, el('td', { colspan: 13 }, el('button', { class: 'ghost', text: '+ Add channel at ' + String(free).padStart(3, '0'), onclick: () => { S.channels[free] = { name: 'NEW', rx: 145.5, duplex: 'off', offset: 0, toneMode: '', rtone: 88.5, ctone: 88.5, mode: 'FM', skip: '', power: 'Low', comment: '' }; persist(); renderAllChannels(); } }))));
  tb.replaceChildren(...rows);
  updateSummary();
}
function updateSummary() {
  const used = S.channels.filter(Boolean), illegal = used.filter(c => txClass(c)[0] === 'illegal').length;
  $('#chanSummary').textContent = `${used.length} of 128 memories used. ${used.filter(c => c.skip !== 'S').length} in scan list.` + (illegal ? ` ${illegal} channel${illegal > 1 ? 's' : ''} can transmit outside Taiwan ham bands: use Lock TX before writing.` : ' Transmit is limited to Taiwan ham bands.');
}
function setField(i, key, val) {
  const c = S.channels[i]; if (!c) return;
  if (key === 'name') val = String(val).toUpperCase().slice(0, 7);
  if ((key === 'rx' || key === 'offset') && isNaN(val)) return toast('Enter a frequency in MHz, for example 145.500', true);
  c[key] = val; persist();
  const tr = $(`#chanTable tr[data-i="${i}"]`); if (tr) tr.replaceWith(row(c, i));
  updateSummary();
}
function renderAllChannels() { renderChips(); renderTable(); fillMonitorSelect(); }

$('#btnDefaults').onclick = () => { if (!confirm('Replace the current list with the Taiwan + emergency + international plan (112 channels)?')) return; S.channels = padChannels(clone(window.DEFAULT_CHANNELS)); persist(); renderAllChannels(); toast('Loaded 112 channels'); };
$('#btnImport').onclick = async () => {
  const f = await api.openText([{ name: 'CHIRP CSV', extensions: ['csv'] }]); if (!f) return;
  try { const ch = UV5R.parseCSV(f.text); const n = ch.filter(Boolean).length; if (!n) throw new Error('No channels found in that file'); S.channels = ch; persist(); renderAllChannels(); toast(`Imported ${n} channels`); }
  catch (e) { toast('Import failed: ' + e.message, true); }
};
$('#btnExport').onclick = async () => { const p = await api.saveText('UV5R_channels.csv', UV5R.toCSV(S.channels), [{ name: 'CHIRP CSV', extensions: ['csv'] }]); if (p) toast('Exported to ' + p); };
$('#btnLockTx').onclick = () => {
  let n = 0; S.channels.forEach(c => { if (c && txClass(c)[0] === 'illegal') { c.duplex = 'off'; c.offset = 0; n++; } });
  persist(); renderAllChannels(); toast(n ? `Transmit turned off on ${n} channels` : 'Every transmit channel is already inside the ham bands');
};

// ---------------- radio ----------------
const rlog = m => { const c = $('#radioConsole'); c.textContent += `[${fmtTime(Date.now())}] ${m}\n`; c.scrollTop = c.scrollHeight; };
api.onSerialPorts(list => {
  const ul = $('#portList');
  if (!list.length) ul.replaceChildren(el('li', { class: 'muted', text: 'No serial ports found. Plug in the cable and install its driver.' }));
  else ul.replaceChildren(...list.map(p => el('li', {}, el('button', { onclick: () => { $('#portDialog').close(); S.portName = p.displayName || p.portName; api.choosePort(p.portId); } }, p.displayName || p.portName, el('small', { text: p.portName + (p.vendorId ? `  ·  USB ${p.vendorId}:${p.productId}` : '') })))));
  $('#portDialog').showModal();
});
$('#portCancel').onclick = () => { $('#portDialog').close(); api.choosePort(''); };

async function getPort() {
  if (S.port) return S.port;
  if (!navigator.serial) throw new Error('Serial access is not available in this build.');
  S.port = await navigator.serial.requestPort();
  $('#fPort').textContent = S.portName || 'Selected';
  return S.port;
}
function progress(p, text) { $('#progFill').style.width = Math.round(p * 100) + '%'; if (text) $('#progText').textContent = text; }
function busy(on) { ['#btnRead', '#btnWrite', '#btnScanWrite'].forEach(s => $(s).disabled = on); $('#dotRadio').className = 'dot' + (on ? ' busy' : S.image ? ' on' : ''); }

$('#btnRead').onclick = async () => {
  try {
    const port = await getPort(); busy(true); progress(0, 'Talking to the radio…'); rlog('Handshake');
    const { img, ident } = await UV5R.download(port, p => progress(p, `Reading ${Math.round(p * 100)}%`), rlog);
    S.image = img; S.ident = ident;
    const byKey = new Map(window.DEFAULT_CHANNELS.map(c => [c.name + '|' + (+c.rx).toFixed(5), c.comment]));
    S.channels = UV5R.decodeAll(img).map(c => c && Object.assign(c, { comment: byKey.get(c.name + '|' + (+c.rx).toFixed(5)) || '' }));
    persist(); renderAllChannels();
    const withId = new Uint8Array(8 + img.length); withId.set(ident.slice(0, 8)); withId.set(img, 8);
    const bk = await api.autoBackup(withId);
    $('#fIdent').textContent = ident.map(v => v.toString(16).padStart(2, '0')).join(' ').toUpperCase();
    $('#fRead').textContent = fmtDate(Date.now());
    $('#fCount').textContent = S.channels.filter(Boolean).length;
    $('#radioState').textContent = 'Image read ' + fmtTime(Date.now());
    progress(1, 'Read complete. Backup saved.'); rlog('Backup ' + bk); lcdChannel(S.channels.findIndex(Boolean));
    addLog({ type: 'radio', detail: `Read ${S.channels.filter(Boolean).length} channels from radio` });
  } catch (e) { fail(e); } finally { busy(false); }
};
function fail(e) {
  if (e && e.name === 'NotFoundError') { progress(0, 'No port chosen.'); return; }
  S.port = null; progress(0, e.message); rlog('Error: ' + e.message); toast(e.message, true);
}
async function writeRadio(label) {
  const used = S.channels.filter(Boolean);
  const bad = used.filter(c => !rxOk(+c.rx)); if (bad.length) throw new Error(`${bad[0].name} is outside the radio's range (136–174, 400–520 MHz).`);
  const illegal = used.filter(c => txClass(c)[0] === 'illegal');
  if (illegal.length && !confirm(`${illegal.length} channels can transmit outside Taiwan ham bands (for example ${illegal[0].name}). Write anyway? Use "Lock TX to ham bands" to fix.`)) return false;
  if (!S.image && !confirm('This radio has not been read yet. Write channels onto a blank image? Radio settings are not touched either way, but reading first keeps per-channel extras such as PTT-ID.')) return false;
  const base = S.image || UV5R.emptyImage();
  const img = UV5R.encodeAll(base, S.channels);
  const port = await getPort(); busy(true); progress(0, 'Talking to the radio…'); rlog('Handshake for write');
  await UV5R.upload(port, img, p => progress(p, `Writing ${Math.round(p * 100)}%`), rlog);
  S.image = img; $('#fWrite').textContent = fmtDate(Date.now());
  progress(1, 'Write complete. The radio restarts by itself.'); rlog(label);
  addLog({ type: 'radio', detail: label }); toast(label); return true;
}
$('#btnWrite').onclick = async () => { try { await writeRadio(`Wrote ${S.channels.filter(Boolean).length} channels to radio`); } catch (e) { fail(e); } finally { busy(false); } };
$('#btnSaveImg').onclick = async () => {
  if (!S.image) return toast('Read the radio or open an image first', true);
  const d = new Uint8Array(8 + S.image.length); if (S.ident) d.set(S.ident.slice(0, 8)); d.set(S.image, 8);
  const p = await api.saveBinary('uv5r.img', d, [{ name: 'Radio image', extensions: ['img'] }]); if (p) toast('Saved ' + p);
};
$('#btnLoadImg').onclick = async () => {
  const f = await api.openBinary([{ name: 'Radio image', extensions: ['img'] }]); if (!f) return;
  const d = new Uint8Array(f.data);
  let img = d.length === 0x2000 ? d : d.length >= 0x2008 ? d.slice(8, 0x2008) : null;
  if (!img) return toast('That file is not a UV-5R image', true);
  S.image = img; S.ident = d.length >= 0x2008 ? Array.from(d.slice(0, 8)) : null;
  S.channels = UV5R.decodeAll(img); persist(); renderAllChannels();
  $('#fCount').textContent = S.channels.filter(Boolean).length; toast('Opened ' + f.path.split(/[\\/]/).pop());
};
$('#btnFolder').onclick = () => api.openDataFolder();

// ---------------- audio engine ----------------
const A = { running: false };
async function listInputs() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const ins = devs.filter(d => d.kind === 'audioinput');
    const sel = $('#inDev'), keep = sel.value || localStorage.getItem('inDev');
    sel.replaceChildren(...ins.map((d, k) => el('option', { value: d.deviceId, text: d.label || `Input ${k + 1}` })));
    if (keep && ins.some(d => d.deviceId === keep)) sel.value = keep;
  } catch { }
}
async function listOutputs() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const outs = devs.filter(d => d.kind === 'audiooutput');
  const sel = $('#outDev'), keep = sel.value || localStorage.getItem('outDev');
  sel.replaceChildren(...outs.map((d, k) => el('option', { value: d.deviceId, text: d.label || `Output ${k + 1}` })));
  if (keep && outs.some(d => d.deviceId === keep)) sel.value = keep;
}
$('#inDev').onchange = e => { localStorage.setItem('inDev', e.target.value); if (A.running) { stopAudio(); startAudio(); } };
$('#outDev').onchange = e => localStorage.setItem('outDev', e.target.value);
const sqDb = () => +$('#sq').value;
$('#sq').oninput = e => { $('#sqVal').textContent = e.target.value + ' dB'; localStorage.setItem('sq', e.target.value); placeSq(); };
function placeSq() { $('#meterSq').style.left = ((sqDb() + 80) / 80 * 100) + '%'; }

async function startAudio() {
  try {
    await api.micAccess();
    const id = $('#inDev').value;
    A.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    await listInputs();
    A.ctx = new AudioContext();
    A.src = A.ctx.createMediaStreamSource(A.stream);
    A.an = A.ctx.createAnalyser(); A.an.fftSize = 2048; A.an.smoothingTimeConstant = 0;
    A.proc = A.ctx.createScriptProcessor(4096, 1, 1);
    A.mute = A.ctx.createGain(); A.mute.gain.value = 0;
    A.src.connect(A.an); A.src.connect(A.proc); A.proc.connect(A.mute); A.mute.connect(A.ctx.destination);
    A.rs = new DSP.Resampler(A.ctx.sampleRate);
    A.dtmf = new DSP.DTMFDecoder(onDigit);
    A.afsk = new DSP.AFSKDecoder(onFrame);
    A.above = 0; A.below = 0; A.active = null;
    A.proc.onaudioprocess = onAudio;
    A.running = true; drawWaterfall();
    $('#btnAudio').textContent = 'Stop receiver'; $('#dotAudio').className = 'dot on';
    $('#audioState').textContent = 'Listening on ' + ($('#inDev').selectedOptions[0]?.textContent || 'default input');
    $('#railFoot').textContent = 'Receiver on · ' + Math.round(A.ctx.sampleRate / 1000) + ' kHz';
  } catch (e) { toast('Could not open the audio input: ' + e.message, true); }
}
function stopAudio() {
  A.running = false;
  if (A.active) endActivity();
  try { A.proc.disconnect(); A.src.disconnect(); A.stream.getTracks().forEach(t => t.stop()); A.ctx.close(); } catch { }
  $('#btnAudio').textContent = 'Start receiver'; $('#dotAudio').className = 'dot'; $('#audioState').textContent = 'Receiver idle'; $('#railFoot').textContent = 'Audio off';
  $('#meterFill').style.width = '0';
}
$('#btnAudio').onclick = () => A.running ? stopAudio() : startAudio();

function onAudio(e) {
  const x = e.inputBuffer.getChannelData(0);
  let s = 0, pk = 0; for (const v of x) { s += v * v; const a = Math.abs(v); if (a > pk) pk = a; }
  const db = 10 * Math.log10(s / x.length + 1e-12);
  const open = db > sqDb();
  $('#meterFill').style.width = Math.max(0, Math.min(100, (db + 80) / 80 * 100)) + '%';
  $('#meterFill').classList.toggle('open', open);
  $('#meterDb').textContent = (db < -79 ? '-∞' : db.toFixed(0)) + ' dB';
  // activity / squelch logger
  const bufMs = x.length / A.ctx.sampleRate * 1000;
  if (open) { A.above++; A.below = 0; if (!A.active && A.above * bufMs >= 160) startActivity(); if (A.active) A.active.peak = Math.max(A.active.peak, db); }
  else { A.above = 0; if (A.active) { A.below++; if (A.below * bufMs >= 1500) endActivity(); } }
  const r = A.rs.process(x);
  if ($('#decDTMF').checked) A.dtmf.push(r);
  if ($('#decAPRS').checked) A.afsk.push(r);
  if (window.FEAT) FEAT.audio(x, r, A.ctx.sampleRate);
}
function startActivity() {
  A.active = { t: Date.now(), peak: -99, chunks: [] };
  if (window.FEAT) FEAT.activityStart();
  $('#dotAudio').className = 'dot busy';
  if ($('#recClips').checked && window.MediaRecorder) {
    try {
      const rec = new MediaRecorder(A.stream, { mimeType: 'audio/webm;codecs=opus' });
      rec.ondataavailable = ev => A.active && A.active.rec === rec ? A.active.chunks.push(ev.data) : rec._chunks.push(ev.data);
      rec._chunks = []; rec.start(); A.active.rec = rec;
    } catch { }
  }
}
function endActivity() {
  const a = A.active; A.active = null; $('#dotAudio').className = A.running ? 'dot on' : 'dot';
  const dur = (Date.now() - a.t - 1500) / 1000;
  const entry = { type: 'audio', t: a.t, dur: Math.max(0.2, +dur.toFixed(1)), detail: `Signal, peak ${a.peak.toFixed(0)} dB` };
  entry.ch = monLabel();
  if (window.FEAT) FEAT.activityEnd(entry);
  if (a.rec) {
    const rec = a.rec;
    rec.onstop = async () => {
      const blob = new Blob(a.chunks.concat(rec._chunks), { type: 'audio/webm' });
      if (blob.size > 500) entry.clip = await api.saveClip(`rx-${new Date(a.t).toISOString().replace(/[:.]/g, '-')}.webm`, await blob.arrayBuffer());
      addLog(entry);
    };
    rec.stop();
  } else addLog(entry);
}

// DTMF bursts
let burst = null;
function onDigit(d) {
  if (!burst) burst = { t: Date.now(), digits: '' };
  burst.digits += d; $('#dtmfBig').textContent = burst.digits;
  clearTimeout(burst.h); burst.h = setTimeout(() => { addLog({ type: 'dtmf', t: burst.t, detail: burst.digits }); lcd('DTMF', burst.digits.slice(-8), 'TONES IN'); burst = null; }, 1200);
  document.querySelectorAll('.keypad button').forEach(b => { if (b.textContent === d) { b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 150); } });
}
function onFrame(f) {
  let detail = f.text;
  addLog({ type: 'aprs', detail, src: f.src, pos: f.aprs && f.aprs.type === 'position' ? [f.aprs.lat, f.aprs.lon] : null });
  lcd('APRS', f.src.slice(0, 9), (f.aprs?.type || 'PACKET').toUpperCase());
  if (window.FEAT) FEAT.frame(f);
}

// waterfall
function drawWaterfall() {
  const cv = $('#waterfall'), g = cv.getContext('2d');
  const bins = new Uint8Array(A.an.frequencyBinCount);
  const maxBin = Math.floor(6000 / (A.ctx.sampleRate / A.an.fftSize));
  const step = () => {
    if (!A.running) return;
    const want = Math.round(cv.clientWidth * devicePixelRatio) || 900;
    if (cv.width !== want) { cv.width = want; cv.height = 300; }
    const w = cv.width, h = cv.height;
    A.an.getByteFrequencyData(bins);
    const img = g.getImageData(0, 0, w, h - 1); g.putImageData(img, 0, 1);
    for (let x = 0; x < w; x++) {
      const v = bins[Math.floor(x / w * maxBin)] / 255;
      g.fillStyle = v < .35 ? `rgb(${23 + v * 60},${34 + v * 120},${42 + v * 240})` : `rgb(${Math.min(255, 60 + (v - .35) * 300)},${Math.min(200, 90 + (v - .35) * 170)},${Math.max(40, 140 - (v - .35) * 160)})`;
      g.fillRect(x, 0, 1, 1);
    }
    g.fillStyle = 'rgba(240,172,62,.55)';
    [1200, 2200].forEach(f => g.fillRect(Math.round(f / 6000 * w), 0, 1, 3));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------- monitor channel ----------------
function fillMonitorSelect() {
  const s = $('#monCh');
  s.replaceChildren(el('option', { value: '', text: 'Unknown / scanning' }), ...S.channels.map((c, i) => c && el('option', { value: String(i), text: `${String(i).padStart(3, '0')} ${c.name}  ${(+c.rx).toFixed(4)}` })).filter(Boolean));
  s.value = S.monitor;
}
$('#monCh').onchange = e => { S.monitor = e.target.value; localStorage.setItem('monitor', S.monitor); if (S.monitor) lcdChannel(+S.monitor); };
const monLabel = () => S.monitor && S.channels[+S.monitor] ? S.channels[+S.monitor].name : 'Scan';

// ---------------- log ----------------
async function initLog() { S.log = await api.loadLog(); renderFeeds(); }
let saveT;
function addLog(e) {
  e.t = e.t || Date.now(); e.ch = e.ch || (e.type === 'radio' ? '' : monLabel());
  S.log.push(e); if (S.log.length > 5000) S.log.splice(0, S.log.length - 5000);
  clearTimeout(saveT); saveT = setTimeout(() => api.saveLog(S.log), 800);
  renderFeeds();
  if ($('#view-log').classList.contains('active')) renderLog();
  if ($('#view-scan').classList.contains('active')) drawActivity();
}
const KIND = { audio: 'Signal', dtmf: 'DTMF', aprs: 'APRS', radio: 'Radio', cw: 'Morse', image: 'Image', tx: 'Sent' };
function feedItem(e) {
  return el('li', {}, el('span', { class: 't', text: fmtTime(e.t) }), el('span', { class: 'k ' + e.type, text: KIND[e.type] }), e.ch ? el('span', { class: 't', text: e.ch }) : null,
    el('span', { class: 'body', text: e.detail + (e.dur ? `  (${e.dur}s)` : '') }), e.pos ? el('div', { class: 't', text: `Position ${e.pos[0]}, ${e.pos[1]}` }) : null);
}
function renderFeeds() {
  const recent = S.log.slice(-200).reverse();
  const put = (sel, items, empty) => $(sel).replaceChildren(...(items.length ? items.map(feedItem) : [el('li', { class: 'empty', text: empty })]));
  put('#feed', recent.filter(e => e.type !== 'radio').slice(0, 120), 'Connect the radio’s speaker jack to your computer’s audio input, then start the receiver. Decodes show here.');
  put('#scanFeed', recent.filter(e => e.type === 'audio').slice(0, 60), 'No activity yet.');
  put('#dtmfFeed', recent.filter(e => e.type === 'dtmf').slice(0, 60), 'Received digits appear here, grouped per burst.');
}
function renderLog() {
  const box = $('#logFilters');
  box.replaceChildren(...[['all', 'All'], ['audio', 'Signals'], ['cw', 'Morse'], ['dtmf', 'DTMF'], ['aprs', 'APRS'], ['image', 'Images'], ['tx', 'Sent'], ['radio', 'Radio']].map(([k, l]) => el('button', { class: 'chip' + (S.filter === k ? ' on' : ''), text: `${l} ${k === 'all' ? S.log.length : S.log.filter(e => e.type === k).length}`, onclick: () => { S.filter = k; renderLog(); } })));
  const q = $('#logSearch').value.toLowerCase();
  const rows = S.log.filter(e => (S.filter === 'all' || e.type === S.filter) && (!q || (e.detail + ' ' + e.ch).toLowerCase().includes(q))).slice(-800).reverse();
  $('#logTable tbody').replaceChildren(...(rows.length ? rows.map(e => el('tr', {},
    el('td', { text: fmtDate(e.t) }), el('td', { text: KIND[e.type] }), el('td', { text: e.ch || '' }),
    el('td', { class: 'detail', text: e.detail + (e.pos ? `  [${e.pos.join(', ')}]` : '') }), el('td', { text: e.dur ? e.dur + ' s' : '' }),
    el('td', {}, e.clip ? el('audio', { controls: true, preload: 'none', src: 'app://data/recordings/' + e.clip.split(/[\\/]/).pop() }) : e.image ? el('img', { src: 'app://data/' + e.image, style: 'height:48px;border-radius:4px', alt: '' }) : null))) :
    [el('tr', {}, el('td', { colspan: 6, class: 'muted', text: 'Nothing logged yet. Start the receiver on the Receive page.' }))]));
}
$('#logSearch').oninput = renderLog;
$('#btnLogExport').onclick = async () => {
  const esc = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const csv = ['time,type,channel,detail,seconds,lat,lon,recording', ...S.log.map(e => [new Date(e.t).toISOString(), e.type, e.ch, e.detail, e.dur || '', e.pos?.[0] || '', e.pos?.[1] || '', e.clip || ''].map(esc).join(','))].join('\n');
  const p = await api.saveText('uv5r-log.csv', csv, [{ name: 'CSV', extensions: ['csv'] }]); if (p) toast('Exported ' + S.log.length + ' entries');
};
$('#btnLogFolder').onclick = () => api.openDataFolder();
$('#btnLogClear').onclick = () => { if (!confirm('Clear all log entries? Recordings stay on disk.')) return; S.log = []; api.saveLog([]); renderLog(); renderFeeds(); };
$('#btnClearFeed').onclick = () => $('#feed').replaceChildren(el('li', { class: 'empty', text: 'Cleared. The full history stays in Log.' }));

// ---------------- scan ----------------
function renderScanGroups() {
  const box = $('#scanGroups'); const items = [];
  const groups = [...new Set(S.channels.filter(Boolean).map(groupOf))];
  for (const g of groups) {
    const chans = S.channels.filter(c => c && groupOf(c) === g), on = chans.filter(c => c.skip !== 'S').length;
    const cb = el('input', { type: 'checkbox', checked: on > 0, onchange: e => { chans.forEach(c => c.skip = e.target.checked ? '' : 'S'); persist(); renderScanGroups(); renderTable(); } });
    if (on > 0 && on < chans.length) cb.indeterminate = true;
    items.push(el('label', {}, el('span', {}, cb, ' ', g), el('span', { class: 'c', text: `${on}/${chans.length}` })));
  }
  box.replaceChildren(...items);
}
$('#btnScanWrite').onclick = async () => { try { await writeRadio(`Wrote scan list: ${S.channels.filter(c => c && c.skip !== 'S').length} channels`); } catch (e) { fail(e); } finally { busy(false); } };
function drawActivity() {
  const cv = $('#activity'), g = cv.getContext('2d');
  const w = cv.width = cv.clientWidth * devicePixelRatio || 700, h = cv.height = 200 * devicePixelRatio;
  const now = Date.now(), bins = new Array(60).fill(0);
  const hits = S.log.filter(e => e.type === 'audio' && now - e.t < 3600e3);
  hits.forEach(e => bins[59 - Math.floor((now - e.t) / 60e3)] += 1);
  $('#scanHits').textContent = `${hits.length} stop${hits.length === 1 ? '' : 's'}`;
  g.fillStyle = '#17222A'; g.fillRect(0, 0, w, h);
  const max = Math.max(3, ...bins), bw = w / 60;
  g.fillStyle = '#F0AC3E';
  bins.forEach((v, i) => { const bh = v / max * (h - 30 * devicePixelRatio); g.fillRect(i * bw + 1, h - 18 * devicePixelRatio - bh, bw - 2, bh); });
  g.fillStyle = '#8FA0AC'; g.font = `${11 * devicePixelRatio}px -apple-system, sans-serif`;
  g.fillText('-60 min', 4, h - 4); g.fillText('now', w - 26 * devicePixelRatio, h - 4); g.fillText(`max ${max}/min`, 4, 14 * devicePixelRatio);
}
setInterval(() => { if ($('#view-scan').classList.contains('active')) drawActivity(); }, 30000);

// ---------------- DTMF send ----------------
const KEYS = ['1', '2', '3', 'A', '4', '5', '6', 'B', '7', '8', '9', 'C', '*', '0', '#', 'D'];
$('#keypad').replaceChildren(...KEYS.map(k => el('button', { text: k, 'aria-label': 'Send ' + k, onclick: () => sendTones(k, 0) })));
let outCtx;
async function sendTones(seq, delayMs = +$('#dtLead').value) {
  seq = seq.toUpperCase().replace(/[^0-9A-D*#]/g, ''); if (!seq) return toast('Use digits 0–9, A–D, * and #', true);
  if (!outCtx) outCtx = new AudioContext();
  const dev = $('#outDev').value; if (dev && outCtx.setSinkId && outCtx.sinkId !== dev) { try { await outCtx.setSinkId(dev); } catch { } }
  const sr = outCtx.sampleRate, s = DSP.dtmfSamples(seq, sr, +$('#dtOn').value, +$('#dtOff').value);
  const buf = outCtx.createBuffer(1, s.length, sr); buf.copyToChannel(Float32Array.from(s), 0);
  const src = outCtx.createBufferSource(); src.buffer = buf; src.connect(outCtx.destination);
  src.start(outCtx.currentTime + delayMs / 1000);
  if (seq.length > 1) { addLog({ type: 'dtmf', detail: 'Sent ' + seq, ch: monLabel() }); toast('Sending ' + seq); }
}
$('#btnSendSeq').onclick = () => sendTones($('#dtmfSeq').value);
$('#dtmfSeq').onkeydown = e => { if (e.key === 'Enter') sendTones(e.target.value); };
function renderSaved() {
  $('#savedSeq').replaceChildren(...S.saved.map((s, k) => el('li', {}, el('strong', { text: s.label }), el('code', { text: s.seq }), el('button', { text: 'Send', onclick: () => sendTones(s.seq) }), el('button', { class: 'ghost', text: 'Remove', onclick: () => { S.saved.splice(k, 1); localStorage.setItem('savedSeq', JSON.stringify(S.saved)); renderSaved(); } }))));
}
$('#btnSaveSeq').onclick = () => { const seq = $('#dtmfSeq').value.trim(); if (!seq) return toast('Type a sequence first', true); S.saved.push({ label: $('#seqLabel').value.trim() || seq, seq }); localStorage.setItem('savedSeq', JSON.stringify(S.saved)); $('#seqLabel').value = ''; renderSaved(); };

// ---------------- boot ----------------
(function boot() {
  const sq = localStorage.getItem('sq'); if (sq) { $('#sq').value = sq; $('#sqVal').textContent = sq + ' dB'; }
  placeSq(); renderAllChannels(); renderSaved(); initLog(); listInputs(); listOutputs().catch(() => { });
  navigator.mediaDevices.addEventListener?.('devicechange', () => { listInputs(); listOutputs(); });
  const first = S.channels.findIndex(Boolean); if (first >= 0) lcdChannel(S.monitor ? +S.monitor : first);
  $('#lcdName').textContent = $('#lcdName').textContent || 'READY';
})();
