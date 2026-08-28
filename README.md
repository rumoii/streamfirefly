# 流萤 StreamFirefly

流萤是一个本地优先的网页媒体发现与下载工具：浏览器扩展发现资源，Rust 本地助手负责持久化下载任务。

## 当前状态

当前版本已实现：

- Chrome/Edge Manifest V3 扩展；
- 页面资源候选发现（请求 URL、响应 MIME、媒体元素）；
- 普通 HTTP 下载任务创建；
- Native Messaging 协议与 Rust 助手任务状态机；
- Rust 助手通过系统 `curl` 执行下载，并持久化任务清单；
- 设置页配置并验证默认保存目录；
- 真实下载字节、总大小、速度、预计剩余时间和阶段进度；
- 资源卡片展开查看分辨率、时长、封面、来源页面等信息；
- 资源卡片优先显示网页海报或视频首帧，点击后可在卡片内预览普通媒体和 HLS/M3U8；
- 资源 URL 去重及下载按钮防双击，同时保留用户主动重复下载能力；
- 下载前可自定义文件主名称，扩展名自动识别，同名文件自动添加序号；
- 下载任务支持仅删除记录或同时删除本地文件，两种方式都需要最终确认，进行中任务会先安全取消下载；
- 普通 HTTP 资源支持 1–16 路 Range 并发下载，默认 6 路；服务端不支持分段时自动回退单连接；
- HLS/DASH 通过内置 FFmpeg 的持久连接和多连接模式下载并无转码合并，支持标准 AES-128 HLS，拒绝绕过 DRM；
- HLS/DASH 资源可被识别；安装包提供 FFmpeg，助手使用无转码合并链路处理清单；便携测试模式未安装 FFmpeg 时会保留明确的进程启动失败原因。

## 目录

- `extension/`：浏览器扩展；
- `native-host/`：Rust Native Messaging 助手；
- `tools/`：校验和 Windows 安装辅助脚本。

## 界面基线

扩展弹窗采用统一的按钮、卡片、标签、空状态和进度视觉约定：浅色信息层级、紧凑圆角卡片、明确的主次操作和可读的状态提示。由于浏览器扩展当前是原生 HTML/JS，不直接引入 Vue 运行时；后续若建设独立任务中心页面，再按同一视觉规范实现。

## 开发验证

扩展静态检查：

```powershell
node tools/validate-extension.mjs
```

Rust 助手需要 Rust 工具链：

```powershell
cargo test --manifest-path native-host/Cargo.toml
cargo build --release --manifest-path native-host/Cargo.toml
```

构建后，以浏览器扩展 ID 注册本地助手：

```powershell
.\tools\install-native-host.ps1 -ChromeExtensionId '<扩展ID>'
```

每次重新编译 Native Host 后，需要再次运行安装脚本，覆盖浏览器实际调用的本地助手程序。扩展更新后在 `chrome://extensions` 中点击“重新加载”。

生成 Chrome Web Store 上传包：

```powershell
.\tools\package-extension.ps1
```

上传包只包含 Chrome 扩展运行所需的白名单文件，不包含 Firefox Manifest、图标设计稿或本地状态。

## Windows 安装包

正式交付由浏览器商店扩展和 Windows Native Host 安装包组成。安装包包含 Native Host 与固定版本的 GPL FFmpeg，并分别生成 x64、ARM64 版本：

```powershell
.\tools\build-installer.ps1 -Architecture x64
.\tools\build-installer.ps1 -Architecture arm64
```

构建机需要 Rust 对应目标工具链和 Inno Setup 6。FFmpeg 二进制在构建阶段按固定 URL 与 SHA-256 下载，不提交到 Git；安装过程本身不访问网络。本地开发扩展 ID 为 `gimoeapmpoeogpabfdplccplmmohklff`，Chrome Web Store 正式 ID 取得后通过 `-ChromeExtensionId` 传入；Edge 商店 ID 通过 `-EdgeExtensionId` 传入。

Chrome Web Store 创建条目并取得正式扩展 ID 后，使用该 ID 一次性生成扩展 ZIP、两个架构的安装包和校验文件：

```powershell
.\tools\prepare-release.ps1 -ChromeExtensionId '<商店分配的正式扩展ID>'
```

不得把使用本地开发 ID 构建的安装包作为商店内测交付物。内测资料与商店提交清单位于 `store-assets/`，隐私政策见 `PRIVACY.md`。

## 合规边界

仅下载用户拥有版权或已获授权的资源。检测到 DRM 时只提示，不绕过 DRM。

Cookie 与 Authorization 仅在当前下载进程的内存中临时使用，不写入任务历史；Native Host 启动时也会清理旧版本任务文件中遗留的敏感请求头。
