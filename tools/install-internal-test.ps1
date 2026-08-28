param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z]{32}$')]
  [string]$ChromeExtensionId,
  [string]$EdgeExtensionId = '',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'StreamFirefly\bin')
)
$ErrorActionPreference = 'Stop'
$bundleRoot = Split-Path -Parent $PSScriptRoot
$packageInfoPath = Join-Path $bundleRoot 'PACKAGE-INFO.json'
if (-not (Test-Path -LiteralPath $packageInfoPath -PathType Leaf)) { throw 'PACKAGE-INFO.json was not found; extract the complete test bundle first' }
$packageInfo = Get-Content -Raw -LiteralPath $packageInfoPath | ConvertFrom-Json
$osArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$architectureMatches = ($packageInfo.architecture -eq 'x64' -and $osArchitecture -eq 'AMD64') -or ($packageInfo.architecture -eq 'arm64' -and $osArchitecture -eq 'ARM64')
if (-not $architectureMatches) {
  throw "This bundle is $($packageInfo.architecture), but Windows reports $osArchitecture. Use the matching StreamFirefly test bundle."
}
$sourceDir = Join-Path $bundleRoot 'native-host'
$required = @('streamfirefly-native.exe', 'ffmpeg.exe', 'THIRD_PARTY_NOTICES.md', 'FFMPEG-SOURCE.txt', 'FFMPEG-LICENSE.txt')
foreach ($name in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceDir $name) -PathType Leaf)) { throw "Test bundle file is missing: native-host\$name" }
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
try {
  foreach ($name in $required) { Copy-Item -LiteralPath (Join-Path $sourceDir $name) -Destination (Join-Path $InstallDir $name) -Force }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'register-native-host.ps1') -Destination (Join-Path $InstallDir 'register-native-host.ps1') -Force
} catch {
  throw "Unable to update StreamFirefly files. Close Chrome and Edge, then retry. $($_.Exception.Message)"
}
& (Join-Path $InstallDir 'register-native-host.ps1') -ChromeExtensionId $ChromeExtensionId -EdgeExtensionId $EdgeExtensionId -NativeHostPath (Join-Path $InstallDir 'streamfirefly-native.exe') -InstallDir $InstallDir
Write-Host "StreamFirefly internal test host installed in $InstallDir"
Write-Host 'Reload the unpacked extension in chrome://extensions before testing.'
