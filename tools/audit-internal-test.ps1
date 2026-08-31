param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][ValidateSet('x64', 'arm64')][string]$ExpectedArchitecture
)
$ErrorActionPreference = 'Stop'
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
$bundleName = [System.IO.Path]::GetFileNameWithoutExtension($archivePath)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $entries = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
  $normalized = @($entries | ForEach-Object { $_.FullName.Replace('\', '/') })
  if ($normalized.Count -ne (@($normalized | Sort-Object -Unique)).Count) { throw 'Archive contains duplicate file destinations' }
  foreach ($name in $normalized) {
    if ($name.StartsWith('/') -or $name -match '^[A-Za-z]:' -or $name.Split('/') -contains '..') { throw "Unsafe archive entry: $name" }
    if (-not $name.StartsWith("$bundleName/")) { throw "Archive entry is outside the expected bundle root: $name" }
  }
  $required = @(
    "$bundleName/extension/manifest.json",
    "$bundleName/native-host/streamfirefly-native.exe",
    "$bundleName/native-host/ffmpeg.exe",
    "$bundleName/tools/install-internal-test.ps1",
    "$bundleName/tools/uninstall-internal-test.ps1",
    "$bundleName/README-INTERNAL.md",
    "$bundleName/PACKAGE-INFO.json",
    "$bundleName/SHA256SUMS.txt",
    "$bundleName/StreamFirefly-extension-0.7.0.zip",
    "$bundleName/StreamFirefly-firefox-0.7.0-test.xpi"
  )
  foreach ($name in $required) { if ($normalized -notcontains $name) { throw "Archive file is missing: $name" } }
} finally {
  $zip.Dispose()
}
$extractBase = Join-Path ([System.IO.Path]::GetTempPath()) "streamfirefly-audit-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $extractBase | Out-Null
try {
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractBase
  $root = Join-Path $extractBase $bundleName
  $rootPrefix = $root.TrimEnd('\') + '\'
  $checksums = Get-Content -LiteralPath (Join-Path $root 'SHA256SUMS.txt')
  $expectedFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($line in $checksums) {
    if ($line -notmatch '^([a-f0-9]{64})  (.+)$') { throw "Invalid checksum line: $line" }
    $relative = $Matches[2].Replace('/', '\')
    $path = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $path.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe checksum path: $relative" }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Checksum target is missing: $relative" }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -ne $Matches[1]) { throw "Checksum mismatch: $relative" }
    [void]$expectedFiles.Add($relative)
  }
  $actualFiles = Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object { $_.FullName.Substring($rootPrefix.Length) }
  foreach ($relative in $actualFiles) {
    if ($relative -ne 'SHA256SUMS.txt' -and -not $expectedFiles.Contains($relative)) { throw "File is absent from SHA256SUMS.txt: $relative" }
  }
  $packageInfo = Get-Content -Raw -LiteralPath (Join-Path $root 'PACKAGE-INFO.json') | ConvertFrom-Json
  if ($packageInfo.architecture -ne $ExpectedArchitecture) { throw "Package architecture metadata mismatch: $($packageInfo.architecture)" }
  function Get-PeMachine([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
      $reader = New-Object System.IO.BinaryReader($stream)
      $stream.Position = 0x3c
      $offset = $reader.ReadInt32()
      $stream.Position = $offset + 4
      return ('{0:X4}' -f $reader.ReadUInt16())
    } finally { $stream.Dispose() }
  }
  $expectedMachine = if ($ExpectedArchitecture -eq 'x64') { '8664' } else { 'AA64' }
  foreach ($name in @('native-host\streamfirefly-native.exe', 'native-host\ffmpeg.exe')) {
    $machine = Get-PeMachine (Join-Path $root $name)
    if ($machine -ne $expectedMachine) { throw "$name has PE machine $machine, expected $expectedMachine" }
  }
  $nestedZip = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $root 'StreamFirefly-extension-0.7.0.zip'))
  try {
    $nestedNames = @($nestedZip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    if ($nestedNames -notcontains 'manifest.json') { throw 'Nested extension ZIP has no root manifest.json' }
    if ($nestedNames -contains 'manifest.firefox.json' -or @($nestedNames | Where-Object { $_.StartsWith('icon-concepts/') }).Count) { throw 'Nested extension ZIP contains excluded files' }
  } finally { $nestedZip.Dispose() }
  $firefoxXpi = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $root 'StreamFirefly-firefox-0.7.0-test.xpi'))
  try {
    $firefoxNames = @($firefoxXpi.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    if ($firefoxNames -notcontains 'manifest.json') { throw 'Firefox XPI has no root manifest.json' }
    if ($firefoxNames -contains 'manifest.firefox.json' -or @($firefoxNames | Where-Object { $_.StartsWith('icon-concepts/') }).Count) { throw 'Firefox XPI contains excluded files' }
    $entry = $firefoxXpi.GetEntry('manifest.json')
    $reader = New-Object System.IO.StreamReader($entry.Open())
    try { $firefoxManifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ($firefoxManifest.browser_specific_settings.gecko.id -ne 'streamfirefly@example.invalid') { throw 'Firefox XPI extension ID is incorrect' }
  } finally { $firefoxXpi.Dispose() }
} finally {
  if (Test-Path -LiteralPath $extractBase) { Remove-Item -LiteralPath $extractBase -Recurse -Force }
}
Write-Host "Internal test bundle audit passed: $bundleName"
