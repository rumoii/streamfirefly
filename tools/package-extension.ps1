param(
  [Parameter(Mandatory=$true)][ValidateSet('general','chrome-store')][string]$Edition,
  [string]$OutputDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release')
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $root 'extension'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $extension 'manifest.json') | ConvertFrom-Json
$previousEdition = $env:STREAMFIREFLY_EDITION
$env:STREAMFIREFLY_EDITION = $Edition
try { & npm --prefix $root run build:extension } finally { $env:STREAMFIREFLY_EDITION = $previousEdition }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$builtEdition = [regex]::Match((Get-Content -Raw -LiteralPath (Join-Path $extension 'dist\background.js')), 'EDITION = (?:true \? )?"([a-z-]+)"').Groups[1].Value
if ($builtEdition -ne $Edition) { throw "Built extension edition '$builtEdition' does not match '$Edition'" }
[string[]]$runtimeFiles = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'extension-package-files.json') | ConvertFrom-Json
$files = @('manifest.json') + $runtimeFiles
foreach ($relative in $files) {
  if (-not (Test-Path -LiteralPath (Join-Path $extension $relative) -PathType Leaf)) {
    throw "Extension package file is missing: $relative"
  }
}
& node (Join-Path $PSScriptRoot 'validate-extension.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$output = Join-Path $OutputDir $(if ($Edition -eq 'chrome-store') { "StreamFirefly-chrome-store-$($manifest.version).zip" } else { "StreamFirefly-extension-$($manifest.version).zip" })
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "streamfirefly-extension-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  foreach ($relative in $files) {
    $destination = Join-Path $stage $relative
    $parent = Split-Path -Parent $destination
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    Copy-Item -LiteralPath (Join-Path $extension $relative) -Destination $destination
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stage,
    $output,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
  $archive = [System.IO.Compression.ZipFile]::OpenRead($output)
  try {
    $entries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') } | ForEach-Object { $_.FullName.Replace('\', '/') } | Sort-Object)
    $expected = @($files | ForEach-Object { $_.Replace('\', '/') } | Sort-Object)
    if (($entries -join "`n") -ne ($expected -join "`n")) {
      throw "Extension archive content differs from the approved file list.`nActual:`n$($entries -join "`n")"
    }
  } finally {
    $archive.Dispose()
  }
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash
Write-Host "Built $output"
Write-Host "SHA256 $hash"
