param(
  [ValidatePattern('^[a-z]{32}$')]
  [AllowEmptyString()][string]$ChromeExtensionId = '',
  [string]$EdgeExtensionId = '',
  [string]$FirefoxExtensionId = 'streamfirefly@example.invalid',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'StreamFirefly\bin')
)
$ErrorActionPreference = 'Stop'
$bundleRoot = Split-Path -Parent $PSScriptRoot
$packageInfoPath = Join-Path $bundleRoot 'PACKAGE-INFO.json'
if (-not (Test-Path -LiteralPath $packageInfoPath -PathType Leaf)) { throw 'PACKAGE-INFO.json was not found; extract the complete release bundle first' }
$packageInfo = Get-Content -Raw -LiteralPath $packageInfoPath | ConvertFrom-Json
if ($packageInfo.sourceDirty -ne $false -or @($packageInfo.sourceChanges).Count) { throw 'Release package source is dirty' }
$checksumPath=Join-Path $bundleRoot 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) { throw 'Package checksums are missing' }
$prefix=[System.IO.Path]::GetFullPath($bundleRoot).TrimEnd('\')+'\'
$checked=@{}
foreach ($line in Get-Content -LiteralPath $checksumPath) {
  if ($line -notmatch '^([a-f0-9]{64})  (.+)$') { throw 'Invalid package checksum line' }
  $hash=$Matches[1];$relative=$Matches[2]
  $file=[System.IO.Path]::GetFullPath((Join-Path $bundleRoot $relative))
  if (-not $file.StartsWith($prefix,[System.StringComparison]::OrdinalIgnoreCase) -or $checked.ContainsKey($file)) { throw 'Unsafe or duplicate checksum destination' }
  if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw "Package integrity check failed: $relative" }
  $checked[$file]=$true
}
foreach ($file in Get-ChildItem -LiteralPath $bundleRoot -Recurse -File) {
  if ($file.FullName -ne $checksumPath -and -not $checked.ContainsKey($file.FullName)) { throw "Package file has no checksum: $($file.Name)" }
}
$osArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$architectureMatches = ($packageInfo.architecture -eq 'x64' -and $osArchitecture -eq 'AMD64') -or ($packageInfo.architecture -eq 'arm64' -and $osArchitecture -eq 'ARM64')
if (-not $architectureMatches) {
  throw "This bundle is $($packageInfo.architecture), but Windows reports $osArchitecture. Use the matching StreamFirefly release bundle."
}
$sourceDir = Join-Path $bundleRoot 'native-host'
$required = @('streamfirefly-native.exe', 'ffmpeg.exe', 'THIRD_PARTY_NOTICES.md', 'FFMPEG-SOURCE.txt', 'FFMPEG-LICENSE.txt')
foreach ($name in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceDir $name) -PathType Leaf)) { throw "Release bundle file is missing: native-host\$name" }
}
foreach ($name in @('streamfirefly-native.exe','ffmpeg.exe')) {
  $reader=[System.IO.BinaryReader]::new([System.IO.File]::OpenRead((Join-Path $sourceDir $name)))
  try { $reader.BaseStream.Position=0x3c;$offset=$reader.ReadInt32();$reader.BaseStream.Position=$offset+4;$machine='{0:X4}' -f $reader.ReadUInt16() } finally { $reader.Dispose() }
  $expectedMachine=if ($packageInfo.architecture -eq 'x64') { '8664' } else { 'AA64' }
  if ($machine -ne $expectedMachine) { throw "Executable architecture mismatch: $name" }
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
try {
  foreach ($name in $required) { Copy-Item -LiteralPath (Join-Path $sourceDir $name) -Destination (Join-Path $InstallDir $name) -Force }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'register-native-host.ps1') -Destination (Join-Path $InstallDir 'register-native-host.ps1') -Force
} catch {
  throw "Unable to update StreamFirefly files. Close Chrome and Edge, then retry. $($_.Exception.Message)"
}
& (Join-Path $InstallDir 'register-native-host.ps1') -ChromeExtensionId $ChromeExtensionId -EdgeExtensionId $EdgeExtensionId -FirefoxExtensionId $FirefoxExtensionId -NativeHostPath (Join-Path $InstallDir 'streamfirefly-native.exe') -InstallDir $InstallDir
Write-Host "StreamFirefly native host installed in $InstallDir"
Write-Host 'Restart the browser after loading the Chromium extension or installing the signed Firefox add-on.'
