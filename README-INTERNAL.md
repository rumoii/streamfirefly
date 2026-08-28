# StreamFirefly 0.6.0 内测说明

此压缩包仅用于受邀测试，不是 Chrome Web Store 正式发布包。请根据 Windows 架构选择 `x64` 或 `arm64` 压缩包，并完整解压后操作。

## 安装

1. 打开 `chrome://extensions`，开启“开发者模式”。
2. 点击“加载已解压的扩展”，选择压缩包中的 `extension` 文件夹。
3. 复制 Chrome 显示的 32 位扩展 ID。
4. 在压缩包根目录打开 PowerShell，运行：

```powershell
.\tools\install-internal-test.ps1 -ChromeExtensionId '<B电脑实际扩展ID>'
```

5. 回到 `chrome://extensions`，点击 StreamFirefly 的“重新加载”。
6. 打开有权下载的媒体页面进行测试。

如需同时测试 Edge，先在 Edge 中加载同一个 `extension` 文件夹并记录 Edge 扩展 ID，然后运行：

```powershell
.\tools\install-internal-test.ps1 `
  -ChromeExtensionId '<Chrome扩展ID>' `
  -EdgeExtensionId '<Edge扩展ID>'
```

## 建议测试内容

- 视频、音频、图片、HLS 和 DASH 资源识别；
- 封面预览、详情展开和点击播放；
- 自定义保存路径、文件名和下载并发；
- 下载进度、速度和完成后的媒体文件；
- 同名文件自动编号；
- 删除记录、删除记录和本地文件，以及二次确认；
- 需要登录的资源可以在当前会话下载，`tasks.json` 中不出现 Cookie 或 Authorization。

任务记录位于 `%LOCALAPPDATA%\StreamFirefly\tasks.json`。下载目录由扩展设置决定，未设置时使用 `%LOCALAPPDATA%\StreamFirefly\downloads`。

## 卸载

先关闭 Chrome 和 Edge，然后运行：

```powershell
.\tools\uninstall-internal-test.ps1
```

卸载脚本只删除 Native Host、FFmpeg 和浏览器注册项，不删除任务历史与已下载文件。扩展需要在浏览器扩展管理页面中手动移除。

## 完整性校验

压缩包内的 `SHA256SUMS.txt` 用于验证解压后的所有文件。压缩包外部哈希记录在同目录的 `INTERNAL-SHA256SUMS.txt`。

当前内测包不绕过 DRM，请仅测试自己拥有版权或已获授权的内容。
