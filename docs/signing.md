# Signing and notarization

Private keys and certificates must never be committed. Local paths belong in `.env`; CI values belong in GitHub Actions secrets.

## macOS

macOS release builds require a Developer ID Application `.p12` certificate plus App Store Connect notarization credentials. Configure:

- `MAC_CSC_LINK` — base64-encoded `.p12` for GitHub Actions.
- `MAC_CSC_KEY_PASSWORD` — export password for the `.p12`.
- `APPLE_API_KEY` — base64-encoded `.p8` in GitHub Actions or an absolute `.p8` path locally.
- `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `APPLE_TEAM_ID`.
- `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` as fallback authentication.
- Repository variable `APP_BUNDLE_ID=com.uv5r-studio.app`.

## Windows self-signed certificate

Run PowerShell on Windows to create a password-protected certificate:

```powershell
.\scripts\create-windows-certificate.ps1 `
  -OutputPath "$HOME\UV5R-Studio-Code-Signing.pfx" `
  -Password "use-a-long-random-password"
```

Convert the `.pfx` to one-line base64 and save it as the `WIN_CSC_LINK` GitHub secret:

```powershell
$bytes = [IO.File]::ReadAllBytes("$HOME\UV5R-Studio-Code-Signing.pfx")
[Convert]::ToBase64String($bytes) | gh secret set WIN_CSC_LINK
gh secret set WIN_CSC_KEY_PASSWORD
```

Use the same `.pfx` for subsequent releases so signed files retain a consistent certificate identity. Back it up securely; losing it requires creating a new identity.

Self-signing provides integrity and a consistent signer identity, but it does not establish public trust. SmartScreen warnings are expected until the application is signed with a certificate issued by a publicly trusted code-signing authority and builds sufficient reputation.
