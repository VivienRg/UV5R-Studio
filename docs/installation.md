# Installation

Download the files for the latest version from [GitHub Releases](https://github.com/vivienroggero/uv5r-studio/releases/latest).

## macOS

Choose the DMG matching your Mac: `arm64` for Apple silicon or `x64` for Intel. Open the DMG, drag UV5R Studio to Applications, and launch it. Published macOS builds are signed with a Developer ID Application certificate and notarized by Apple.

## Windows

Download the x64 `.exe` installer and follow the setup wizard.

> [!WARNING]
> Windows builds use a self-signed certificate. Windows and Microsoft Defender SmartScreen do not trust that certificate by default and may display an **Unknown publisher** or **Windows protected your PC** warning. Verify the release source and its SHA-256 value against `SHA256SUMS.txt` before choosing **More info → Run anyway**. Do not bypass such warnings for a file obtained anywhere except this project's official GitHub Releases page.

Verify the downloaded installer in PowerShell:

```powershell
Get-FileHash ".\UV5R Studio-1.1.0-x64.exe" -Algorithm SHA256
```

## Linux

Download the x64 AppImage for a portable application or the `.deb` package for Debian and Ubuntu systems.

For an AppImage:

```bash
chmod +x "UV5R Studio-"*.AppImage
./"UV5R Studio-"*.AppImage
```

For a Debian package:

```bash
sudo apt install ./"UV5R Studio-"*.deb
```

USB serial and audio-device access may require membership in system groups such as `dialout` and `audio`, depending on the distribution.
