param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][ValidateSet('x64', 'arm64')][string]$ExpectedArchitecture,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+(-beta\.\d+)?$')][string]$ExpectedBundleVersion,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedSourceCommit
)
$ErrorActionPreference = 'Stop'
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
$bundleName = [System.IO.Path]::GetFileNameWithoutExtension($archivePath)
if ($bundleName -ne "StreamFirefly-$ExpectedBundleVersion-windows-$ExpectedArchitecture") { throw 'Release filename identity mismatch' }
$extensionVersion = $ExpectedBundleVersion -replace '-beta\.\d+$', ''
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
    "$bundleName/tools/install.ps1",
    "$bundleName/tools/uninstall.ps1",
    "$bundleName/tools/register-native-host.ps1",
    "$bundleName/INSTALL.md",
    "$bundleName/LICENSE",
    "$bundleName/native-host/THIRD_PARTY_NOTICES.md",
    "$bundleName/native-host/FFMPEG-SOURCE.txt",
    "$bundleName/native-host/FFMPEG-LICENSE.txt",
    "$bundleName/PACKAGE-INFO.json",
    "$bundleName/SHA256SUMS.txt",
    "$bundleName/StreamFirefly-extension-$extensionVersion.zip",
    "$bundleName/StreamFirefly-firefox-$extensionVersion-signed.xpi"
  )
  foreach ($name in $required) { if ($normalized -notcontains $name) { throw "Archive file is missing: $name" } }
  $runtime = @(Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'extension-package-files.json') | ConvertFrom-Json)
  $allowed = @($required) + @($runtime | ForEach-Object { "$bundleName/extension/$_" }) + @(
    "$bundleName/store-assets/promo-small.png", "$bundleName/store-assets/screenshot-popup.png"
  )
  foreach ($name in $normalized) { if ($allowed -notcontains $name) { throw "Unexpected release member: $name" } }
  foreach ($name in $allowed) { if ($normalized -notcontains $name) { throw "Missing release member: $name" } }
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
    if (-not $expectedFiles.Add($relative)) { throw "Duplicate checksum path: $relative" }
  }
  $actualFiles = Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object { $_.FullName.Substring($rootPrefix.Length) }
  foreach ($relative in $actualFiles) {
    if ($relative -ne 'SHA256SUMS.txt' -and -not $expectedFiles.Contains($relative)) { throw "File is absent from SHA256SUMS.txt: $relative" }
  }
  $packageInfo = Get-Content -Raw -LiteralPath (Join-Path $root 'PACKAGE-INFO.json') | ConvertFrom-Json
  if ($packageInfo.architecture -ne $ExpectedArchitecture) { throw "Package architecture metadata mismatch: $($packageInfo.architecture)" }
  if ($packageInfo.version -ne $ExpectedBundleVersion) { throw "Package version metadata mismatch: $($packageInfo.version)" }
  if ($packageInfo.sourceCommit -ne $ExpectedSourceCommit) { throw "Package source commit mismatch: $($packageInfo.sourceCommit)" }
  if (($packageInfo.sourceDirty -ne $false -or @($packageInfo.sourceChanges).Count)) { throw 'Package was built from a dirty source tree' }
  foreach ($name in @('cargo', 'rustc', 'node', 'powershell')) {
    if ([string]::IsNullOrWhiteSpace($packageInfo.buildEnvironment.$name)) { throw "Package build environment is missing: $name" }
  }
  $readme = Get-Content -Raw -LiteralPath (Join-Path $root 'INSTALL.md')
  if (-not $readme.Contains($ExpectedBundleVersion)) { throw "INSTALL.md does not mention $ExpectedBundleVersion" }
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
  if ($packageInfo.extensionVersion -ne $extensionVersion) { throw "Extension version metadata mismatch: $($packageInfo.extensionVersion)" }
  $nestedZip = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $root "StreamFirefly-extension-$extensionVersion.zip"))
  try {
    $nestedNames = @($nestedZip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    if ($nestedNames -notcontains 'manifest.json') { throw 'Nested extension ZIP has no root manifest.json' }
    $expectedNested = @(@('manifest.json') + $runtime | Sort-Object)
    if ((@($nestedNames | Sort-Object) -join '|') -ne ($expectedNested -join '|')) { throw 'Nested Chromium runtime differs from the approved member list' }
    foreach ($entry in $nestedZip.Entries) {
      $stream = $entry.Open(); $sha = [System.Security.Cryptography.SHA256]::Create()
      try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','') } finally { $stream.Dispose(); $sha.Dispose() }
      if ($hash -ne (Get-FileHash -LiteralPath (Join-Path $root "extension\$($entry.FullName)") -Algorithm SHA256).Hash) { throw "Extracted Chromium runtime differs from nested ZIP: $($entry.FullName)" }
    }
    $chromeManifest = Get-Content -Raw -LiteralPath (Join-Path $root 'extension\manifest.json') | ConvertFrom-Json
    if ($chromeManifest.version -ne $extensionVersion) { throw 'Chromium manifest version mismatch' }
    if ($nestedNames -contains 'manifest.firefox.json' -or @($nestedNames | Where-Object { $_.StartsWith('icon-concepts/') }).Count) { throw 'Nested extension ZIP contains excluded files' }
  } finally { $nestedZip.Dispose() }
  $firefoxXpi = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $root "StreamFirefly-firefox-$extensionVersion-signed.xpi"))
  try {
    $firefoxNames = @($firefoxXpi.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    foreach ($name in @('META-INF/mozilla.rsa','META-INF/mozilla.sf','META-INF/manifest.mf')) { if ($firefoxNames -notcontains $name) { throw "Mozilla signature member missing: $name" } }
    if ($firefoxNames.Count -ne @($firefoxNames | Sort-Object -Unique).Count) { throw 'Duplicate Firefox XPI entry' }
    if ($firefoxNames -notcontains 'manifest.json') { throw 'Firefox XPI has no root manifest.json' }
    if ($firefoxNames -contains 'manifest.firefox.json' -or @($firefoxNames | Where-Object { $_.StartsWith('icon-concepts/') }).Count) { throw 'Firefox XPI contains excluded files' }
    foreach ($name in $firefoxNames) {
      if (@('manifest.json') + $runtime -notcontains $name -and $name -notmatch '^META-INF/[A-Za-z0-9._-]+$') { throw "Unexpected Firefox runtime member: $name" }
    }
    foreach ($name in $runtime) {
      $runtimeEntry = $firefoxXpi.GetEntry($name)
      if (-not $runtimeEntry) { throw "Missing Firefox runtime: $name" }
      $stream = $runtimeEntry.Open(); $sha = [System.Security.Cryptography.SHA256]::Create()
      try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','') } finally { $stream.Dispose(); $sha.Dispose() }
      if ($hash -ne (Get-FileHash -LiteralPath (Join-Path $root "extension\$name") -Algorithm SHA256).Hash) { throw "Firefox and Chromium shared runtime differ: $name" }
    }
    $entry = $firefoxXpi.GetEntry('manifest.json')
    $reader = New-Object System.IO.StreamReader($entry.Open())
    try { $firefoxManifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ($firefoxManifest.version -ne $extensionVersion) { throw 'Firefox XPI version is incorrect' }
    if ($firefoxManifest.browser_specific_settings.gecko.id -ne 'streamfirefly@example.invalid') { throw 'Firefox XPI extension ID is incorrect' }
  } finally { $firefoxXpi.Dispose() }
} finally {
  if (Test-Path -LiteralPath $extractBase) { Remove-Item -LiteralPath $extractBase -Recurse -Force }
}
Write-Host "Release bundle audit passed: $bundleName"
