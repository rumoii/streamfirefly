# 捕捉与深搜 Beta 2 开发交接

> 注：本记录写于 2026-09-16 提交历史署名规范化改写之前，文中提交哈希已无法在当前仓库中直接解析；相关判定以对应的 GitHub Actions 运行记录为准。改写范围见 [提交历史署名改写](commit-history-rewrite.md)。

## 交接基线

验证快照日期：2026-09-07。分支 `main`，源码基线 `a770ddee8fac63333aef8dc25c159ef679aa7bfa`；首次验证时，Beta 2 实现、测试及交接文档属于该基线之后尚未提交的工作区改动。这是历史验证快照，不表示后续检出的仓库仍有未提交文件。接手时用 `git log` 与 `git status --short` 确认实际提交和工作区；仅检出该基线不能获得 Beta 2 改动。Beta 2 尚未发布。

源码数字版本保持 `0.10.0`，内测打包工作流的 `bundle_version` 默认值为 `0.10.0-beta.2`，用于 Actions 测试产物；两者不能用作 Beta 2 已发布的证据。Beta 1 的 CI 结果也不覆盖后续源码提交。

整体架构见 [模块化发现、工具交接与缓存捕捉](modular-discovery.md)，身份隔离的取舍与回滚见 [捕捉文档身份决策](../decisions/proposed/2026-09-07-capture-document-identity.md)。本页统一维护 Beta 2 的交接状态和验收清单。

## 已实现

- 扫描主页面及有权限访问的 HTTP/HTTPS iframe；显示来源框架、媒体类型及失败框架。一个来源自动选中，多个来源显式选择。
- 控制与数据按 tabId、frameId、documentToken 校验，浏览器提供 documentId 时追加校验。旧选择、旧数据和迟到的中断事件不能影响新会话。
- 开始过程支持导航取消；选中来源消失由文档事件与有界周期检查终止；重复停止复用同一操作，不将停止 ACK 显示为最终成功。
- 前端捕捉、深搜状态独立于配置面板，使用共享请求类型；展示等待数据、停止排空、合并、部分结果、中断和检查点异常。
- 深搜显示各框架注入结果与刷新提示，恢复站点记忆显示，停用后清理候选。修复独立扩展页的请求误指向控制页自身的问题。

Native 下载队列、外部工具和检查点格式未改变；未增加完整 DASH、WebRTC/MediaRecorder、多平台或新权限。

## 模块职责与调用关系

以下路径相对仓库根目录。保持模块化单体，不引入统一巨型会话管理器，也不为了交接继续拆分代码。

| 模块 | 拥有的职责 | 依赖与边界 |
| --- | --- | --- |
| `shared/capture.ts` | 捕捉来源、快照、框架状态和请求契约 | 仅定义类型，不拥有浏览器或 Native 运行资源 |
| `extension-ui/src/features/capture/state.ts`、`deep-search/state.ts` | 各域的选择、请求和展示状态 | 通过 `features/session-client.ts` 请求扩展；配置面板负责交互，不判断文件是否最终保存 |
| `extension/src/background.js` | 消息组合、来源校验和目标标签页路由 | 可信扩展控制页使用请求目标；网页内容脚本使用发送方标签页 |
| `extension/src/capture-coordinator.js` | 框架扫描、来源身份、启动取消和停止生命周期 | 调用内容脚本、传输层及 Native 请求，不写文件、不合并媒体 |
| `extension/capture-content.js`、`extension/src/capture-transport.js` | 文档实例身份、页面控制、捕捉传输与 ACK | 拒绝框架或文档不匹配的数据，不取代 Native 最终快照 |
| `extension/src/deep-search.js`、`extension/content.js` | 框架探针状态、站点记忆与候选归属 | 注入和站点记忆写入分别串行；候选密钥不持久化 |
| `native-host/src/capture*.rs` | 会话、落盘、检查点、恢复与合并 | 沿用既有 Native 实现；Beta 2 不改变检查点或二进制帧格式 |

