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
- 资源 URL 去重及下载按钮防双击，同时保留用户主动重复下载能力；
- 下载前可自定义文件主名称，扩展名自动识别，同名文件自动添加序号；
- 下载任务支持仅删除记录或同时删除本地文件，进行中任务会先安全取消下载；
- HLS/DASH 资源可被识别；若系统安装 FFmpeg，助手会使用无转码合并链路处理清单，否则任务会保留明确的进程启动失败原因。

## 目录

- `extension/`：浏览器扩展；
- `native-host/`：Rust Native Messaging 助手；
- `tools/`：校验和 Windows 安装辅助脚本。

## 界面基线

扩展弹窗采用 cut-ui 的按钮、卡片、标签、空状态和进度视觉约定：浅色信息层级、紧凑圆角卡片、明确的主次操作和可读的状态提示。由于浏览器扩展当前是原生 HTML/JS，不直接把 Vue 2 组件库打进扩展；后续若建设独立任务中心页面，再通过 cut-ui 包提供 Vue 页面实现。

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

## 合规边界

仅下载用户拥有版权或已获授权的资源。检测到 DRM 时只提示，不绕过 DRM。
