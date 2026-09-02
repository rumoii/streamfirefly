# 流萤 StreamFirefly

流萤是一个本地优先的网页媒体发现与下载工具：浏览器扩展发现资源，Rust 本地助手负责持久化下载任务。

## 当前状态

当前版本已实现：

- Chrome、Edge、Firefox 点击扩展图标后打开与来源网页一对一绑定的完整流萤应用页；同一网页重复点击只聚焦已有应用页；
- 资源、下载与设置使用顶部页签切换；来源网页关闭后保留当前资源快照，直到对应流萤页关闭；
- 正则、类型、大小范围筛选，嗅探顺序、文件大小、媒体时长和类型分组排序；
- 资源批量选择、复制、下载和从列表移除，以及当前页面暂停/继续嗅探；
- HLS 媒体解析支持清晰度、外部音轨、多字幕、切片和时间范围选择；选择结果会生成实际下载任务；
- HLS 快速下载默认选择最高画质、默认音轨和全部范围，不默认下载字幕；
- HLS 多字幕以同名语言文件保存，并与主视频作为同一个任务展示和删除；
- DASH 保留清单解析、预览和完整清单下载，完整轨道选择留待后续版本；
- Native Messaging 协议 v3，并声明兼容 v2；下载任务支持暂停、继续、取消和重试；
- Chrome/Edge 与 Firefox 142+ Manifest V3 扩展；
- 页面资源候选发现（请求 URL、响应 MIME、媒体元素、小型 JSON/文本和内联脚本）；
- 图片识别默认关闭；TS、M4S、KEY 分片独立折叠显示，每批 100 个、每页最多保留 1000 个；
- 可下载页面通过 POST、Blob 或脚本在内存中生成的 HLS 清单；清单仅在当前会话中保存，并在交给 FFmpeg 前校验所有资源地址；
- 可选的高级深度搜索观察 JSON.parse、Base64、文本解码和同源经典 Worker，默认关闭；
- 普通 HTTP 下载任务创建；
- Native Messaging 协议与 Rust 助手任务状态机；
- Rust 助手通过系统 `curl` 执行下载，并持久化任务清单；
- 应用内设置页配置并验证默认保存目录；
- 真实下载字节、总大小、速度、预计剩余时间和阶段进度；
- 资源页采用紧凑单列卡片，点击当前资源即可在卡片内展开分辨率、时长、封面、来源页面和播放预览；
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

扩展使用 Vue 3、TypeScript 和 Vite 构建完整应用页。界面采用统一的按钮、卡片、标签、空状态、骨架屏和进度视觉约定，并独立实现 CutUI 风格的视觉语言，不捆绑或复制私有组件库源码。

## 开发验证

安装固定版本的浏览器测试工具并运行静态、单元测试：

```powershell
npm install
npm run typecheck
npm run validate:extension
npm run test:unit
npm run lint:firefox
```

真实浏览器测试使用独立临时配置，不复用日常浏览器数据：

```powershell
npm run test:firefox
npm run test:chrome
npm run test:browsers
```

Firefox 测试默认查找 `C:\Program Files\Mozilla Firefox\firefox.exe`，也可通过 `FIREFOX_BINARY` 指定。Chrome 对应变量为 `CHROME_BINARY`。Firefox 测试使用 headless 模式；Chrome 因正式版不支持 headless 加载未打包扩展，使用独立配置的屏幕外窗口。

Rust 助手需要 Rust 工具链：

```powershell
cargo test --manifest-path native-host/Cargo.toml
cargo build --release --manifest-path native-host/Cargo.toml
npm run test:native
```

构建后，以浏览器扩展 ID 注册本地助手；Firefox 使用清单中的固定 ID：

```powershell
.\tools\install-native-host.ps1 `
  -ChromeExtensionId '<Chrome扩展ID>' `
  -FirefoxExtensionId 'streamfirefly@example.invalid'
```

每次重新编译 Native Host 后，需要再次运行安装脚本，覆盖浏览器实际调用的本地助手程序。扩展更新后在 `chrome://extensions` 中点击“重新加载”。

生成 Chrome Web Store 上传包：

```powershell
.\tools\package-extension.ps1
```

上传包只包含 Chrome 扩展运行所需的白名单文件，不包含 Firefox Manifest、图标设计稿或本地状态。

生成 Firefox 临时测试 XPI：

```powershell
npm run package:firefox
```

产物为 `release/StreamFirefly-firefox-0.9.0-test.xpi`，可在 `about:debugging#/runtime/this-firefox` 中通过“临时载入附加组件”测试。它未经过 Mozilla 签名，不能作为 Firefox 正式版的长期安装包；长期安装或分发必须提交 Mozilla 签名。


在取得 Chrome Web Store 正式 ID 前，为 x64 和 ARM64 测试机生成不绑定开发扩展 ID的完整内测包：

```powershell
.\tools\package-internal-test.ps1
```

内测包包含解压即用的扩展目录、Native Host、FFmpeg、安装/卸载脚本、宣传素材、内外层 SHA-256 和测试说明。测试机应先加载扩展，再将该电脑实际显示的扩展 ID传给包内安装脚本。

## Windows 安装包

正式交付由浏览器商店扩展和 Windows Native Host 安装包组成。安装包包含 Native Host 与固定版本的 GPL FFmpeg，并分别生成 x64、ARM64 版本：

```powershell
.\tools\build-installer.ps1 -Architecture x64
.\tools\build-installer.ps1 -Architecture arm64
```

构建机需要 Rust 对应目标工具链和 Inno Setup 6。FFmpeg 二进制在构建阶段按固定 URL 与 SHA-256 下载，不提交到 Git；安装过程本身不访问网络。本地开发扩展 ID 为 `gimoeapmpoeogpabfdplccplmmohklff`，Chrome Web Store 正式 ID 取得后通过 `-ChromeExtensionId` 传入；Edge 商店 ID 通过 `-EdgeExtensionId` 传入；Firefox Native Messaging 固定使用 `streamfirefly@example.invalid`。

Chrome Web Store 创建条目并取得正式扩展 ID 后，使用该 ID 一次性生成扩展 ZIP、两个架构的安装包和校验文件：

```powershell
.\tools\prepare-release.ps1 -ChromeExtensionId '<商店分配的正式扩展ID>'
```

不得把使用本地开发 ID 构建的安装包作为商店内测交付物。内测资料与商店提交清单位于 `store-assets/`，隐私政策见 `PRIVACY.md`。

## 合规边界

仅下载用户拥有版权或已获授权的资源。检测到 DRM 时只提示，不绕过 DRM。

Cookie 与 Authorization 仅在当前下载进程的内存中临时使用，不写入任务历史；Native Host 启动时也会清理旧版本任务文件中遗留的敏感请求头。
