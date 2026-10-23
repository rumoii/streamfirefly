# Test-only full FFmpeg (lavfi, libx264, ffprobe) for generating and inspecting fixtures. Never packaged.
param(
  [string]$Destination = (Join-Path $PSScriptRoot 'ffmpeg-cache')
)
$Architecture = 'x64'

$ErrorActionPreference = 'Stop'
# BtbN prunes daily builds after about two weeks but keeps each month-end build, so pin a month-end one.
$release = 'autobuild-2026-09-30-13-08'
$files = @{
  x64 = @{ Name = 'ffmpeg-n8.1.3-9-g29e619e767-win64-gpl-8.1.zip'; Hash = '7b801cdd3a1a0bb54ae6f572187e68b4ed54f52086cfee133fab2180bfb429fa' }
  arm64 = @{ Name = 'ffmpeg-n8.1.3-9-g29e619e767-winarm64-gpl-8.1.zip'; Hash = '061a770557c30bbf8e0b6ca3810288a60f72b85088378b84be03277746f34f17' }
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
