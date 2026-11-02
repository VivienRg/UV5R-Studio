# Development

## Prerequisites

- Node.js 22.12 or newer
- npm
- macOS, Windows, or Linux

Install the locked dependencies and start Electron:

```bash
npm ci
npm start
```

Run the codec, protocol, Morse, and SSTV tests:

```bash
npm test
```

Run the generated-audio receiver self-test on a supported desktop environment:

```bash
npm run selftest
```

The application uses plain JavaScript, HTML, and CSS without a frontend compilation step. `main.js` is the Electron main process, `preload.js` is the context-isolated IPC bridge, and `src/index.html` is the renderer entry point.

Do not commit `node_modules`, `.env`, certificates, generated packages, radio backups, recordings, or received images. See [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request.
