param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z]{32}$')]
  [string]$ChromeExtensionId,
  [string]$EdgeExtensionId = '',
  [string]$FirefoxExtensionId = 'streamfirefly@example.invalid'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$developmentChromeExtensionId = 'gimoeapmpoeogpabfdplccplmmohklff'
if ($ChromeExtensionId -eq $developmentChromeExtensionId) {
  throw 'The local development extension ID cannot be used for release assets. Use the ID assigned by Chrome Web Store.'
}
$manifest = Get-Content -Raw -LiteralPath (Join-Path $root 'extension\manifest.json') | ConvertFrom-Json
$release = Join-Path $root 'release'
New-Item -ItemType Directory -Force -Path $release | Out-Null
& $PSScriptRoot\package-extension.ps1 -Edition general -OutputDir $release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $PSScriptRoot\package-firefox-extension.ps1 -OutputDir $release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
foreach ($architecture in @('x64', 'arm64')) {
  & $PSScriptRoot\build-installer.ps1 -Architecture $architecture -ChromeExtensionId $ChromeExtensionId -EdgeExtensionId $EdgeExtensionId -FirefoxExtensionId $FirefoxExtensionId
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Copy-Item -LiteralPath (Join-Path $root "installer\output\StreamFirefly-Setup-$architecture.exe") -Destination $release -Force
}
$assets = @(
  (Join-Path $release "StreamFirefly-extension-$($manifest.version).zip"),
  (Join-Path $release "StreamFirefly-firefox-$($manifest.version)-test.xpi"),
  (Join-Path $release 'StreamFirefly-Setup-x64.exe'),
  (Join-Path $release 'StreamFirefly-Setup-arm64.exe')
)
foreach ($asset in $assets) {
  if (-not (Test-Path -LiteralPath $asset -PathType Leaf)) { throw "Release asset is missing: $asset" }
}
$checksums = foreach ($asset in $assets) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $asset).Hash.ToLowerInvariant()
  "$hash  $([System.IO.Path]::GetFileName($asset))"
}
Set-Content -LiteralPath (Join-Path $release 'SHA256SUMS.txt') -Value $checksums -Encoding ascii
Write-Host "Release assets are ready in $release for Chrome extension ID $ChromeExtensionId and Firefox extension ID $FirefoxExtensionId"
