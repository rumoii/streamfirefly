param(
  [Parameter(Mandatory = $true)][string]$ChromeExtensionId,
  [string]$EdgeExtensionId = '',
  [string]$FirefoxExtensionId = '',
  [string]$NativeHostPath = (Join-Path $PSScriptRoot 'streamfirefly-native.exe'),
  [string]$InstallDir = (Split-Path -Parent $NativeHostPath)
)
$ErrorActionPreference = 'Stop'
$resolvedExe = (Resolve-Path -LiteralPath $NativeHostPath).Path
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
function Register-Chromium($browserPath, $id) {
  if ([string]::IsNullOrWhiteSpace($id)) { return }
  $manifest = Join-Path $InstallDir "com.streamfirefly.native.$($browserPath -replace '[^a-z]','').json"
  @{ name = 'com.streamfirefly.native'; description = 'StreamFirefly native download helper'; path = $resolvedExe; type = 'stdio'; allowed_origins = @("chrome-extension://$id/") } | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding UTF8
  $registryPath = "HKCU:\Software\$browserPath\NativeMessagingHosts\com.streamfirefly.native"
  New-Item -Path $registryPath -Force | Out-Null
  Set-ItemProperty -Path $registryPath -Name '(default)' -Value $manifest
}
Register-Chromium 'Google\Chrome' $ChromeExtensionId
Register-Chromium 'Microsoft\Edge' $EdgeExtensionId
if ($FirefoxExtensionId) {
  $manifest = Join-Path $InstallDir 'com.streamfirefly.native.firefox.json'
  @{ name = 'com.streamfirefly.native'; description = 'StreamFirefly native download helper'; path = $resolvedExe; type = 'stdio'; allowed_extensions = @($FirefoxExtensionId) } | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding UTF8
  $registryPath = 'HKCU:\Software\Mozilla\NativeMessagingHosts\com.streamfirefly.native'
  New-Item -Path $registryPath -Force | Out-Null
  Set-ItemProperty -Path $registryPath -Name '(default)' -Value $manifest
}
Write-Host "StreamFirefly Native Host registered: $resolvedExe"
