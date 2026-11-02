const { app, BrowserWindow, ipcMain, dialog, session, systemPreferences, shell, protocol, safeStorage, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

// app:// serves the UI and user data with proper module, worker and WASM support.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.webm': 'audio/webm', '.wav': 'audio/wav', '.svg': 'image/svg+xml' };
function serveApp() {
  protocol.handle('app', async req => {
    const u = new URL(req.url);
    const base = u.host === 'data' ? dataDir() : path.join(__dirname, 'src');
    const file = path.normalize(path.join(base, decodeURIComponent(u.pathname)));
    if (!file.startsWith(base)) return new Response('Forbidden', { status: 403 });
    try {
      const body = fs.readFileSync(file);
      return new Response(body, { headers: {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'cross-origin' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}

let win;
let pendingPortCallback = null;

const dataDir = () => {
  const d = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(path.join(d, 'recordings'), { recursive: true });
  fs.mkdirSync(path.join(d, 'backups'), { recursive: true });
  fs.mkdirSync(path.join(d, 'images'), { recursive: true });
  return d;
};

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 1100, minHeight: 700,
    title: 'UV5R Studio',
    backgroundColor: '#E4E8EB',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableBlinkFeatures: 'Serial'
    }
  });

  const ses = win.webContents.session;

  // Web Serial: let the renderer pick the port from its own dialog.
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    pendingPortCallback = callback;
    webContents.send('serial-ports', portList.map(p => ({
      portId: p.portId, portName: p.portName, displayName: p.displayName,
      vendorId: p.vendorId, productId: p.productId
    })));
  });
  ses.on('serial-port-added', (e, port) => win.webContents.send('serial-port-added', port));
  ses.setPermissionCheckHandler((wc, permission) => ['serial', 'media', 'audioCapture', 'speaker-selection'].includes(permission) || permission === 'serial');
  ses.setDevicePermissionHandler(details => details.deviceType === 'serial');
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(['media', 'audioCapture', 'serial', 'speaker-selection'].includes(permission)));

  win.loadURL('app://local/index.html');
}

ipcMain.on('serial-port-chosen', (e, portId) => {
  if (pendingPortCallback) { pendingPortCallback(portId || ''); pendingPortCallback = null; }
});

ipcMain.handle('mic-access', async () => {
  if (process.platform === 'darwin') {
    const s = systemPreferences.getMediaAccessStatus('microphone');
    if (s === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  }
  return true;
});

ipcMain.handle('open-text', async (e, filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], 'utf8') };
});
ipcMain.handle('save-text', async (e, name, text, filters) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text, 'utf8');
  return r.filePath;
});
ipcMain.handle('open-binary', async (e, filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], data: fs.readFileSync(r.filePaths[0]) };
});
ipcMain.handle('save-binary', async (e, name, data, filters) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(data));
  return r.filePath;
});
ipcMain.handle('auto-backup', async (e, data) => {
  const f = path.join(dataDir(), 'backups', `uv5r-${new Date().toISOString().replace(/[:.]/g, '-')}.img`);
  fs.writeFileSync(f, Buffer.from(data));
  return f;
});
ipcMain.handle('save-clip', async (e, name, data) => {
  const f = path.join(dataDir(), 'recordings', path.basename(name));
  fs.writeFileSync(f, Buffer.from(data));
  return 'recordings/' + path.basename(name);
});
ipcMain.handle('save-image', async (e, name, data) => {
  fs.writeFileSync(path.join(dataDir(), 'images', path.basename(name)), Buffer.from(data));
  return 'images/' + path.basename(name);
});
ipcMain.handle('list-images', async () => fs.readdirSync(path.join(dataDir(), 'images')).filter(f => f.endsWith('.png')).sort().reverse().slice(0, 60).map(f => 'images/' + f));

