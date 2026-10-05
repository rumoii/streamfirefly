# StreamFirefly 1.0.0 安装指南

下载同一 Release 的完整包，并先核对 `SHA256SUMS.txt`：

- Windows x64：`StreamFirefly-1.0.0-windows-x64.zip`
- Windows ARM64：`StreamFirefly-1.0.0-windows-arm64.zip`
- 独立 Chromium 扩展：`StreamFirefly-extension-1.0.0.zip`
- Firefox 签名扩展：`StreamFirefly-firefox-1.0.0-signed.xpi`

需要 Windows 11、自带 curl、Windows PowerShell 5.1 或 PowerShell 7，以及 Chrome/Edge 141+ 或 Firefox 142+。完整包包含本地助手和对应架构的 FFmpeg，安装时无需下载依赖。浏览器安装扩展由用户操作。

## 安装

1. 解压完整包到固定目录，保留整个目录结构。
2. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，选择包里的 `extension` 文件夹，记录各浏览器的扩展 ID。
3. Firefox 打开 `about:addons`，齿轮菜单选择“从文件安装附加组件”，选择包里的签名 XPI。正式包不提供未签名替代品。
4. 在包根目录执行下面的命令，只填写你实际使用的浏览器 ID。不使用的 Chromium 浏览器可以省略对应参数。Firefox ID 已固定。

   ```powershell
   .\tools\install.ps1 -ChromeExtensionId '<Chrome ID>' -EdgeExtensionId '<Edge ID>'
   ```

5. 重新启动浏览器，打开普通网页并点击流萤图标。在设置中确认本地助手已连接，尝试下载你有权限保存的媒体。

本地助手默认安装到 `%LOCALAPPDATA%\StreamFirefly\bin`，只注册当前用户的 Native Messaging，不需要管理员权限。不支持的架构会被拒绝。`PACKAGE-INFO.json` 记录版本、架构、构建工具和源提交；内部 `SHA256SUMS.txt` 覆盖包内文件。

## 升级和回滚

等所有任务完成，关闭浏览器，备份 `%LOCALAPPDATA%\StreamFirefly\tasks.json`、同目录的 `tasks` 文件夹、扩展导出的配置和已下载文件。保留上一版本的完整包及其固定解压路径。

升级时，安装新包的本地助手，同时加载新 Chromium 扩展或安装新签名 XPI；扩展和本地助手必须来自同一版本。失败时关闭浏览器，重新安装上一版本的助手和扩展，并恢复升级前的备份。不要混用两个版本，也不要在任务运行中覆盖程序。

未知版本或损坏的任务文件会使助手停止写入；请保留原文件排查，勿删除任务文件作为升级步骤。

## 卸载

先关闭浏览器，然后在完整包根目录执行：

```powershell
.\tools\uninstall.ps1
```

再从浏览器移除扩展。卸载删除当前用户的 Native Messaging 注册和包拥有的程序文件，保留任务记录、配置及下载内容。曾使用自定义 `-InstallDir` 时，卸载也要传入同一路径。

## 验证范围

Release 的 Windows x64 验证使用隔离环境和该 Release 的实际附件。ARM64 包构建并核验 PE 架构及文件完整性；真实 ARM64 设备、真实网站覆盖及 7200 秒持续捕捉不属于该验证，不能由构建成功推断。

项目代码采用 MIT；捆绑依赖各自的许可证见 `LICENSE`、`extension/THIRD_PARTY_NOTICES.md`、`native-host/THIRD_PARTY_NOTICES.md` 和 `native-host/FFMPEG-LICENSE.txt`。
