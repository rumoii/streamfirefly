# 流萤 StreamFirefly

流萤是一个本地优先的网页媒体发现与下载工具：浏览器扩展发现资源，Rust 本地助手负责持久化下载任务。

## 当前状态

当前工作区实现以下 0.9 能力，不代表已发布的内测包已包含这些改动，也不代表完整 1.0 已验收：

- Chrome、Edge、Firefox 点击扩展图标后打开原生侧栏，不创建流萤标签页；侧栏自动跟随当前窗口的活动标签；
- 侧栏提供当前来源、资源筛选与下载、HLS 快速/详细入口和任务概览；“展开工作区”在网页内容区域挂载完整界面，浏览器侧栏继续用于导航；
- 每个浏览器窗口最多保留一个展开工作区；切换标签会保留原标签上的筛选和 HLS 选择状态，在另一标签展开时卸载旧工作区；导航、关闭标签、Escape 和“收起”都会释放工作区资源；
- 浏览器内部页、扩展页和其他受限页面只显示不可嗅探状态，不注入工作区；
- 正则、类型、大小和时长范围筛选，嗅探顺序、文件大小、媒体时长和类型分组排序；
- 资源批量选择、复制、下载和从列表移除，以及当前页面暂停/继续嗅探；批量下载一次确认，逐项展示入队、失败和需单独处理的结果，可重试失败项；
- HLS 媒体解析支持清晰度、外部音轨、多字幕、切片和时间范围选择；选择结果会生成实际下载任务；
- HLS 快速下载默认选择最高画质、默认音轨和全部范围，不默认下载字幕；
- HLS 多字幕以同名语言文件保存，并与主视频作为同一个任务展示和删除；
- DASH 保留清单解析、预览和完整清单下载，完整轨道选择留待后续版本；
- Native Messaging 协议 v3；扩展和 Native Host 必须成套更新，不支持旧版混用。HLS 快速、详细和批量入口共享计划构建，点播采用 v2 切片计划、直播采用 v3，不再使用旧 HLS FFmpeg 网络读取路径；
- Native Host 按 FIFO 最多同时执行 2 个任务；排队任务可直接暂停或取消，恢复和重试进入队尾。直播必须单独启动，名额满时明确拒绝；
- 创建请求使用稳定请求标识去重，响应超时后先查询结果；助手断连保留最后一次任务列表，界面显示重连入口，不把连接失败显示为空列表；
- Chrome/Edge 与 Firefox 142+ Manifest V3 扩展；
- 页面资源候选发现（请求 URL、响应 MIME、媒体元素、小型 JSON/文本和内联脚本）；
- 图片识别默认关闭；TS、M4S、KEY 分片独立折叠显示，每批 100 个、每页最多保留 1000 个；
- 可解析页面通过 POST、Blob 或脚本在内存中生成的 HLS 清单；校验资源地址后生成切片计划，运行时原始清单不写入任务历史，恢复所需的派生清单由检查点保存；
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
- HLS 点播由 Native Host 以 1–16 路并发下载切片，默认 6 路，支持切片级重试、暂停、检查点和公开资源重启恢复；完成后由内置 FFmpeg 无转码合并；
- 标准 AES-128 HLS 支持清单自动密钥、Hex、Base64、密钥 URL 和自定义 IV，并在并发下载前验证首个加密媒体切片；Cookie、Authorization 和手动密钥不写入任务文件或检查点；
- 标准 HLS 直播支持显式开始、暂停和停止保存，不在快速或批量入口隐式录制；DASH 仍通过内置 FFmpeg 下载完整清单；SAMPLE-AES、DRM 和 LL-HLS Part 只识别提示，不绕过；
- HLS/DASH 资源可被识别；安装包提供 FFmpeg，助手使用无转码合并链路处理清单；便携测试模式未安装 FFmpeg 时会保留明确的进程启动失败原因。

## 目录

- `extension/`：浏览器扩展；
- `extension-ui/`：侧栏、网页内工作区及共享的计划、任务状态和交互组件；
- `native-host/`：Rust Native Messaging 助手；
- `tools/`：校验和 Windows 安装辅助脚本。