控制流：配置面板 → 分域状态 → 共享请求客户端 → 后台路由 → 捕捉协调器或深搜管理器。捕捉数据经页面内容脚本和传输层进入 Native；界面通过 Native 快照获知最终结果。配置上下文仍沿用既有通用客户端，不把这次分域状态抽取描述为全局 API 重写。

维护时必须保留以下约束：

- 来源由 `tabId`、`frameId`、`documentToken`、媒体源 `id` 共同确定；有 `documentId` 时追加校验。扫描最多接受 100 个框架，超限报错；仅扫描可访问的 HTTP(S) 文档。
- 每标签页最多一个活动来源。选中框架导航、来源消失或 Host 失败触发中断；无关框架导航不停止当前捕捉，也不自动切换来源。启动过程可取消，重复停止共享关闭操作，旧会话迟到事件不能影响新会话。
- 停止请求 ACK 不代表文件保存成功；排空、合并、部分结果、中断和不可用必须分开显示。Native 快照是最终状态依据，不可用的数据量不能显示为零。
- 只有当前启用且就绪文档的深搜候选可被接收；密钥仅存内存，不自动应用。前后台随同一扩展产物更新，旧页面需要刷新。

## 本地验证

2026-09-07，基于 a770dde 后的工作区改动：

| 验证层 | 已执行结果 | 能证明与不能证明的范围 |
| --- | --- | --- |
| `npm run verify:features` | 提交前对最终功能快照重跑通过：类型、构建与扩展校验、40 项前端测试、38 项 Rust 测试、模块边界及 Native HTTP/HLS/队列/捕捉测试 | 覆盖本地源码；不等于包内安装态或新 CI 验收 |
| `npm run test:unit` | 最后记录为 12 个前端测试文件、40 项测试通过；边界检查覆盖 30 个 Rust 和 66 个前端/领域模块，其他脚本检查通过 | 包含捕捉会话、深搜、打包契约；打包契约通过不等于实际安装通过 |
| `node tools/test-capture-sessions.mjs` | 错误框架、旧文档令牌及 documentId、重复停止、启动取消、来源替换、迟到中断和传输关闭通过 | 验证生命周期和隔离规则，不覆盖真实安装链路 |
| `npm run test:capture:frames` | Chrome/Edge 主页面、同源和跨源 iframe、深搜注入与清理、跨源数据隔离及旧文档拒绝通过 | 使用真实扩展与浏览器，但 WebSocket 接收端为夹具，不注册用户本机助手 |
| `npm run test:ui:browser` | 提交前构建产物 UI 夹具通过：时长过滤、批量提交、键盘焦点和断连反馈 | Native API 为模拟接口，不替代捕捉面板的完整人工验收 |
| Playwright MCP 界面验收 | localhost 模拟扩展/Native API 下的扫描、单源选择、授权、开始、停止、部分结果及深搜框架状态通过；控制台无错误或警告，检查到的资源请求均为 200 | 仅证明模拟接口下的可见状态和交互，不证明真实 Native 集成 |
| Firefox | 构建、契约与 lint 通过；机器缺少 Firefox | 实际运行未验证 |
| 安装态保护 | 本地误调用在修改注册表前被拒绝 | 保护入口已验证，真实安装态及新 CI 未执行 |
| 两小时与真实环境 | 未执行 | 不能声称长期稳定、真实网站可用或 Beta 2 发布验收完成 |

### 证据位置

以下是本机已有证据，均在 Git 忽略的 `test-results/` 中，不会随仓库克隆交付，也不能视为未来提交的固定验证证明：

