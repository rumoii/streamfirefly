# 流萤 StreamFirefly

流萤是一个本地优先的网页媒体发现与下载工具：浏览器扩展发现资源，Rust 本地助手负责持久化下载任务。

## 当前状态

当前工作区实现以下 0.10 开发能力，不代表已发布的内测包已包含这些改动，也不代表完整 1.0 已验收：

- Chrome、Edge、Firefox 点击扩展图标后在当前网页打开可拖动、缩放的悬浮面板，不挤压网页，也不创建流萤标签页；普通网页默认没有悬浮入口；
- 悬浮面板与工作区共用“资源 / 下载 / 设置”导航：面板内可直接筛选和下载资源、查看资源详情与下载任务，只有设置会展开工作区；标题栏按钮在面板和有尺寸上限的工作区之间切换，工作区可由用户主动最大化并还原；
- 每个浏览器窗口最多保留一个网页内界面；切换标签不自动向新页面注入，在另一标签打开时先等待新界面就绪再卸载旧界面；导航、关闭标签或关闭流萤会释放其界面资源；
- 浏览器内部页和受限页面使用原生侧栏展示不可嗅探状态。注入失败通过工具栏提示，再次点击进入侧栏恢复入口；
- 媒体嗅探默认只在流萤打开时运行；收起成小入口仍嗅探当前来源，隐藏标签页暂时停止；可改为始终嗅探。关闭界面释放按打开模式的嗅探占用，保留已发现结果与下载任务；
- 正则、类型、大小和时长范围筛选，嗅探顺序、文件大小、媒体时长和类型分组排序；
- 资源批量选择、复制、下载和从列表移除，以及当前页面暂停/继续嗅探；批量下载一次确认，逐项展示入队、失败和需单独处理的结果，可重试失败项；
- HLS 媒体解析支持清晰度、外部音轨、多字幕、切片和时间范围选择；选择结果会生成实际下载任务；
- HLS 快速下载默认选择最高画质、默认音轨和全部范围，不默认下载字幕；
- HLS 多字幕以同名语言文件保存，并与主视频作为同一个任务展示和删除；
- DASH 实验性支持静态、单 Period、非加密清单，选择一条视频与一条音轨或仅下载音频/视频，输出 MP4/MKV；助手只下载所选分片并无转码合并，不再直接执行完整 MPD；详见 [DASH 点播开发说明](docs/development/dash-vod.md)；
- Native Messaging 协议 v3；扩展和 Native Host 必须成套更新，不支持旧版混用。HLS 快速、详细和批量入口共享计划构建，点播采用 v2 切片计划、直播采用 v3，不再使用旧 HLS FFmpeg 网络读取路径；
- Native Host 按 FIFO 最多同时执行 2 个任务；排队任务可直接暂停或取消，恢复和重试进入队尾。直播必须单独启动，名额满时明确拒绝；
- 创建请求使用稳定请求标识去重，响应超时后先查询结果；助手断连保留最后一次任务列表，界面显示重连入口，不把连接失败显示为空列表；
- Chrome/Edge 与 Firefox 142+ Manifest V3 扩展；
- 页面资源候选发现（请求 URL、响应 MIME、媒体元素、小型 JSON/文本和内联脚本）；
- 图片识别默认关闭；TS、M4S、KEY 分片独立折叠显示，每批 100 个、每页最多保留 1000 个；
- 可解析页面通过 POST、Blob 或脚本在内存中生成的 HLS 清单；校验资源地址后生成切片计划，运行时原始清单不写入任务历史，恢复所需的派生清单由检查点保存；
- 可选的高级深度搜索观察 JSON.parse、Base64、文本解码、字符生成、数组拼接和同源经典 Worker，保留完整动态 HLS/MPD 文本，默认关闭，不跨调用拼接；
- 资源列表优先显示；深度搜索和缓存捕捉位于资源工具栏，分别打开深搜详情和独立控制页；外部工具入口放在资源行的“更多”菜单及批量操作中；大小和时长条件收进“筛选”弹层，关闭弹层不清除已生效条件；
- 普通 HTTP 下载任务创建；
- Native Messaging 协议与 Rust 助手任务状态机；
- Rust 助手通过系统 `curl` 执行下载，并持久化任务清单；
- 应用内设置页配置并验证默认保存目录；
- 真实下载字节、总大小、速度、预计剩余时间和阶段进度；
- 资源页每项一行：缩略图（已知封面或图片本身，否则为类型图标）、名称与元信息、下载按钮和“更多”菜单；宽工作区按列展示分辨率、时长和大小，详情在右侧显示预览和完整地址；面板和窄窗口中详情覆盖列表，同样显示封面并可播放预览，没有封面时截取首帧；侧栏详情只显示已知封面，预览需进入工作区；勾选资源后工具栏切换为批量操作栏；
- 资源 URL 去重及下载按钮防双击，同时保留用户主动重复下载能力；
- 下载前可自定义文件主名称，扩展名自动识别，同名文件自动添加序号；
- 下载任务支持仅删除记录或同时删除本地文件，两种方式都需要最终确认，进行中任务会先安全取消下载；
- 普通 HTTP 资源支持 1–16 路 Range 并发下载，默认 6 路；服务端不支持分段时自动回退单连接；
- HLS 点播由 Native Host 以 1–16 路并发下载切片，默认 6 路，支持切片级重试、暂停、检查点和公开资源重启恢复；完成后由内置 FFmpeg 无转码合并；
- 标准 AES-128 HLS 支持清单自动密钥、Hex、Base64、密钥 URL 和自定义 IV，并在并发下载前验证首个加密媒体切片；Cookie、Authorization 和手动密钥不写入任务文件或检查点；
- 标准 HLS 直播支持显式开始、暂停和停止保存，不在快速或批量入口隐式录制；DASH 不支持直播、多 Period 和 SegmentBase/SIDX；SAMPLE-AES、DRM 和 LL-HLS Part 只识别提示，不绕过；
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

