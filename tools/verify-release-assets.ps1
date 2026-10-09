param(
  [Parameter(Mandatory=$true)][string]$Directory,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedSourceCommit,
  [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version = '1.0.7'
)
$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'ffmpeg-source.mjs') verify $Directory
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg source attachment verification failed' }
$expected=@("StreamFirefly-$Version-windows-x64.zip","StreamFirefly-$Version-windows-arm64.zip","StreamFirefly-extension-$Version.zip","StreamFirefly-firefox-$Version-signed.xpi",'StreamFirefly-install.ps1')
$expected+=@("StreamFirefly-ffmpeg-source-$Version.tar")
$actual=@(Get-ChildItem -LiteralPath $Directory -File | ForEach-Object Name | Sort-Object)
if (($actual -join '|') -ne (@($expected + 'SHA256SUMS.txt' | Sort-Object) -join '|')) { throw 'Release attachments differ from the required asset set' }
$seen=@{}
foreach($line in Get-Content -LiteralPath (Join-Path $Directory 'SHA256SUMS.txt')) {
  if($line -notmatch '^([a-f0-9]{64})  ([^/\\]+)$') { throw 'Invalid outer checksum line' }
  $hash=$Matches[1]; $name=$Matches[2]
  if($expected -notcontains $name -or $seen.ContainsKey($name)) { throw "Unexpected or duplicate checksum: $name" }
  if((Get-FileHash -LiteralPath (Join-Path $Directory $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw "Release attachment hash mismatch: $name" }
  $seen[$name]=$true
}
if($seen.Count -ne $expected.Count) { throw 'Release checksum list is incomplete' }
foreach($architecture in @('x64','arm64')) {
  $archive=Join-Path $Directory "StreamFirefly-$Version-windows-$architecture.zip"
  & $PSScriptRoot\audit-release.ps1 -Archive $archive -ExpectedArchitecture $architecture -ExpectedBundleVersion $Version -ExpectedSourceCommit $ExpectedSourceCommit
  $zip=[System.IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach($name in @("StreamFirefly-extension-$Version.zip","StreamFirefly-firefox-$Version-signed.xpi")) {
      $entry=$zip.GetEntry("StreamFirefly-$Version-windows-$architecture/$name")
      if(-not $entry) { throw "Missing embedded attachment: $name" }
      $stream=$entry.Open();$sha=[System.Security.Cryptography.SHA256]::Create()
      try { $hash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','') } finally { $stream.Dispose();$sha.Dispose() }
      if($hash -ne (Get-FileHash -LiteralPath (Join-Path $Directory $name) -Algorithm SHA256).Hash) { throw "Embedded and standalone attachments differ: $name" }
    }
  } finally { $zip.Dispose() }
}
$installer=[System.IO.File]::ReadAllText((Join-Path $Directory 'StreamFirefly-install.ps1'),[System.Text.Encoding]::UTF8)
if($installer.Contains('__STREAMFIREFLY_') -or -not $installer.Contains("`$version = '$Version'")) { throw 'Online installer version is not filled in' }
foreach($architecture in @('x64','arm64')) {
  $hash=(Get-FileHash -LiteralPath (Join-Path $Directory "StreamFirefly-$Version-windows-$architecture.zip") -Algorithm SHA256).Hash.ToLowerInvariant()
  if(-not $installer.Contains("$architecture = '$hash'")) { throw "Online installer hash does not match the $architecture bundle" }
}
Write-Host 'Release attachment identities, checksums and both architectures passed'
