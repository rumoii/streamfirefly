param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [string]$ExtensionDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'extension')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Archive).Path)
try {
  $entries = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
  $names = @($entries | ForEach-Object { $_.FullName.Replace('\','/') })
  if ($names.Count -ne @($names | Sort-Object -Unique).Count) { throw 'Signed Firefox XPI has duplicate destinations' }
  $runtime = @(Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'extension-package-files.json') | ConvertFrom-Json)
  $expected = @('manifest.json') + $runtime
  foreach ($name in $names) {
    if ($name.StartsWith('/') -or $name -match '^[A-Za-z]:' -or $name.Split('/') -contains '..') { throw "Unsafe signed XPI entry: $name" }
    if ($expected -notcontains $name -and $name -notmatch '^META-INF/[A-Za-z0-9._-]+$') { throw "Unexpected signed XPI entry: $name" }
  }
  foreach ($name in @('META-INF/mozilla.rsa','META-INF/mozilla.sf','META-INF/manifest.mf')) {
    if ($names -notcontains $name) { throw "Mozilla signature member is missing: $name" }
  }
  foreach ($name in $expected) {
    $entry = $zip.GetEntry($name)
    if (-not $entry) { throw "Signed runtime file is missing: $name" }
    $source = if ($name -eq 'manifest.json') { Join-Path $ExtensionDir 'manifest.firefox.json' } else { Join-Path $ExtensionDir $name }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = $entry.Open()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','') } finally { $stream.Dispose(); $sha.Dispose() }
    if ($hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash) { throw "Signed runtime differs from frozen source: $name" }
  }
} finally { $zip.Dispose() }
Write-Host 'Signed Firefox runtime matches the frozen extension; Firefox installation must separately verify the signature.'
