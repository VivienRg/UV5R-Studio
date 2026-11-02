param(
    [string]$OutputPath = "UV5R-Studio-Code-Signing.pfx",
    [Parameter(Mandatory = $true)]
    [string]$Password
)

$ErrorActionPreference = "Stop"
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = [System.IO.Path]::GetDirectoryName($resolvedOutput)

if (-not (Test-Path $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}

$certificate = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=UV5R Studio Community" `
    -FriendlyName "UV5R Studio self-signed code-signing certificate" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -HashAlgorithm SHA256 `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(3)

$securePassword = ConvertTo-SecureString -String $Password -AsPlainText -Force
Export-PfxCertificate `
    -Cert $certificate `
    -FilePath $resolvedOutput `
    -Password $securePassword `
    -ChainOption EndEntityCertOnly | Out-Null

Write-Host "Created self-signed code-signing certificate: $resolvedOutput"
Write-Host "Thumbprint: $($certificate.Thumbprint)"
Write-Warning "Windows does not trust this certificate by default. SmartScreen warnings are expected."
