param(
  [ValidatePattern('^\d+\.\d+\.\d+(-beta\.\d+)?$')]
  [string]$BundleVersion = '0.10.0-beta.1',
  [string]$OutputDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release'),
  [switch]$AllowDirtySource
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sourceCommit = (& git -C $root rev-parse HEAD).Trim()
$sourceBranch = (& git -C $root branch --show-current).Trim()
if ([string]::IsNullOrWhiteSpace($sourceBranch) -and $env:GITHUB_REF_NAME) { $sourceBranch = $env:GITHUB_REF_NAME }
$sourceStatus = @(& git -C $root status --porcelain)
$sourceDirty = $sourceStatus.Count -gt 0
if ($sourceDirty -and -not $AllowDirtySource) { throw "Internal packages require a clean source tree unless -AllowDirtySource is explicitly used: $($sourceStatus -join '; ')" }
$cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
if (-not (Test-Path -LiteralPath $cargo -PathType Leaf)) { throw 'Rust Cargo was not found' }
$rustc = Join-Path (Split-Path -Parent $cargo) 'rustc.exe'
if (-not (Test-Path -LiteralPath $rustc -PathType Leaf)) { throw 'Rust compiler was not found next to Cargo' }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js was not found' }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
& $PSScriptRoot\package-extension.ps1 -OutputDir $OutputDir
& $PSScriptRoot\package-firefox-extension.ps1 -OutputDir $OutputDir
$extensionVersion = (Get-Content -Raw -LiteralPath (Join-Path $root 'extension\manifest.json') | ConvertFrom-Json).version
$extensionZip = Join-Path $OutputDir "StreamFirefly-extension-$extensionVersion.zip"
$firefoxXpi = Join-Path $OutputDir "StreamFirefly-firefox-$extensionVersion-test.xpi"
$architectures = @{
  x64 = @{ Target = 'x86_64-pc-windows-msvc'; Machine = '8664' }
  arm64 = @{ Target = 'aarch64-pc-windows-msvc'; Machine = 'AA64' }
}
$archives = @()
foreach ($architecture in @('x64', 'arm64')) {
  $target = $architectures[$architecture].Target
  & $PSScriptRoot\download-ffmpeg.ps1 -Architecture $architecture -Destination (Join-Path $PSScriptRoot 'ffmpeg-cache')
  & $cargo build --release --target $target --manifest-path (Join-Path $root 'native-host\Cargo.toml')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $bundleName = "StreamFirefly-$BundleVersion-internal-$architecture"
  $tempBase = Join-Path ([System.IO.Path]::GetTempPath()) "streamfirefly-package-$([Guid]::NewGuid().ToString('N'))"
  $bundleRoot = Join-Path $tempBase $bundleName
  New-Item -ItemType Directory -Path $bundleRoot | Out-Null
  try {
    Expand-Archive -LiteralPath $extensionZip -DestinationPath (Join-Path $bundleRoot 'extension')
    Copy-Item -LiteralPath $extensionZip -Destination (Join-Path $bundleRoot "StreamFirefly-extension-$extensionVersion.zip")
    Copy-Item -LiteralPath $firefoxXpi -Destination (Join-Path $bundleRoot "StreamFirefly-firefox-$extensionVersion-test.xpi")
    foreach ($directory in @('native-host', 'tools', 'store-assets')) { New-Item -ItemType Directory -Path (Join-Path $bundleRoot $directory) | Out-Null }
    Copy-Item -LiteralPath (Join-Path $root "native-host\target\$target\release\streamfirefly-native.exe") -Destination (Join-Path $bundleRoot 'native-host\streamfirefly-native.exe')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "ffmpeg-cache\ffmpeg-$architecture.exe") -Destination (Join-Path $bundleRoot 'native-host\ffmpeg.exe')
    Copy-Item -LiteralPath (Join-Path $root 'extension\THIRD_PARTY_NOTICES.md'), (Join-Path $root 'installer\FFMPEG-SOURCE.txt') -Destination (Join-Path $bundleRoot 'native-host')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "ffmpeg-cache\ffmpeg-license-$architecture.txt") -Destination (Join-Path $bundleRoot 'native-host\FFMPEG-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'register-native-host.ps1'), (Join-Path $PSScriptRoot 'install-internal-test.ps1'), (Join-Path $PSScriptRoot 'uninstall-internal-test.ps1') -Destination (Join-Path $bundleRoot 'tools')
    Copy-Item -LiteralPath (Join-Path $root 'store-assets\promo-small.png'), (Join-Path $root 'store-assets\screenshot-popup.png') -Destination (Join-Path $bundleRoot 'store-assets')
    Copy-Item -LiteralPath (Join-Path $root 'README-INTERNAL.md') -Destination $bundleRoot
    $packageInfo = [ordered]@{
      product = 'StreamFirefly'
      version = $BundleVersion
      extensionVersion = $extensionVersion
      architecture = $architecture
      peMachine = $architectures[$architecture].Machine
      sourceCommit = $sourceCommit
      sourceBranch = $sourceBranch
      sourceDirty = $sourceDirty
      sourceChanges = @($sourceStatus)
      buildEnvironment = [ordered]@{
        runnerOS = $env:RUNNER_OS
        runnerArchitecture = $env:RUNNER_ARCH
        runnerImage = $env:ImageOS
        runnerImageVersion = $env:ImageVersion
        cargo = (& $cargo --version).Trim()
        rustc = (& $rustc --version).Trim()
        node = (& $node.Source --version).Trim()
        powershell = $PSVersionTable.PSVersion.ToString()
      }
      generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    $packageInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $bundleRoot 'PACKAGE-INFO.json') -Encoding UTF8
    $rootPrefix = $bundleRoot.TrimEnd('\') + '\'
    $checksums = Get-ChildItem -LiteralPath $bundleRoot -Recurse -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | Sort-Object FullName | ForEach-Object {
      $relative = $_.FullName.Substring($rootPrefix.Length).Replace('\', '/')
      "$(($_ | Get-FileHash -Algorithm SHA256).Hash.ToLowerInvariant())  $relative"
    }
    Set-Content -LiteralPath (Join-Path $bundleRoot 'SHA256SUMS.txt') -Value $checksums -Encoding ascii
    $archive = Join-Path $OutputDir "$bundleName.zip"
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($bundleRoot, $archive, [System.IO.Compression.CompressionLevel]::Optimal, $true)
    & $PSScriptRoot\audit-internal-test.ps1 -Archive $archive -ExpectedArchitecture $architecture -ExpectedBundleVersion $BundleVersion -ExpectedSourceCommit $sourceCommit -AllowDirtySource:$AllowDirtySource
    $archives += $archive
  } finally {
    if (Test-Path -LiteralPath $tempBase) { Remove-Item -LiteralPath $tempBase -Recurse -Force }
  }
}
$outerChecksums = foreach ($archive in $archives) {
  "$((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant())  $([System.IO.Path]::GetFileName($archive))"
}
Set-Content -LiteralPath (Join-Path $OutputDir 'INTERNAL-SHA256SUMS.txt') -Value $outerChecksums -Encoding ascii
Write-Host "StreamFirefly internal test bundles are ready in $OutputDir"
