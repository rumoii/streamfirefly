param(
  [string]$Destination = (Join-Path $PSScriptRoot 'curl-cache')
)

# Fetches the pinned curl.exe built by the curl-for-win project. The version and
# SHA-256 hashes are fixed in tools/curl/curl-pin.json; the archive is the win64
# curl-for-win release, statically linked with TLS via LibreSSL and --ca-native
# reading the Windows certificate store, so no cacert bundle ships with it.
$ErrorActionPreference = 'Stop'
$pinPath = Join-Path $PSScriptRoot 'curl\curl-pin.json'
$pins = Get-Content -Raw -LiteralPath $pinPath | ConvertFrom-Json
$expectedExe = $pins.sha256.'curl.exe'
$expectedLicense = $pins.sha256.'CURL-LICENSE.txt'
if ($expectedExe -notmatch '^[a-f0-9]{64}$' -or $expectedLicense -notmatch '^[a-f0-9]{64}$') { throw "Invalid pinned curl hashes in $pinPath" }
$archiveUrl = $pins.archive
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$executable = Join-Path $Destination 'curl.exe'
$license = Join-Path $Destination 'CURL-LICENSE.txt'
function Test-Pinned { (Test-Path -LiteralPath $license) -and (Test-Path -LiteralPath $executable) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $executable).Hash.ToLowerInvariant() -eq $expectedExe -and (Get-FileHash -Algorithm SHA256 -LiteralPath $license).Hash.ToLowerInvariant() -eq $expectedLicense }
if (-not (Test-Pinned)) {
  $staging = Join-Path $Destination 'download'
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  New-Item -ItemType Directory -Path $staging | Out-Null
  try {
    $archive = Join-Path $staging 'curl.zip'
    & curl.exe --fail --location --retry 5 --proto '=http,https' --proto-redir '=http,https' --output $archive $archiveUrl
    if ($LASTEXITCODE -ne 0) { throw "curl download failed: $archiveUrl" }
    Expand-Archive -LiteralPath $archive -DestinationPath $staging
    Copy-Item -LiteralPath (Join-Path $staging $pins.paths.'curl.exe') -Destination $executable -Force
    Copy-Item -LiteralPath (Join-Path $staging $pins.paths.'CURL-LICENSE.txt') -Destination $license -Force
  } finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Pinned)) { Remove-Item -LiteralPath $executable -Force -ErrorAction SilentlyContinue; throw "curl SHA-256 mismatch for $($pins.version)" }
}
if (-not (Select-String -LiteralPath $license -Pattern ([regex]::Escape($pins.licenseCheck)) -Quiet)) { throw 'curl license is not the curl copyright notice' }
Write-Host "curl $($pins.version) ready (curl-for-win win64, pinned SHA-256)"
