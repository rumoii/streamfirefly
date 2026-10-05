param(
  [Parameter(Mandatory = $true)][ValidateSet('x64','arm64')][string]$Architecture,
  [string]$Destination = (Join-Path $PSScriptRoot 'ffmpeg-cache')
)

# Fetches the minimal LGPL ffmpeg.exe built by tools/ffmpeg/build.sh from its pinned tool release.
$ErrorActionPreference = 'Stop'
$pins = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'ffmpeg\ffmpeg-lgpl.json') | ConvertFrom-Json
$expected = $pins.binaries.$Architecture
if ($expected -notmatch '^[a-f0-9]{64}$') { throw "No pinned FFmpeg hash for $Architecture in tools/ffmpeg/ffmpeg-lgpl.json" }
$release = $pins.binaries.release
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$executable = Join-Path $Destination "ffmpeg-$Architecture.exe"
$license = Join-Path $Destination "ffmpeg-license-$Architecture.txt"
function Test-Pinned { (Test-Path -LiteralPath $license) -and (Test-Path -LiteralPath $executable) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $executable).Hash.ToLowerInvariant() -eq $expected }
if (-not (Test-Pinned)) {
  $staging = Join-Path $Destination "download-$Architecture"
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  New-Item -ItemType Directory -Path $staging | Out-Null
  try {
    # The tool release is private until the repository is public; gh uses the caller's credentials.
    & gh release download $release --repo rumoii/streamfirefly --dir $staging --pattern "ffmpeg-$Architecture.exe" --pattern 'ffmpeg-license.txt'
    if ($LASTEXITCODE -ne 0) {
      foreach ($name in @("ffmpeg-$Architecture.exe", 'ffmpeg-license.txt')) {
        & curl.exe --fail --location --retry 5 --output (Join-Path $staging $name) "https://github.com/rumoii/streamfirefly/releases/download/$release/$name"
        if ($LASTEXITCODE -ne 0) { throw "FFmpeg download failed: $release/$name" }
      }
    }
    Move-Item -LiteralPath (Join-Path $staging "ffmpeg-$Architecture.exe") -Destination $executable -Force
    Move-Item -LiteralPath (Join-Path $staging 'ffmpeg-license.txt') -Destination $license -Force
  } finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Pinned)) { Remove-Item -LiteralPath $executable -Force; throw "FFmpeg SHA-256 mismatch for $Architecture" }
}
if (-not (Select-String -LiteralPath $license -Pattern 'GNU LESSER GENERAL PUBLIC LICENSE' -Quiet)) { throw 'FFmpeg license is not the LGPL text' }
Write-Host "FFmpeg $Architecture ready: $release (LGPL)"