扩展使用 Vue 3、TypeScript 和 Vite 构建按需注入顶层页面 Shadow DOM 的悬浮界面。窗口壳统一管理小入口、面板、工作区和最大化状态；形态切换复用资源列表与状态，普通窗口外的网页保持可操作，只有最大化锁定底层滚动。原生侧栏保留为恢复入口，浏览器选项页继续承载可信配置。

颜色、间距、圆角和字号统一由 `extension-ui/src/theme/tokens.css` 定义，跟随系统切换浅色与深色；流萤绿用于主操作和状态，图标使用 Tabler Icons，下拉框、菜单和筛选弹层支持键盘操作。界面参考 rumo-ui 的信息密度与组件分类，不引入其 Vue 2 运行时或整套组件库。响应式布局按窗口容器宽度切换，而非按来源网页宽度切换。

### 悬浮窗口操作

- 面板初始尺寸为 420×640px；展开工作区初始宽度为 1120px、高度为可见网页的 80%，可见区域不足时自动缩小。
- 拖动标题栏移动窗口，拖动边缘或角落调整尺寸；小入口拖动后贴最近的左右边缘。尺寸与位置保存在扩展本地配置 `floatingUiLayout`，不会自动打开或自动最大化。
- 收起保留小入口并继续嗅探，停止面板媒体预览；关闭移除入口，已经创建的下载任务继续运行。
- 标题栏的“返回面板”回到快速面板，最大化后可还原。窗口内部的 Escape 依次关闭下拉菜单或筛选弹层、弹窗，再逐级还原、返回面板或收起；网页自身的 Escape 不被拦截。
- Firefox 从恢复侧栏内展开网页工作区时，仍受侧栏操作的用户手势限制；直接点击工具栏进入网页面板会在原始用户手势中关闭本扩展侧栏。

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

`test:ui:browser` 使用本地构建产物和模拟扩展/Native API，验证时长筛选、批量确认、键盘焦点、断连反馈与任务保留，以及悬浮窗口拖动、缩放、最大化还原、收起恢复、多尺寸布局和位置记忆。截图及结果位于 `test-results/ui/`；它不证明真实 Native Messaging 链路。默认使用本机 Edge，可通过 `EDGE_BINARY` 指定测试浏览器。

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

产物为 `release/StreamFirefly-firefox-0.10.0-test.xpi`，可在 `about:debugging#/runtime/this-firefox` 中通过“临时载入附加组件”测试。它未经过 Mozilla 签名，不能作为 Firefox 正式版的长期安装包；长期安装或分发必须提交 Mozilla 签名。


在取得 Chrome Web Store 正式 ID 前，为 x64 和 ARM64 测试机生成不绑定开发扩展 ID的完整内测包：

```powershell
.\tools\package-internal-test.ps1
```

内测包包含解压即用的扩展目录、Native Host、FFmpeg、安装/卸载脚本、宣传素材、内外层 SHA-256 和测试说明。测试机应先加载扩展，再将该电脑实际显示的扩展 ID传给包内安装脚本。正式内测包默认要求干净工作树；仅本地验收未提交代码时可显式添加 `-AllowDirtySource`，包内 `PACKAGE-INFO.json` 会如实记录未提交文件，不能据此创建正式 Release。

## 开发中的发现与工具模块

0.10.0-beta.1 内测版新增以下能力，扩展与助手的软件版本为 0.10.0，必须成套升级：

- **识别规则**：后缀、MIME、URL 正则，站点范围、大小约束、排除优先、排序、复制、导入导出与命中解释。正则和模板运行在有超时上限的 Worker 中。
- **输出模板**：HLS、DASH、其他资源分别设置复制模板，另设文件主名称模板；支持条件、替换、截取、编码等纯字符串变换，不执行脚本。
- **外部工具**：Aria2 RPC、HTTP 接收服务、本机 EXE 参数数组及自定义协议；独立确认页预览展开参数，逐项展示交接状态。明确失败允许手动重试，未知结果不会自动重发。自动发送仅面向显式配置的站点与 HTTP/Aria2 工具。
- **深度搜索**：按页启停、站点记忆、同源经典 Worker 和解码结果观察；疑似 AES-128 密钥仅存内存，可在 HLS 解析器中选择，仍需通过首片验证。
- **缓存捕捉**：选择当前页媒体源，捕获开启后的 MediaSource 数据，经本机认证 WebSocket 保存；写盘和检查点成功后才确认。跳转、编码变化按代际分段，分别输出 MKV，不跨时间线拼接。支持停止排空、异常保留、自定义目录索引和重启后整理片段。

工作区中的工具配置和缓存捕捉通过独立扩展页面操作；网页不能选择程序路径、修改目标服务或获取捕捉令牌。Chrome 捕捉传输由 offscreen 文档持有，Firefox 使用后台页传输。

捕捉不是完整浏览器缓存读取：不能补回启动前已经缓冲的数据，缺少初始化片段的代际保留原始轨道并标记部分结果。DRM 不支持。

模块边界和验证范围见 `docs/development/modular-discovery.md`。开发验证入口：

```powershell
npm run verify:features
npm run test:capture:browser
```

第一条包含构建、类型、模块边界、单元与真实 Native 集成测试；Native 测试使用临时 `LOCALAPPDATA`，需要 x64 FFmpeg 与 FFprobe。第二条使用独立 Chrome 扩展测试配置，验证真实 MediaSource → content → offscreen → WebSocket 链路，接收端为测试服务，不代表 Native Messaging 安装注册已验收。

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
