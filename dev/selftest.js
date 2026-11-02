// Headless checks used while building. Run with xvfb on Linux or directly on macOS.
module.exports = function ({ app, getWin, fs, path }) {
// Self-check mode used during build: screenshot each view and exit.
if (process.env.UV5R_SHOT) {
  app.whenReady().then(() => setTimeout(async () => {
    const views = ['channels', 'radio', 'receive', 'conv', 'morse', 'images', 'scan', 'dtmf', 'log', 'settings'];
    for (const v of views) {
      await getWin().webContents.executeJavaScript(`document.querySelector('[data-view="${v}"]').click()`);
      await new Promise(r => setTimeout(r, 400));
      const img = await getWin().webContents.capturePage();
      fs.writeFileSync(path.join(process.env.UV5R_SHOT, v + '.png'), img.toPNG());
    }
    const probe = await getWin().webContents.executeJavaScript(`new Promise(r => { const w = new Worker('speech-worker.js', { type: 'module' }); const t = setTimeout(() => r({ worker: 'timeout' }), 8000); w.onmessage = e => { clearTimeout(t); r({ worker: e.data, isolated: self.crossOriginIsolated }); }; w.onerror = e => { clearTimeout(t); r({ worker: 'error ' + e.message }); }; })`);
    fs.writeFileSync(path.join(process.env.UV5R_SHOT, 'probe.json'), JSON.stringify(probe));
    const errs = await getWin().webContents.executeJavaScript('window.__errs || []');
    fs.writeFileSync(path.join(process.env.UV5R_SHOT, 'errors.json'), JSON.stringify(errs));
    app.exit(0);
  }, 1500));
}

// End-to-end receive check used during build: feeds a WAV through the fake microphone.
if (process.env.UV5R_E2E) {
  app.whenReady().then(() => setTimeout(async () => {
    const out = process.env.UV5R_E2E;
    await getWin().webContents.executeJavaScript(`document.querySelector('[data-view="receive"]').click(); document.querySelector('#btnAudio').click(); true`);
    await new Promise(r => setTimeout(r, +process.env.UV5R_E2E_MS || 60000));
    const res = await getWin().webContents.executeJavaScript(`({ log: S.log.map(e => ({ type: e.type, detail: e.detail })), conv: JSON.parse(localStorage.getItem('conv') || '[]').map(m => ({ mode: m.mode, dir: m.dir, text: m.text, from: m.from })), cw: document.querySelector('#cwOut').textContent, errs: window.__errs })`);
    fs.writeFileSync(path.join(out, 'e2e.json'), JSON.stringify(res, null, 1));
    for (const v of ['images', 'conv']) { await getWin().webContents.executeJavaScript(`document.querySelector('[data-view="${v}"]').click()`); await new Promise(r => setTimeout(r, 500)); fs.writeFileSync(path.join(out, 'e2e-' + v + '.png'), (await getWin().webContents.capturePage()).toPNG()); }
    app.exit(0);
  }, 2000));
}

if (process.env.UV5R_TXTEST) {
  app.whenReady().then(() => setTimeout(async () => {
    const js = `(async () => {
      localStorage.setItem('settings', JSON.stringify({ call: 'BV2XYZ', lic: 'Class 2', ack: true, certified: true, idCw: true, lead: 0, cwWpm: 30 }));
      return true; })()`;
    await getWin().webContents.executeJavaScript(js); getWin().webContents.reload();
    await new Promise(r => setTimeout(r, 2500));
    const res = await getWin().webContents.executeJavaScript(`(async () => {
      const out = { badge: document.querySelector('#txBadge').textContent };
      document.querySelector('#cwText').value = 'TEST'; document.querySelector('#btnCwSend').click();
      await new Promise(r => setTimeout(r, 9000));
      document.querySelector('[data-mode="packet"]').click(); document.querySelector('#pktTo').value = 'BV2ABC'; document.querySelector('#convText').value = '你好 test';
      document.querySelector('#btnConvSend').click(); await new Promise(r => setTimeout(r, 7000));
      document.querySelector('[data-mode="morse"]').click(); document.querySelector('#convText').value = 'QSL 73';
      document.querySelector('#btnConvSend').click(); await new Promise(r => setTimeout(r, 9000));
      out.log = S.log.filter(e => e.type === 'tx').map(e => e.detail + ' ' + e.dur + 's');
      out.conv = JSON.parse(localStorage.getItem('conv') || '[]').filter(m => m.dir === 'out').map(m => m.mode + ':' + m.text);
      out.errs = window.__errs; out.toast = document.querySelector('#toast').textContent; return out; })()`);
    fs.writeFileSync(path.join(process.env.UV5R_TXTEST, 'tx.json'), JSON.stringify(res, null, 1));
    app.exit(0);
  }, 2000));
}

};
