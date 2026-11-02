// Refresh the speech engine files in src/vendor from npm.
// Usage: npm run vendor   (set TRANSFORMERS_VERSION to pick another version)
const { execSync } = require('child_process'); const fs = require('fs'); const path = require('path'); const os = require('os');
const v = process.env.TRANSFORMERS_VERSION || '3.8.1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tjs-'));
execSync(`npm init -y && npm i @huggingface/transformers@${v} --ignore-scripts --no-audit --no-fund`, { cwd: tmp, stdio: 'inherit' });
const dist = path.join(tmp, 'node_modules/@huggingface/transformers/dist');
const out = path.join(__dirname, '../src/vendor');
for (const f of ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) fs.copyFileSync(path.join(dist, f), path.join(out, f));
console.log('Updated src/vendor to @huggingface/transformers', v);