- `test-results/beta2-verify.log`：早期汇总验证记录；提交前最终功能快照的重跑见 `test-results/beta2-precommit-verify.log`。
- `test-results/beta2-precommit-frames.log`、`test-results/beta2-precommit-ui.log`：提交前框架与构建产物 UI 夹具复跑记录。
- `test-results/beta2-unit-final.log`、`test-results/beta2-build-final.log`：后续单元与构建记录。
- `test-results/capture/chrome-transport-0.json`、`test-results/capture/edge-transport-0.json`：真实浏览器、夹具传输结果，`installed` 为 `false`。
- `test-results/capture/beta2-capture-partial.png`、`test-results/capture/beta2-deep-frames.png`：模拟接口下的界面截图。

异机交接需单独提供这些文件或在目标环境重新生成证据。新 CI 验收应记录完整提交 SHA、运行编号、输入参数和 artifact 名称；旧日志不能冒充新提交的验收结果。

### 本地复核命令

从仓库根目录执行；准备已安装依赖的 Node.js 环境（CI 使用 Node 24）、Rust 工具链，以及浏览器测试需要的 Chrome、Edge 和 FFmpeg。`test:capture:frames` 默认读取 `installer/build/x64/ffmpeg.exe`，也可通过 `STREAMFIREFLY_FFMPEG_EXE` 指定测试用 FFmpeg。

```powershell
git status --short
git rev-parse HEAD
npm run verify:features
if ($LASTEXITCODE -ne 0) { throw '源码验证失败' }
npm run test:capture:frames
if ($LASTEXITCODE -ne 0) { throw '框架捕捉验证失败' }
```

只复核捕捉生命周期时可执行 `node tools/test-capture-sessions.mjs`；它不能替代汇总验证或安装态验收。文档整理不需要重跑业务测试。

## 安装态与长期验收入口

`npm run test:capture:installed` 在隔离 Windows CI 中使用实际包内扩展、已安装 Host 和 FFmpeg，按专用测试扩展 ID 注册；执行 Chrome 60 秒和 Edge 短链路的真实 Native Messaging 控制和 WebSocket 捕捉，校验 FFprobe 输出及导航后片段保留。Chrome 必须取得至少两次有效内存采样；短链路不替代两小时门槛。

`npm run test:capture:soak` 执行 7200 秒持续捕捉。测试生成连续 fMP4 片段，移除播放器旧缓冲，Native 持续落盘；每 30 秒采样自有进程树内存，限制总工作集 2 GiB、预热后增长 512 MiB，结束检查输出时长、容器和视频轨道。该固定夹具门槛不代表所有真实网站的内存预算。

采样和进程清理由 `tools/capture-test-runtime.mjs` 管理；场景、HTTP 服务与媒体检查仍由捕捉测试脚本编排，不依赖产品模块。异步采样单次上限 10 秒，失败记录退出状态、信号、错误输出、耗时及所属进程身份，不补零或跳过。进程身份使用 PID 与创建时间，清理只终止核实归属的进程，等待退出后再删除测试目录。成功报告必须在清理完成后生成；主流程、清理和报告写入错误分别保留。

`npm run test:capture:runtime` 覆盖采样异常、进程身份、内存边界和最终报告，接入 `test:unit`。`npm run test:capture:runtime:windows` 验证实际 PowerShell、临时进程树、父进程提前退出、无关进程保护与文件锁释放，接入 Windows 打包 CI，不修改本机 Native 注册。

这两个入口要求 `GITHUB_ACTIONS=true`、`STREAMFIREFLY_ISOLATED_INSTALL_TEST=1`，扩展和 Host 必须来自 RUNNER_TEMP 中的包解压与安装目录。需提供 `STREAMFIREFLY_NATIVE_EXE`、`STREAMFIREFLY_EXTENSION_DIR`、`STREAMFIREFLY_FFMPEG_EXE` 和 `STREAMFIREFLY_FFPROBE_EXE`。本地误调用会在修改注册表之前失败。

内测打包工作流已接入短安装态测试，并增加 `capture_soak_seconds` 选项。默认 0 不执行两小时测试，Beta 2 发布验收必须另选 7200 并取得成功结果；测试证据上传为独立 artifact，不夹带到安装包。

