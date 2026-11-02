# Third-party software

| Component | Version | License | Where |
|---|---|---|---|
| Electron | 44.8.0 | MIT | runtime (devDependency, bundled by electron-builder) |
| Transformers.js (@huggingface/transformers) | 3.8.1 | Apache-2.0 | `src/vendor/transformers.min.js` |
| ONNX Runtime Web | bundled with Transformers.js 3.8.1 | MIT | `src/vendor/ort-wasm-simd-threaded.jsep.*` |
| Whisper base / small (Xenova ONNX exports of OpenAI Whisper) | downloaded at runtime | MIT | Hugging Face cache, not shipped |

The Transformers.js license is in `src/vendor/LICENSE-transformers.txt`. ONNX Runtime is MIT licensed (github.com/microsoft/onnxruntime). The UV-5R clone protocol follows the format documented by the CHIRP project; no CHIRP code is included.
