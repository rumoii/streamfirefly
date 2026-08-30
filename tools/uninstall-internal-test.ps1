param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'StreamFirefly\bin')
)
$ErrorActionPreference = 'Stop'
foreach ($registryPath in @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.streamfirefly.native',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.streamfirefly.native',
  'HKCU:\Software\Mozilla\NativeMessagingHosts\com.streamfirefly.native'
)) {
  if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath -Force }
}
$ownedFiles = @(
  'streamfirefly-native.exe',
  'ffmpeg.exe',
  'register-native-host.ps1',
  'THIRD_PARTY_NOTICES.md',
  'FFMPEG-SOURCE.txt',
  'FFMPEG-LICENSE.txt',
  'com.streamfirefly.native.googlechrome.json',
  'com.streamfirefly.native.microsoftedge.json',
  'com.streamfirefly.native.firefox.json'
)
foreach ($name in $ownedFiles) {
  $path = Join-Path $InstallDir $name
  if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
}
if ((Test-Path -LiteralPath $InstallDir -PathType Container) -and -not (Get-ChildItem -LiteralPath $InstallDir -Force | Select-Object -First 1)) {
  Remove-Item -LiteralPath $InstallDir -Force
}
Write-Host 'StreamFirefly internal test host was removed.'
Write-Host 'Task history and downloaded files under %LOCALAPPDATA%\StreamFirefly were preserved.'