后台按资源上下文、工作区、预览请求头、Native 连接拆分；Native Host 按协议、模型、任务存储、调度、任务控制、HTTP/HLS 引擎和媒体子进程拆分。模块仍属于同一个扩展或进程，共享状态由现有入口组装，不引入服务化或插件框架。

## 成套升级与数据边界

升级前等待任务结束并备份本地任务文件及检查点目录，随后同时更新扩展和本地助手。仅重新加载扩展不能替换已经安装的助手。回滚同样需要成套操作，不支持只降级一端。

任务存储版本仍为 1，检查点版本不因模块拆分而改变。未知版本、损坏或无法读取的任务文件会阻止继续写入，不会用空列表覆盖；旧 HLS v1 任务不能通过兼容引擎恢复，需要重新解析创建。不要删除旧任务、检查点或已下载文件来绕过升级问题；需要恢复备份时先停止助手，并保留升级后的数据副本。

## 界面基线

扩展使用 Vue 3、TypeScript 和 Vite 构建原生侧栏与按需注入的网页内工作区。工作区只挂载到顶层页面的 Shadow DOM，覆盖网页内容可视区域，不覆盖地址栏和标签栏；侧栏、工作区与浏览器选项页复用同一套状态、消息接口和业务组件。界面采用统一的按钮、卡片、标签、空状态、骨架屏和进度视觉约定，并独立实现 CutUI 风格的视觉语言，不捆绑或复制私有组件库源码。

## 开发验证

安装固定版本的浏览器测试工具并运行静态、单元测试：

```powershell
npm install
npm run typecheck
npm run validate:extension
npm run test:unit
npm run test:ui:browser
npm run lint:firefox
```

`test:ui:browser` 使用本地构建产物和模拟扩展/Native API，验证时长筛选、批量确认、键盘焦点、断连反馈与任务保留，截图及结果位于 `test-results/ui/`；它不证明真实 Native Messaging 链路。默认使用本机 Edge，可通过 `EDGE_BINARY` 指定测试浏览器。

真实扩展浏览器测试使用独立临时配置，不复用日常浏览器数据：

```powershell
npm run test:firefox
npm run test:chrome
npm run test:browsers
```

Firefox 测试默认查找 `C:\Program Files\Mozilla Firefox\firefox.exe`，也可通过 `FIREFOX_BINARY` 指定。Chrome 和 Edge 对应变量为 `CHROME_BINARY`、`EDGE_BINARY`。Firefox 测试使用 headless 模式；Chrome 和 Edge 使用独立配置的屏幕外窗口。

Rust 助手需要 Rust 工具链：

```powershell
cargo test --manifest-path native-host/Cargo.toml
cargo build --manifest-path native-host/Cargo.toml
npm run test:native
cargo build --release --manifest-path native-host/Cargo.toml
```

`test:native` 默认使用刚构建的 debug 助手，所有任务写入独立临时目录；测试其他产物时设置 `STREAMFIREFLY_NATIVE_EXE`。HLS 集成测试还需要 `installer/build/x64/ffmpeg.exe`，或通过 `STREAMFIREFLY_FFMPEG_EXE` 指定。

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

产物为 `release/StreamFirefly-firefox-0.9.1-test.xpi`，可在 `about:debugging#/runtime/this-firefox` 中通过“临时载入附加组件”测试。它未经过 Mozilla 签名，不能作为 Firefox 正式版的长期安装包；长期安装或分发必须提交 Mozilla 签名。


在取得 Chrome Web Store 正式 ID 前，为 x64 和 ARM64 测试机生成不绑定开发扩展 ID的完整内测包：

```powershell
.\tools\package-internal-test.ps1
```

内测包包含解压即用的扩展目录、Native Host、FFmpeg、安装/卸载脚本、宣传素材、内外层 SHA-256 和测试说明。测试机应先加载扩展，再将该电脑实际显示的扩展 ID传给包内安装脚本。正式内测包默认要求干净工作树；仅本地验收未提交代码时可显式添加 `-AllowDirtySource`，包内 `PACKAGE-INFO.json` 会如实记录未提交文件，不能据此创建正式 Release。

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
