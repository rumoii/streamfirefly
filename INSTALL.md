# StreamFirefly 1.0.2 安装指南

需要 Windows 11、自带 curl、Windows PowerShell 5.1 或 PowerShell 7，以及 Chrome/Edge 141+ 或 Firefox 142+。

流萤有两个发行版：Chrome 应用商店版不识别和下载 YouTube 内容；通用版不限制网站，通过 GitHub Release 分发。两者共用同一个本地助手，同一浏览器里只装其中一个。

## 一键安装（推荐）

1. 安装扩展：
   - Chrome：从 Chrome 应用商店安装流萤（商店版）。
   - Chrome/Edge 通用版：从 [Releases](https://github.com/rumoii/streamfirefly/releases/latest) 下载 `StreamFirefly-extension-<版本>.zip` 并解压到固定目录；打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，选择解压后的目录。
   - Firefox：从 Releases 下载 `StreamFirefly-firefox-<版本>-signed.xpi`，在 `about:addons` 的齿轮菜单中选择“从文件安装附加组件”。
2. 安装后会自动打开流萤设置页；也可以随时从设置页或侧栏的提示进入。点击“复制安装命令”。
3. 按 <kbd>Win</kbd> + <kbd>R</kbd> 打开“运行”窗口，按 <kbd>Ctrl</kbd> + <kbd>V</kbd> 粘贴，再按回车。

命令会从同一版本的 Release 下载 `StreamFirefly-install.ps1` 和对应架构的完整包，按脚本内记录的 SHA-256 校验后安装，并只为当前浏览器注册本地助手；完整包保留在 `%LOCALAPPDATA%\StreamFirefly\package\<版本>`。安装完成后回到浏览器，流萤会自动连接。在另一个浏览器里使用流萤时，从那个浏览器再复制一次命令即可。

## 手动安装完整包

从 [Releases](https://github.com/rumoii/streamfirefly/releases/latest) 下载完整包，并先核对同一 Release 的 `SHA256SUMS.txt`：

- Windows x64：`StreamFirefly-<版本>-windows-x64.zip`
- Windows ARM64：`StreamFirefly-<版本>-windows-arm64.zip`
- 通用版 Chromium 扩展：`StreamFirefly-extension-<版本>.zip`
- Firefox 签名扩展：`StreamFirefly-firefox-<版本>-signed.xpi`

完整包包含本地助手和对应架构的 FFmpeg，安装时无需下载依赖。

1. 解压完整包到固定目录，保留整个目录结构。
2. 按上一节第 1 步安装扩展；包里的 `extension` 文件夹和签名 XPI 都是通用版。记录 Chrome/Edge 扩展管理页显示的扩展 ID。Chrome 应用商店版的扩展 ID 固定为 `ooblmahffkiimlflhdnfojjemlibmhhj`。
3. 在包根目录安装本地助手。通过 Chrome 应用商店安装流萤时运行：

   ```powershell
   .\tools\install.ps1 -ChromeExtensionId 'ooblmahffkiimlflhdnfojjemlibmhhj'
   ```

   开发者模式加载或同时使用 Edge 时，填写各浏览器实际显示的扩展 ID。不使用的 Chromium 浏览器可以省略对应参数。Firefox ID 已固定。

   ```powershell
   .\tools\install.ps1 -ChromeExtensionId '<Chrome ID>' -EdgeExtensionId '<Edge ID>'
   ```

4. 重新启动浏览器，打开普通网页并点击流萤图标。在设置中确认本地助手已连接，尝试下载你有权限保存的媒体。

本地助手默认安装到 `%LOCALAPPDATA%\StreamFirefly\bin`，只注册当前用户的 Native Messaging，不需要管理员权限。不支持的架构会被拒绝。`PACKAGE-INFO.json` 记录版本、架构、构建工具和源提交；内部 `SHA256SUMS.txt` 覆盖包内文件。

## 升级和回滚

等所有任务完成，关闭浏览器，备份 `%LOCALAPPDATA%\StreamFirefly\tasks.json`、同目录的 `tasks` 文件夹、扩展导出的配置和已下载文件。保留上一版本的完整包及其固定解压路径。

升级时，安装新包的本地助手，同时加载新 Chromium 扩展或安装新签名 XPI；扩展和本地助手必须来自同一版本。失败时关闭浏览器，重新安装上一版本的助手和扩展，并恢复升级前的备份。不要混用两个版本，也不要在任务运行中覆盖程序。

未知版本或损坏的任务文件会使助手停止写入；请保留原文件排查，勿删除任务文件作为升级步骤。

## 卸载

先关闭浏览器，然后在完整包根目录执行（一键安装的完整包位于 `%LOCALAPPDATA%\StreamFirefly\package\<版本>`）：

```powershell
.\tools\uninstall.ps1
```

再从浏览器移除扩展。卸载删除当前用户的 Native Messaging 注册和包拥有的程序文件，保留任务记录、配置及下载内容。曾使用自定义 `-InstallDir` 时，卸载也要传入同一路径。

## 验证范围

Release 的 Windows x64 验证使用隔离环境和该 Release 的实际附件。ARM64 包构建并核验 PE 架构及文件完整性；真实 ARM64 设备、真实网站覆盖及 7200 秒持续捕捉不属于该验证，不能由构建成功推断。

项目代码采用 MIT；捆绑依赖各自的许可证见 `LICENSE`、`extension/THIRD_PARTY_NOTICES.md`、`native-host/THIRD_PARTY_NOTICES.md` 和 `native-host/FFMPEG-LICENSE.txt`。

FFmpeg 对应源码、依赖与构建说明在同一 Release 的源码分片中提供，下载和校验方法见包内 `native-host/FFMPEG-SOURCE.txt`。日常安装使用 Windows 完整包。
