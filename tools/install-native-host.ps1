param(
  [string]$ChromeExtensionId = '',
  [string]$FirefoxExtensionId = '',
  [string]$BuiltExe = (Join-Path $PSScriptRoot '..\native-host\target\release\streamfirefly-native.exe'),
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'StreamFirefly\bin'),
  [ValidateSet('x64','arm64')][string]$Architecture = 'x64',
  [switch]$SkipRegistration
)
$ErrorActionPreference = 'Stop'
$resolvedExe = (Resolve-Path -LiteralPath $BuiltExe).Path
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$exe = Join-Path $InstallDir 'streamfirefly-native.exe'
Copy-Item -LiteralPath $resolvedExe -Destination $exe -Force
& $PSScriptRoot\download-curl.ps1 -Architecture $Architecture -Destination (Join-Path $PSScriptRoot 'curl-cache')
& $PSScriptRoot\download-ffmpeg.ps1 -Architecture $Architecture -Destination (Join-Path $PSScriptRoot 'ffmpeg-cache')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "curl-cache\curl-$Architecture.exe") -Destination (Join-Path $InstallDir 'curl.exe') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "curl-cache\CURL-LICENSE-$Architecture.txt") -Destination (Join-Path $InstallDir 'CURL-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "ffmpeg-cache\ffmpeg-$Architecture.exe") -Destination (Join-Path $InstallDir 'ffmpeg.exe') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "ffmpeg-cache\ffmpeg-license-$Architecture.txt") -Destination (Join-Path $InstallDir 'FFMPEG-LICENSE.txt') -Force
$manifest = Join-Path $InstallDir 'com.streamfirefly.native.chromium.json'
@{ name = 'com.streamfirefly.native'; description = 'StreamFirefly native download helper'; path = $exe; type = 'stdio'; allowed_origins = @("chrome-extension://$ChromeExtensionId/") } | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding UTF8
if (-not $SkipRegistration) {
  foreach ($registryPath in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.streamfirefly.native','HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.streamfirefly.native')) {
    New-Item -Path $registryPath -Force | Out-Null
    Set-ItemProperty -Path $registryPath -Name '(default)' -Value $manifest
  }
  if ($FirefoxExtensionId) {
    $firefoxManifest = Join-Path $InstallDir 'com.streamfirefly.native.firefox.json'
    @{ name = 'com.streamfirefly.native'; description = 'StreamFirefly native download helper'; path = $exe; type = 'stdio'; allowed_extensions = @($FirefoxExtensionId) } | ConvertTo-Json | Set-Content -LiteralPath $firefoxManifest -Encoding UTF8
    $firefoxRegistry = 'HKCU:\Software\Mozilla\NativeMessagingHosts\com.streamfirefly.native'
    New-Item -Path $firefoxRegistry -Force | Out-Null
    Set-ItemProperty -Path $firefoxRegistry -Name '(default)' -Value $firefoxManifest
  }
}
Write-Host "Installed StreamFirefly native host: $exe"