**本次未执行新 CI、真实安装态测试或两小时测试，也未验证真实网站、ARM64 实机及升级回滚；Beta 2 尚不能宣称完成发布验收。**

## 接手后的验收顺序

### 安装态测试夹具修正（2026-09-08）

运行 `34184210860` 的诊断显示，第二次会话已处于 `capturing`，但页面只有 `started`、没有 `chunk`，播放器的 MediaSource 已变为 `ended`。本地严格检查 SourceBuffer 错误后复现媒体追加失败：测试按 `moof` 拆分 MP4，却没有用 `default_base_moof` 生成适用于 MSE 的片段相对寻址。第一次追加即触发异步解析错误；注入脚本结果又未被完整检查，错误被掩盖为后续等待落盘超时。

夹具生成增加 `default_base_moof`；追加操作等待成功、错误或有界超时，移除已完成监听器，并显式返回失败。等待落盘记录对应会话的最近快照，遇到终止状态立即报告。诊断只保留有界事件元数据，不包含媒体正文或连接令牌。

`npm run test:capture:frames` 在 Chrome/Edge 本地通过连续追加、同源重复捕捉、跨框架切换和过期来源拒绝，测试接收端校验实际片段字节及新会话序号归零。产品捕捉实现、Native 格式、权限和等待落盘的时间上限未修改。该本地结果不替代修正后源码的隔离安装态 CI；测试包只在对应运行全部成功后交付。

### 验收步骤

1. **固定验收源码。** 核对工作区和提交记录，保留任何尚未提交的修改；如需额外提交、推送，另行取得授权。工作流要求远端 `main` 的完整 `expected_commit`，未提交工作区不能直接作为 CI 输入。使用包含 Beta 2 改动的确切提交，不填写旧基线冒充。
2. **先跑隔离安装短链路。** 在获准触发 `.github/workflows/package-internal.yml` 后，显式填写 `bundle_version=0.10.0-beta.2`、目标完整 `expected_commit`、`capture_soak_seconds=0`。检查包内扩展、实际 Host 的 Chrome/Edge Native Messaging、FFprobe 输出、导航后的片段保留及卸载清理；任一失败先定位，不进入发布。
3. **再跑两小时。** 短链路成功后，对同一提交选择 `capture_soak_seconds=7200`。若修复改变源码，需先重过该提交的短链路。检查持续捕捉、停止、媒体轨道、按实际送达片段计算的输出时长，以及总工作集 2 GiB、预热后增长 512 MiB 的夹具门槛。
4. **分别补齐环境验收。** 真实网站、Firefox 运行、ARM64 实机、升级回滚分别记录环境、步骤和结果。双架构构建不等于 ARM64 实机验收；当前 Firefox 静态检查不等于 iframe 捕捉运行验收。这些记录不代表完整 1.0 验收。

安装态入口仅限隔离 Windows CI：不得本地伪造 `GITHUB_ACTIONS` 和隔离开关绕过保护，不得覆盖用户已有 Host 注册。Native 与扩展路径必须位于 `RUNNER_TEMP`；FFmpeg 使用包内安装文件，FFprobe 使用工作流指定的工具路径，不得用源码 Debug Host 替代包内产物。

工作流将 JSON 上传到 `Capture-evidence-<run_id>`，当前保留期为 14 天；失败时也尝试上传，但缺少报告不能视为通过。验收记录应引用实际文件，短链路为 `chrome-installed-60.json`、`edge-installed-0.json`，长期测试为 `chrome-installed-7200.json`，失败报告带 `-failed` 后缀；旧记录的 Chrome 短链路文件为 `chrome-installed-0.json`。安装包 artifact 与证据 artifact 分离，产出 artifact 不等于发布 Release。

身份隔离决策保持 `proposed`，安装态与两小时验收完成前不得标记 `implemented`。发布、版本调整和私人路线图不属于文档交接操作。
