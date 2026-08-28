param(
  [Parameter(Mandatory = $true)][ValidateSet('x64','arm64')][string]$Architecture,
  [string]$ChromeExtensionId = 'gimoeapmpoeogpabfdplccplmmohklff',
  [string]$EdgeExtensionId = '',
  [string]$Iscc = 'iscc.exe'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = if ($Architecture -eq 'x64') { 'x86_64-pc-windows-msvc' } else { 'aarch64-pc-windows-msvc' }
$cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
if (-not (Test-Path -LiteralPath $cargo)) { throw 'Rust Cargo was not found' }
$isccCommand = Get-Command $Iscc -ErrorAction SilentlyContinue
if (-not $isccCommand) {
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
  )
  $commonIscc = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($commonIscc) { $isccCommand = Get-Item -LiteralPath $commonIscc }
}
if (-not $isccCommand) { throw 'Inno Setup ISCC.exe was not found; install Inno Setup before packaging' }
$cache = Join-Path $PSScriptRoot 'ffmpeg-cache'
& $PSScriptRoot\download-ffmpeg.ps1 -Architecture $Architecture -Destination $cache
& $cargo build --release --target $target --manifest-path (Join-Path $root 'native-host\Cargo.toml')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$stage = Join-Path $root "installer\build\$Architecture"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $root "native-host\target\$target\release\streamfirefly-native.exe") -Destination (Join-Path $stage 'streamfirefly-native.exe')
Copy-Item -LiteralPath (Join-Path $cache "ffmpeg-$Architecture.exe") -Destination (Join-Path $stage 'ffmpeg.exe')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'register-native-host.ps1'), (Join-Path $root 'extension\THIRD_PARTY_NOTICES.md'), (Join-Path $root 'installer\FFMPEG-SOURCE.txt') -Destination $stage
Copy-Item -LiteralPath (Join-Path $cache "ffmpeg-license-$Architecture.txt") -Destination (Join-Path $stage 'FFMPEG-LICENSE.txt')
$iss = Join-Path $root 'installer\StreamFirefly.iss'
$tempIss = Join-Path $root "installer\streamfirefly-$Architecture.generated.iss"
$archAllowed = if ($Architecture -eq 'x64') { 'x64compatible' } else { 'arm64' }
$content = (Get-Content -Raw -LiteralPath $iss).Replace('#define EdgeExtensionId ""', "#define EdgeExtensionId `"$EdgeExtensionId`"").Replace('#define ARCH "x64"', "#define ARCH `"$Architecture`"").Replace('#define ARCH_ALLOWED "x64compatible"', "#define ARCH_ALLOWED `"$archAllowed`"").Replace('#define ChromeExtensionId "gimoeapmpoeogpabfdplccplmmohklff"', "#define ChromeExtensionId `"$ChromeExtensionId`"")
Set-Content -LiteralPath $tempIss -Value $content -Encoding UTF8
Push-Location (Join-Path $root 'installer'); try { & $isccCommand.FullName $tempIss } finally { Pop-Location; Remove-Item -LiteralPath $tempIss -Force -ErrorAction SilentlyContinue }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Built StreamFirefly-Setup-$Architecture.exe"
