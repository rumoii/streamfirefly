# Online installer template. tools/package-release.ps1 fills in the version and bundle hashes and publishes it as StreamFirefly-install.ps1.
param(
  [Parameter(Position=0)][ValidateSet('chrome','edge','firefox')][string]$Browser = 'chrome',
  [Parameter(Position=1)][string]$ExtensionId = '',
  [string]$PackagePath = '',
  [string]$InstallDir = '',
  [switch]$NoPause
)
$ErrorActionPreference = 'Stop'
$version = '__STREAMFIREFLY_VERSION__'
$bundleHashes = @{ x64 = '__STREAMFIREFLY_SHA256_X64__'; arm64 = '__STREAMFIREFLY_SHA256_ARM64__' }
$exitCode = 0
# curl.exe reads proxy environment variables but not the Windows system proxy, so pass that proxy explicitly.
function Get-CurlProxyArguments([string]$Url) {
  if ($env:HTTPS_PROXY -or $env:https_proxy -or $env:ALL_PROXY -or $env:all_proxy) { return @() }
  try {
    $target = [uri]$Url
    $proxy = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy($target)
    if ($proxy -and $proxy.AbsoluteUri -ne $target.AbsoluteUri) {
      Write-Host "使用系统代理：$($proxy.Authority)"
      return @('--proxy', $proxy.AbsoluteUri)
    }
  } catch {}
  return @()
}
function Save-Download([string]$Url, [string]$Path) {
  $proxyArguments = @(Get-CurlProxyArguments $Url)
  & curl.exe -fL --retry 3 @proxyArguments -o $Path $Url
  if ($LASTEXITCODE -eq 0) { return }
  # Invoke-WebRequest also honours PAC scripts and proxies that need Windows sign-in.
  Write-Host 'curl 下载失败，改用 PowerShell 重试...'
  $previousProgress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try { Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing -UseDefaultCredentials }
  catch { throw '下载失败：连不上 GitHub。请确认代理已开启（系统代理或 TUN 模式均可），然后重新运行同一命令（命令仍在剪贴板中）。' }
  finally { $ProgressPreference = $previousProgress }
}
try {
  if ($Browser -ne 'firefox' -and $ExtensionId -notmatch '^[a-p]{32}$') { throw '扩展 ID 无效，请回到流萤重新复制安装命令。' }
  $osArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $architecture = switch ($osArchitecture) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { throw "不支持的 Windows 架构：$osArchitecture" } }
  $bundleName = "StreamFirefly-$version-windows-$architecture"
  $archive = $PackagePath
  if (-not $archive) {
    $archive = Join-Path $env:TEMP "$bundleName.zip"
    Write-Host "正在下载流萤本地助手 $version（$architecture）..."
    Save-Download "https://github.com/rumoii/streamfirefly/releases/download/v$version/$bundleName.zip" $archive
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $bundleHashes[$architecture]) { throw '安装包校验失败，文件不完整或已被修改，请重新运行同一命令。' }
  Write-Host '校验通过，正在安装...'
  $packageRoot = Join-Path $env:LOCALAPPDATA 'StreamFirefly\package'
  $packageDir = Join-Path $packageRoot $version
  $staging = Join-Path $packageRoot "$version.partial"
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  Expand-Archive -LiteralPath $archive -DestinationPath $staging
  if (Test-Path -LiteralPath $packageDir) { Remove-Item -LiteralPath $packageDir -Recurse -Force }
  Move-Item -LiteralPath (Join-Path $staging $bundleName) -Destination $packageDir
  Remove-Item -LiteralPath $staging -Recurse -Force
  $installArguments = @{}
  if ($Browser -eq 'chrome') { $installArguments.ChromeExtensionId = $ExtensionId }
  if ($Browser -eq 'edge') { $installArguments.EdgeExtensionId = $ExtensionId }
  if ($InstallDir) { $installArguments.InstallDir = $InstallDir }
  & (Join-Path $packageDir 'tools\install.ps1') @installArguments
  if (-not $PackagePath) { Remove-Item -LiteralPath $archive -Force }
  Write-Host ''
  Write-Host '安装完成。回到浏览器，流萤会自动连接本地助手。' -ForegroundColor Green
  Write-Host "卸载时运行：$packageDir\tools\uninstall.ps1"
} catch {
  $exitCode = 1
  $message = $_.Exception.Message
  if ($message -like 'Unable to update StreamFirefly files*') { $message = '本地助手正在使用中。请关闭所有浏览器窗口后，重新运行同一命令（命令仍在剪贴板中）。' }
  Write-Host ''
  Write-Host "安装失败：$message" -ForegroundColor Red
}
if (-not $NoPause) { [void](Read-Host '按回车键关闭此窗口') }
exit $exitCode
