# StreamFirefly 0.7.0 Beta 1 内测指南

此版本仅用于受邀测试，不是 Chrome Web Store 正式发布版本。测试人员需要登录受邀的 GitHub 账号，从私有 Release 下载测试包。请勿转发安装包、Release 链接或测试数据。

StreamFirefly 不绕过 DRM。请只测试自己拥有版权或已获授权的内容。

## 一、下载测试包

1. 接受 `rumoii/streamfirefly-internal-releases` 私有仓库的协作者邀请。
2. 登录 GitHub，进入该仓库的 **Releases** 页面。
3. 打开 `StreamFirefly 0.7.0 Beta 1 内测版`，下载与当前 Windows 架构匹配的压缩包：
   - Intel 或 AMD Windows 电脑：`StreamFirefly-0.7.0-beta.1-internal-x64.zip`
   - Windows ARM 电脑：`StreamFirefly-0.7.0-beta.1-internal-arm64.zip`
4. 同时下载 `INTERNAL-SHA256SUMS.txt`，用于核对压缩包完整性。

可以在 Windows 的“设置 → 系统 → 系统信息 → 系统类型”中查看架构。大多数 Intel、AMD 电脑使用 x64；仅骁龙等 Windows ARM 设备使用 ARM64。

> 私有分发仓库只存放测试说明和 Release，不包含 StreamFirefly 源码。个人 GitHub 私有仓库的协作者具有写权限，请勿修改仓库内容、标签或 Release。

## 二、校验并解压

在下载目录打开 PowerShell，计算压缩包的 SHA-256：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\StreamFirefly-0.7.0-beta.1-internal-x64.zip'
```

ARM64 测试人员将文件名替换为 ARM64 包。输出应与 `INTERNAL-SHA256SUMS.txt` 中对应记录一致；不一致时不要继续安装，请重新下载并反馈。

为避免 Windows 保留互联网下载标记，先解除 ZIP 锁定，再完整解压：

```powershell
Unblock-File -LiteralPath '.\StreamFirefly-0.7.0-beta.1-internal-x64.zip'
Expand-Archive -LiteralPath '.\StreamFirefly-0.7.0-beta.1-internal-x64.zip' -DestinationPath '.\StreamFirefly-Test'
```

不要直接在压缩包内运行脚本，也不要单独移动 `extension`、`native-host` 或 `tools` 文件夹。

## 三、安装 Chrome 扩展和 Native Host

1. 打开 `chrome://extensions`，开启右上角的“开发者模式”。
2. 点击“加载已解压的扩展”，选择解压目录中的 `extension` 文件夹。
3. 复制 Chrome 页面显示的 32 位扩展 ID。每台电脑加载未打包扩展后显示的 ID 可能不同，必须使用当前测试电脑的实际 ID。
4. 在内测包根目录打开 PowerShell，执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\tools\install-internal-test.ps1 -ChromeExtensionId '<当前电脑的Chrome扩展ID>'
```

5. 返回 `chrome://extensions`，点击 StreamFirefly 的“重新加载”。
6. 固定 StreamFirefly 图标，打开有权下载的媒体页面开始测试。

如需同时测试 Edge，先在 `edge://extensions` 中加载同一个 `extension` 文件夹并记录 Edge 扩展 ID，然后执行：

```powershell
.\tools\install-internal-test.ps1 `
  -ChromeExtensionId '<Chrome扩展ID>' `
  -EdgeExtensionId '<Edge扩展ID>'
```

如需测试 Firefox 142 或更高版本：

1. 打开 `about:debugging#/runtime/this-firefox`，点击“临时载入附加组件”；
2. 选择包内的 `StreamFirefly-firefox-0.7.0-test.xpi`；
3. Firefox 扩展 ID 固定为 `streamfirefly@example.invalid`。如果只测试 Firefox，可直接运行以下命令注册 Native Host：

```powershell
.\tools\install-internal-test.ps1
```

4. Firefox 重启后临时扩展会自动移除，需要重新载入 XPI；测试 XPI 未经 Mozilla 签名，不能通过 `about:addons` 长期安装。

## 四、测试清单

### 1. 资源识别与预览

