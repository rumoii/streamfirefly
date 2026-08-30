param(
  [string]$OutputDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release'),
  [switch]$LintOnly
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $root 'extension'
$manifestPath = Join-Path $extension 'manifest.firefox.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
[string[]]$runtimeFiles = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'extension-package-files.json') | ConvertFrom-Json
$sourceFiles = @('manifest.firefox.json') + $runtimeFiles
foreach ($relative in $sourceFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $extension $relative) -PathType Leaf)) {
    throw "Firefox package file is missing: $relative"
  }
}

& node (Join-Path $PSScriptRoot 'validate-firefox-extension.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$webExt = Join-Path $root 'node_modules\.bin\web-ext.cmd'
if (-not (Test-Path -LiteralPath $webExt -PathType Leaf)) {
  throw 'web-ext is not installed. Run npm install before Firefox validation.'
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) "streamfirefly-firefox-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stage 'manifest.json')
  foreach ($relative in $runtimeFiles) {
    $destination = Join-Path $stage $relative
    $parent = Split-Path -Parent $destination
    if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -LiteralPath (Join-Path $extension $relative) -Destination $destination
  }

  $lintText = (& $webExt lint --source-dir $stage --output=json 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Firefox lint failed:`n$lintText" }
  try { $lint = $lintText | ConvertFrom-Json }
  catch { throw "Firefox lint did not return valid JSON:`n$lintText" }
  if ($lint.summary.errors -or $lint.summary.notices -or $lint.summary.warnings) {
    throw "Firefox lint reported errors=$($lint.summary.errors), notices=$($lint.summary.notices), warnings=$($lint.summary.warnings):`n$lintText"
  }
  Write-Host 'Firefox lint passed with zero errors, notices, and warnings'
  if ($LintOnly) { return }

  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
  $output = Join-Path $OutputDir "StreamFirefly-firefox-$($manifest.version)-test.xpi"
  if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $output, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  $archive = [System.IO.Compression.ZipFile]::OpenRead($output)
  try {
    $entries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') } | ForEach-Object { $_.FullName.Replace('\', '/') } | Sort-Object)
    $expected = @(@('manifest.json') + $runtimeFiles | ForEach-Object { $_.Replace('\', '/') } | Sort-Object)
    if (($entries -join "`n") -ne ($expected -join "`n")) {
      throw "Firefox XPI content differs from the approved file list.`nActual:`n$($entries -join "`n")"
    }
  } finally { $archive.Dispose() }
  $stream = [System.IO.File]::OpenRead($output)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '') }
    finally { $sha256.Dispose() }
  } finally { $stream.Dispose() }
  Write-Host "Built $output"
  Write-Host "SHA256 $hash"
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
