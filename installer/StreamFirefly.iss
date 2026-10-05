#define AppVersion "1.0.0"
#define AppName "StreamFirefly"
#define AppPublisher "rumoii"
#define ChromeExtensionId "gimoeapmpoeogpabfdplccplmmohklff"
#define EdgeExtensionId ""
#define FirefoxExtensionId "streamfirefly@example.invalid"
#define ARCH "x64"
#define ARCH_ALLOWED "x64compatible"

[Setup]
AppId={{B9A6B82B-1E25-4A99-A55F-7A3E4B1D9C20}}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\StreamFirefly\bin
DefaultGroupName={#AppName}
OutputBaseFilename=StreamFirefly-Setup-{#ARCH}
OutputDir=output
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
UninstallDisplayName={#AppName} Native Host
Uninstallable=yes
ArchitecturesAllowed={#ARCH_ALLOWED}

[Files]
Source: "build\{#ARCH}\streamfirefly-native.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\{#ARCH}\ffmpeg.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\{#ARCH}\register-native-host.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\{#ARCH}\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\{#ARCH}\FFMPEG-SOURCE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\{#ARCH}\FFMPEG-LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\register-native-host.ps1"" -ChromeExtensionId ""{#ChromeExtensionId}"" -EdgeExtensionId ""{#EdgeExtensionId}"" -FirefoxExtensionId ""{#FirefoxExtensionId}"" -NativeHostPath ""{app}\streamfirefly-native.exe"" -InstallDir ""{app}"""; StatusMsg: "正在注册浏览器本地助手…"; Flags: runhidden waituntilterminated

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.streamfirefly.native"; ValueType: none; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\com.streamfirefly.native"; ValueType: none; Flags: uninsdeletekey; Check: EdgeExtensionConfigured
Root: HKCU; Subkey: "Software\Mozilla\NativeMessagingHosts\com.streamfirefly.native"; ValueType: none; Flags: uninsdeletekey

[Code]
function EdgeExtensionConfigured(): Boolean;
begin
  Result := '{#EdgeExtensionId}' <> '';
end;

[UninstallDelete]
Type: files; Name: "{app}\streamfirefly-native.exe"
Type: files; Name: "{app}\ffmpeg.exe"
Type: files; Name: "{app}\com.streamfirefly.native*.json"
Type: files; Name: "{app}\register-native-host.ps1"
Type: files; Name: "{app}\THIRD_PARTY_NOTICES.md"
Type: files; Name: "{app}\FFMPEG-SOURCE.txt"
Type: files; Name: "{app}\FFMPEG-LICENSE.txt"
