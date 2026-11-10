param(
  [ValidateSet('x64','arm64')][string]$Architecture = 'x64',
  [string]$Destination = (Join-Path $PSScriptRoot 'curl-cache')
)

# Fetches the pinned curl.exe built by the curl-for-win project. Versions and
# SHA-256 hashes are fixed in tools/curl/curl-pin.json. The statically linked
# builds use LibreSSL and --ca-native reads the Windows certificate store, so no
# cacert bundle ships with them.
$ErrorActionPreference = 'Stop'
$pinPath = Join-Path $PSScriptRoot 'curl\curl-pin.json'
$pins = Get-Content -Raw -LiteralPath $pinPath | ConvertFrom-Json
$pin = $pins.architectures.$Architecture
$expectedArchive = $pin.archiveSha256
$expectedExe = $pin.sha256.'curl.exe'
$expectedLicense = $pin.sha256.'CURL-LICENSE.txt'
if ($expectedArchive -notmatch '^[a-f0-9]{64}$' -or $expectedExe -notmatch '^[a-f0-9]{64}$' -or $expectedLicense -notmatch '^[a-f0-9]{64}$') { throw "Invalid pinned curl hashes for $Architecture in $pinPath" }
$archiveUrl = $pin.archive
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$executable = Join-Path $Destination "curl-$Architecture.exe"
$license = Join-Path $Destination "CURL-LICENSE-$Architecture.txt"
function Test-Pinned { (Test-Path -LiteralPath $license) -and (Test-Path -LiteralPath $executable) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $executable).Hash.ToLowerInvariant() -eq $expectedExe -and (Get-FileHash -Algorithm SHA256 -LiteralPath $license).Hash.ToLowerInvariant() -eq $expectedLicense }
if (-not (Test-Pinned)) {
  $staging = Join-Path $Destination "download-$Architecture"
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  New-Item -ItemType Directory -Path $staging | Out-Null
  try {
    $archive = Join-Path $staging 'curl.zip'
    & curl.exe --fail --location --retry 5 --proto '=http,https' --proto-redir '=http,https' --output $archive $archiveUrl
    if ($LASTEXITCODE -ne 0) { throw "curl download failed: $archiveUrl" }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $expectedArchive) { throw "curl archive SHA-256 mismatch for $Architecture" }
    Expand-Archive -LiteralPath $archive -DestinationPath $staging
    Copy-Item -LiteralPath (Join-Path $staging $pin.paths.'curl.exe') -Destination $executable -Force
    Copy-Item -LiteralPath (Join-Path $staging $pin.paths.'CURL-LICENSE.txt') -Destination $license -Force
  } finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Pinned)) { Remove-Item -LiteralPath $executable -Force -ErrorAction SilentlyContinue; throw "curl SHA-256 mismatch for $Architecture ($($pins.version))" }
}
if (-not (Select-String -LiteralPath $license -Pattern ([regex]::Escape($pins.licenseCheck)) -Quiet)) { throw 'curl license is not the curl copyright notice' }
Write-Host "curl $($pins.version) $Architecture ready (curl-for-win, pinned SHA-256)"
