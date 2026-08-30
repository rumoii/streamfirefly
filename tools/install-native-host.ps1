param(
  [string]$ChromeExtensionId = '',
  [string]$FirefoxExtensionId = '',
  [string]$BuiltExe = (Join-Path $PSScriptRoot '..\native-host\target\release\streamfirefly-native.exe'),
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'StreamFirefly\bin')
)
$ErrorActionPreference = 'Stop'
$resolvedExe = (Resolve-Path -LiteralPath $BuiltExe).Path
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$exe = Join-Path $InstallDir 'streamfirefly-native.exe'
Copy-Item -LiteralPath $resolvedExe -Destination $exe -Force
$manifest = Join-Path $InstallDir 'com.streamfirefly.native.chromium.json'
@{ name = 'com.streamfirefly.native'; description = 'StreamFirefly native download helper'; path = $exe; type = 'stdio'; allowed_origins = @("chrome-extension://$ChromeExtensionId/") } | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding UTF8
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
Write-Host "Installed StreamFirefly native host: $exe"