- 分别打开含视频和音频的网页，确认资源可以被识别；图片默认不显示，在设置中开启“识别图片”并刷新目标网页后再确认图片识别；
- 播放一次网页视频，确认普通媒体、HLS 和 DASH 资源能够在实际请求发生后出现；
- 如果页面产生大量 TS、M4S 或 KEY 请求，确认它们只出现在默认折叠的“媒体分片”区域，并按每次 100 个展开；
- 在设置中开启“高级深度搜索”并刷新目标网页，确认由 JSON、Base64、文本解码或同源 Worker 生成的媒体地址可以出现；完成后关闭该选项并刷新；
- 展开资源详情，检查类型、地址、大小、分辨率和时长等已知信息；
- 切换嗅探顺序、文件大小和类型分组，确认排序结果、分组数量和大小提示符合预期；
- 收起资源列表，确认长列表隐藏且下载任务可以直接看到；再次展开后资源仍完整；
- 有下载任务时，点击顶部“下载任务”按钮，确认任务区自动展开并滚动到可见位置；
- 检查视频封面；点击可预览资源时，确认能够播放或查看；
- 刷新、重复播放或重复请求同一资源，确认列表不会产生明显重复项。

### 2. 下载行为

- 使用默认目录下载普通视频、音频或图片，确认最终文件可正常打开；
- 修改默认保存目录后重新下载，确认文件进入所选目录；
- 下载前自定义文件名，确认非法字符提示和最终文件名符合预期；
- 连续下载同名资源，确认不会覆盖已有文件，而是自动增加序号；
- 下载较大文件，观察百分比、已下载大小、总大小、速度和状态是否持续更新；
- 测试 HLS 或 DASH 下载，确认完成后得到可播放的媒体文件，而不是残留的 `.download` 临时文件；
- 测试由 POST 或 Blob 在页面内生成的 HLS 清单，确认资源标记为“内存清单”且可以下载；旧版 Native Host 应显示升级提示；
- 对需要登录的资源，在仍保持登录的页面中发起下载，确认授权范围内的资源可以完成。

### 3. 下载任务管理

- 没有下载任务时，确认任务列表保持收起；
- 新任务开始后，确认任务列表自动显示；
- 删除已完成任务时，分别测试“仅删除记录”和“同时删除本地文件”；
- 确认删除前会再次提示，取消确认后记录和文件均不受影响；
- 删除进行中的任务，确认下载会停止，并按所选方式处理记录和本地临时文件。

### 4. 隐私与重启

- 关闭并重新打开浏览器，确认已完成任务仍可显示；
- 确认下载目录符合设置，未设置时默认目录为 `%LOCALAPPDATA%\StreamFirefly\downloads`；
- 任务记录位于 `%LOCALAPPDATA%\StreamFirefly\tasks.json`，其中不应保存 Cookie 或 Authorization；
- 不要将包含私人页面地址、文件路径或账号信息的 `tasks.json` 原文件公开上传。

## 五、常见问题

### 扩展提示 Native Host 不可用

确认安装命令使用的是当前测试电脑扩展管理页面显示的实际 ID，然后重新运行安装脚本并重新加载扩展。Chrome 和 Edge 的扩展 ID 应分别传入对应参数。

### 安装脚本提示架构不匹配

当前压缩包与 Windows 架构不一致。Intel、AMD 电脑改用 x64 包；Windows ARM 电脑改用 ARM64 包。

### 页面没有识别到媒体

安装或重新加载扩展后刷新目标网页，并实际播放一次媒体。部分资源只有在网页发起网络请求后才能识别；受 DRM 保护的内容不在支持范围内。

### Windows 阻止脚本运行

确认 ZIP 已通过 `Unblock-File` 解除锁定，并在当前 PowerShell 窗口执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

该设置仅对当前 PowerShell 进程生效，不修改系统永久执行策略。

## 六、问题反馈

每个问题尽量单独反馈，并提供以下信息：

```text
Windows 版本及系统架构：
浏览器名称及版本：
测试网页类型或脱敏后的地址：
操作步骤：
实际结果：
预期结果：
是否稳定复现：
下载资源类型和大致大小：
截图或脱敏后的错误信息：
```

请先隐藏账号、Cookie、Authorization、私人页面地址和本地用户名等敏感信息，再发送截图或错误信息。

## 七、卸载

先关闭 Chrome、Edge 和 Firefox，然后在内测包根目录执行：

```powershell
.\tools\uninstall-internal-test.ps1
```

卸载脚本只删除 Native Host、FFmpeg 和浏览器注册项，不删除任务历史与已下载文件。浏览器扩展需要在扩展管理页面中手动移除。
