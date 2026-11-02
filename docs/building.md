# Building releases

Packaging is configured in `electron-builder.yml`. Install dependencies before running a build:

```bash
npm ci
```

## Local commands

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

Build artifacts are written to `release/`. Build each platform on its native operating system when signing or producing final release artifacts.

## GitHub Actions

`.github/workflows/build-release.yml` runs only for pushes to `release` and tags matching `v*.*.*`. It tests the source once, then builds:

- Signed and notarized arm64 and x64 DMG/ZIP packages on macOS.
- A self-signed x64 NSIS installer on Windows.
- x64 AppImage and Debian packages on Linux.

A branch push stores temporary workflow artifacts. A version tag must exactly match `package.json`, such as `v1.1.0`, and point to a commit on `release`. After all platform jobs succeed, the workflow creates or updates the corresponding GitHub Release.

Required repository secrets and variables are documented in [Signing](signing.md).
