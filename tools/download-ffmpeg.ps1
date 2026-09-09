param(
  [Parameter(Mandatory = $true)][ValidateSet('x64','arm64')][string]$Architecture,
  [string]$Destination = (Join-Path $PSScriptRoot 'ffmpeg-cache')
)

$ErrorActionPreference = 'Stop'
$release = 'autobuild-2026-09-08-23-15'
$files = @{
  x64 = @{ Name = 'ffmpeg-n8.1.2-51-g7ba069f4f1-win64-gpl-8.1.zip'; Hash = '508400eb2ecfab27e2f0383817b54e2bf1946940a8aeda6fe3df9438ff511bf1' }
  arm64 = @{ Name = 'ffmpeg-n8.1.2-51-g7ba069f4f1-winarm64-gpl-8.1.zip'; Hash = '4f33057d8dbd69e1b688fcc4137406e22388f76561eeb0628a8c5551c0edc11d' }
}
$item = $files[$Architecture]
$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$release/$($item.Name)"
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$archive = Join-Path $Destination $item.Name
if (Test-Path -LiteralPath $archive) {
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $item.Hash) { Remove-Item -LiteralPath $archive -Force }
}
if (-not (Test-Path -LiteralPath $archive)) {
  & curl.exe --fail --location --retry 5 --retry-all-errors --continue-at - --output $archive $url
  if ($LASTEXITCODE -ne 0) { throw "FFmpeg download failed: $url" }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $item.Hash) {
  Remove-Item -LiteralPath $archive -Force
  throw "FFmpeg archive SHA-256 mismatch: $archive"
}
$extract = Join-Path $Destination "$Architecture-extracted"
if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
Expand-Archive -LiteralPath $archive -DestinationPath $extract
$ffmpeg = Get-ChildItem -LiteralPath $extract -Recurse -File -Filter ffmpeg.exe | Select-Object -First 1
if (-not $ffmpeg) { throw 'ffmpeg.exe was not found in the verified archive' }
Copy-Item -LiteralPath $ffmpeg.FullName -Destination (Join-Path $Destination "ffmpeg-$Architecture.exe") -Force
$license = Get-ChildItem -LiteralPath $extract -Recurse -File -Filter LICENSE.txt | Select-Object -First 1
if (-not $license) { throw 'LICENSE.txt was not found in the verified FFmpeg archive' }
Copy-Item -LiteralPath $license.FullName -Destination (Join-Path $Destination "ffmpeg-license-$Architecture.txt") -Force
Write-Host "FFmpeg $Architecture ready: $($item.Name)"
