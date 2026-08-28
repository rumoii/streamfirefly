param(
  [Parameter(Mandatory = $true)][ValidateSet('x64','arm64')][string]$Architecture,
  [string]$Destination = (Join-Path $PSScriptRoot 'ffmpeg-cache')
)

$ErrorActionPreference = 'Stop'
$release = 'autobuild-2026-08-26-13-06'
$files = @{
  x64 = @{ Name = 'ffmpeg-n8.1.2-46-g139afe709a-win64-gpl-8.1.zip'; Hash = 'f966bc2e843bcd680dedd6d1a2c0c895bab859a402c6dd107cbe72a796dfebcf' }
  arm64 = @{ Name = 'ffmpeg-n8.1.2-46-g139afe709a-winarm64-gpl-8.1.zip'; Hash = '15d246dce2a4ab9c6cf30eb280c622d10ea46836a3f561ebf25439bbc75a5829' }
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
