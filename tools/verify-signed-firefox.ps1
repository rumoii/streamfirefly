param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [string]$ExtensionDir = ''
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ExtensionDir)) { $ExtensionDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'extension' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Test-ManifestValue($Actual, $Expected) {
  if ($null -eq $Actual -or $null -eq $Expected) { return ($null -eq $Actual -and $null -eq $Expected) }
  if ($Actual -is [pscustomobject] -or $Expected -is [pscustomobject]) {
    if ($Actual -isnot [pscustomobject] -or $Expected -isnot [pscustomobject]) { return $false }
    $actualProperties = @($Actual.PSObject.Properties)
    $expectedProperties = @($Expected.PSObject.Properties)
    if ($actualProperties.Count -ne $expectedProperties.Count) { return $false }
    foreach ($property in $expectedProperties) {
      $matched = @($actualProperties | Where-Object { $_.Name -ceq $property.Name })
      if ($matched.Count -ne 1 -or -not (Test-ManifestValue $matched[0].Value $property.Value)) { return $false }
    }
    return $true
  }
  if ($Actual -is [array] -or $Expected -is [array]) {
    if ($Actual -isnot [array] -or $Expected -isnot [array] -or $Actual.Count -ne $Expected.Count) { return $false }
    for ($index = 0; $index -lt $Actual.Count; $index++) {
      if (-not (Test-ManifestValue $Actual[$index] $Expected[$index])) { return $false }
    }
    return $true
  }
  if (($Actual -is [string]) -ne ($Expected -is [string]) -or ($Actual -is [bool]) -ne ($Expected -is [bool])) { return $false }
  return ($Actual -ceq $Expected)
}
$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Archive).Path)
try {
  $entries = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
  $names = @($entries | ForEach-Object { $_.FullName.Replace('\','/') })
  if ($names.Count -ne @($names | Sort-Object -Unique).Count) { throw 'Signed Firefox XPI has duplicate destinations' }
  [string[]]$runtime = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'extension-package-files.json') | ConvertFrom-Json
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
    if ($name -eq 'manifest.json') {
      $reader = [System.IO.StreamReader]::new($entry.Open())
      try { $actualManifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
      $expectedManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $source | ConvertFrom-Json
      if (-not (Test-ManifestValue $actualManifest $expectedManifest)) { throw 'Signed runtime differs from frozen source: manifest.json' }
      continue
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = $entry.Open()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','') } finally { $stream.Dispose(); $sha.Dispose() }
    if ($hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash) { throw "Signed runtime differs from frozen source: $name" }
  }
} finally { $zip.Dispose() }
Write-Host 'Signed Firefox runtime matches the frozen extension; Firefox installation must separately verify the signature.'