// ---- API key (encrypted with the OS keychain) and translation via Claude ----
const keyFile = () => path.join(app.getPath('userData'), 'anthropic.key');
function readKey() {
  try { const b = fs.readFileSync(keyFile()); return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString('utf8'); } catch { return null; }
}
ipcMain.handle('key-set', async (e, key) => {
  if (!key) { try { fs.unlinkSync(keyFile()); } catch { } return false; }
  fs.writeFileSync(keyFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key.trim()) : key.trim());
  return true;
});
ipcMain.handle('key-has', async () => !!readKey());
ipcMain.handle('translate', async (e, { text, target, model }) => {
  const key = readKey();
  if (!key) throw new Error('Add an Anthropic API key in Settings to translate.');
  const r = await net.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: model || 'claude-haiku-5-5', max_tokens: 1024,
      system: 'You translate short two-way radio messages. Reply with the translation only, no notes or quotes. Keep callsigns, numbers, frequencies, Q-codes and radio abbreviations (73, QTH, QSL, CQ) unchanged. If the text is already in the target language, return it unchanged.',
      messages: [{ role: 'user', content: `Target language: ${target}\n\n${text}` }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Translation failed: HTTP ' + r.status));
  return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
});

// ---- Text to speech: macOS voices rendered to a WAV so it can go to the radio output ----
ipcMain.handle('tts-voices', async () => new Promise(res => {
  if (process.platform !== 'darwin') return res([]);
  execFile('say', ['-v', '?'], (err, out) => {
    if (err) return res([]);
    res(out.split('\n').map(l => l.match(/^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/)).filter(Boolean).map(m => ({ name: m[1].trim(), lang: m[2] })));
  });
}));
ipcMain.handle('tts-render', async (e, { text, voice, rate }) => new Promise((res, rej) => {
  if (process.platform !== 'darwin') return rej(new Error('System voices are only wired up on macOS.'));
  const f = path.join(os.tmpdir(), `uv5r-tts-${Date.now()}.wav`);
  const args = ['-o', f, '--file-format=WAVE', '--data-format=LEI16@22050'];
  if (voice) args.push('-v', voice); if (rate) args.push('-r', String(rate));
  args.push('--', text);
  execFile('say', args, err => { if (err) return rej(err); const b = fs.readFileSync(f); fs.unlink(f, () => { }); res(b); });
}));

// ---- Code signature check for Certified mode ----
// Set to your Apple Developer Team ID (for example 'AB12CD34EF') to require your Developer ID signature.
// Left empty, any intact signature (including ad-hoc) passes.
const REQUIRED_TEAM_ID = '';
ipcMain.handle('sig-check', async () => {
  if (process.platform !== 'darwin') return { valid: true, kind: 'Not required on ' + process.platform, path: process.execPath };
  const appPath = path.resolve(process.execPath, '../../..');
  const run = args => new Promise(r => execFile('codesign', args, (err, out, errOut) => r({ ok: !err, text: (out || '') + (errOut || '') })));
  const v = await run(['--verify', '--deep', '--strict', appPath]);
  const d = await run(['-dv', '--verbose=2', appPath]);
  const get = k => { const m = d.text.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
  const auth = get('Authority');
  const team = get('TeamIdentifier');
  if (v.ok && REQUIRED_TEAM_ID && team !== REQUIRED_TEAM_ID) return { valid: false, detail: `signed by team ${team || 'none'}, expected ${REQUIRED_TEAM_ID}`, kind: auth || 'Ad-hoc signature', team, identifier: get('Identifier'), path: appPath };
  return { valid: v.ok, detail: v.ok ? '' : v.text.trim().split('\n').pop(), kind: /adhoc/.test(get('Signature')) ? 'Ad-hoc signature' : auth ? auth : 'Unsigned', team: get('TeamIdentifier'), identifier: get('Identifier'), path: appPath };
});
ipcMain.handle('load-log', async () => {
  const f = path.join(dataDir(), 'log.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
});
ipcMain.handle('save-log', async (e, entries) => {
  fs.writeFileSync(path.join(dataDir(), 'log.json'), JSON.stringify(entries));
  return true;
});
ipcMain.handle('open-data-folder', async () => shell.openPath(dataDir()));
ipcMain.handle('data-dir', async () => dataDir());

app.whenReady().then(() => {
  serveApp();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Build-time self tests (screenshots, fake-audio receive, transmit). Only loaded when asked.
if (process.env.UV5R_SHOT || process.env.UV5R_E2E || process.env.UV5R_TXTEST) require('./dev/selftest.js')({ app, getWin: () => win, fs, path });
