# Test-only full FFmpeg (lavfi, libx264, ffprobe) for generating and inspecting fixtures. Never packaged.
param(
  [string]$Destination = (Join-Path $PSScriptRoot 'ffmpeg-cache')
)
$Architecture = 'x64'

$ErrorActionPreference = 'Stop'
$release = 'autobuild-2026-10-01-13-06'
$files = @{
  x64 = @{ Name = 'ffmpeg-n8.1.3-14-g330caae0c1-win64-gpl-8.1.zip'; Hash = '6aca87b75999c4793871754c5c2e211129a56a160c1654a7d1c9c518a7eda9c0' }
  arm64 = @{ Name = 'ffmpeg-n8.1.3-14-g330caae0c1-winarm64-gpl-8.1.zip'; Hash = '3dd51c0c37f8f6d6c6779da0af4b370589728abdcb16559bd9aa8318a187764e' }
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
$extract = Join-Path $Destination 'fixture-x64-extracted'
if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
Expand-Archive -LiteralPath $archive -DestinationPath $extract
$fixture = Join-Path $Destination 'fixture-x64'
New-Item -ItemType Directory -Force -Path $fixture | Out-Null
foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
  $tool = Get-ChildItem -LiteralPath $extract -Recurse -File -Filter $name | Select-Object -First 1
  if (-not $tool) { throw "$name was not found in the verified archive" }
  Copy-Item -LiteralPath $tool.FullName -Destination (Join-Path $fixture $name) -Force
}
Remove-Item -LiteralPath $extract -Recurse -Force
"STREAMFIREFLY_FIXTURE_FFMPEG_EXE=$(Join-Path $fixture 'ffmpeg.exe')"
"STREAMFIREFLY_FFPROBE_EXE=$(Join-Path $fixture 'ffprobe.exe')"
