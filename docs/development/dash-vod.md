# 实验性 DASH 点播与资源优先界面

## 开发范围

版本保持 `0.10.0`，不据此创建新 Release。DASH 标记为实验性：支持静态、单 Period、非加密点播；完整 1.0 和真实环境验收另行安排。

| 能力 | 当前边界 |
| --- | --- |
| 动态 MPD 发现 | 保存一次调用内完整 XML 与来源地址；JSON、文本、字符生成、数组拼接和现有同源经典 Worker 路径 |
| 清单解析 | 分层 BaseURL、SegmentTemplate Number/Time、SegmentTimeline、SegmentList、初始化段和显式字节范围 |
| 轨道选择 | 一条视频、一条音频，或仅音频/仅视频；默认最高带宽视频、主音轨或第一条音轨 |
| 输出 | MP4/MKV，无转码；MP4 按编码校验，不兼容时使用 MKV，不承诺任意编码均可合并 |
| 生命周期 | 复用下载队列；同一助手进程内暂停/恢复、失败重试保留已完成分片；删除任务清理工作目录 |
| 重启 | 计划不持久化，未完成任务显示需重新解析；禁止自动恢复和无计划下载 |
| 不支持 | 加密/DRM、动态直播、多 Period、SegmentBase/SIDX、时间轴间断、轨道中途切换初始化段、字幕选轨、跨调用清单拼接 |

多个同级 BaseURL 只选第一项，不进行故障切换。XML 拒绝 DTD、实体及外部引用；单份清单至多 512 KiB、10000 节点、32 层，至多 128 条音视频表示、所有表示合计 20000 个分片；提交计划至多 8 MiB。完整生成清单的观察预算仍为每文档 16 MiB，不为 DASH 新增无界扫描。

## 模块与依赖

- `extension/page-probe*.js` 只观察和保留清单；`extension/src/resources.js` 负责候选分类、去重和文档生命周期，不启动下载。
- `extension-ui/src/dash.ts` 以 Apache-2.0 的 `mpd-parser` 为底层，先限制结构及展开量，再转换为轨道、片段和选轨计划；不读取浏览器状态或创建任务。
- `DashParserView.vue` 负责来源清单读取、表单选择与错误反馈。内联 XML 优先，否则通过现有 `media.fetchText` 读取；提交复用 `download-client.ts` 的幂等链路，结果未知时冻结同一请求，不静默新建任务。
- `native-host/src/dash.rs` 独立校验计划版本、轨道数、地址、字节范围、时间连续性和容器；不依赖 UI 校验作为执行依据。
- `dash_download.rs` 负责所选分片的有界并发、分轨组装和 FFmpeg 无转码合并，工作线程退出后才报告终态。最终输出先在目标目录暂存，再重命名；支持工作目录与保存目录不在同一卷。
- `segments.rs` 与 `segment_transfer.rs` 由 HLS/DASH 共用字节范围及传输、重试、取消逻辑；不合并两种协议的清单解析和恢复规则。
- `task_creation`、`task_runner`、`task_control`、`repository`、`recovery` 继续拥有队列和持久化边界，DASH 不另建队列或通用状态机。

协议仍为 v3，新增能力 `dash-selection-v1` 和 `dashPlan.version = 1`。计划包含 baseUrl、duration、container、tracks，以及每轨初始化段和分片的 URL/range/time/duration；与 HLS 计划或原始内联清单互斥。历史保留 `dash_selection` 标识，但不保存运行时 `dash_plan`。重启后 `resume_requirement = dash_reparse_required`，错误为 `dash_plan_expired`。

分片只允许 HTTP(S)；不同来源地址不携带原来源敏感请求头；Range 必须得到匹配的 206、Content-Range 和长度。FFmpeg 只读本地分轨文件，不再直接读取整份 MPD。扩展和 Host 必须成套更新；不支持能力时提示更新，不回退到旧整清单执行。

架构取舍与回退要求见 [DASH 计划与生命周期决策](../decisions/proposed/2026-09-09-dash-selected-plan.md)。

## 界面职责

资源是主内容，深搜和捕捉仅保留标题栏入口。深搜点击打开详情，在详情内开启/关闭、查看框架状态和密钥候选；打开详情本身不切换深搜。捕捉入口打开受信任的扩展控制页，不从网页工作区直接启动捕捉。

外部工具复用资源行“更多下载方式”和当前勾选结果，不再维护第二份资源选择器。原生助手断开只禁用内置下载，不阻断外部交接确认入口。大小/时长条件放入“更多筛选”，折叠保留已生效条件和计数。深搜真实错误仍显示在资源区，不藏进详情。

`ResourceTools.vue` 拥有入口导航与打开错误，`DeepSearchPanel.vue` 只负责深搜详情，状态仍由 `features/deep-search/state.ts` 所有；捕捉状态由 `features/capture/state.ts` 独立所有。导航和卸载后的异步响应不能污染下一来源。

## 验证入口

在 Windows 安装 Node、Rust、系统 curl，并准备 x64 FFmpeg/FFprobe；按实际路径设置 `STREAMFIREFLY_FFMPEG_EXE` 和 `STREAMFIREFLY_FFPROBE_EXE`。默认 Host 为本仓库 debug 产物；可用 `STREAMFIREFLY_NATIVE_EXE` 指定待测产物。

```powershell
npm run verify:features
npm run test:discovery:native
npm run test:discovery
npm run test:ui:browser
cargo fmt --manifest-path native-host/Cargo.toml -- --check
git diff --check
```

`verify:features` 包含 DASH Native 回归；`test:discovery:native` 顺序执行动态 HLS 和动态 MPD 的浏览器发现到下载闭环。可分别用 `test:dash:native`、`test:dash:discovery` 定位 DASH。打包工作流沿用这两个统一入口及包路径环境变量，并上传三份 DASH 报告；此处接入不表示已运行远端 CI。

DASH Native 测试用临时 `LOCALAPPDATA` 和 localhost 媒体，经生产解析器生成计划、真实 Host 标准输入创建任务，再由 FFprobe 和解码检查输出。覆盖选轨、仅音频、仅视频、Range 校验、暂停/重试复用、403 不重试、合并失败、取消、重启重新解析、删除、去重及禁止完整 MPD 回退。浏览器模式额外验证四份实际捕获的 MPD；两种报告分开保存，启动时先写未通过状态，测试与清理全部成功后才写通过。

界面预览：构建后执行 `node tools/serve-dash-ui-fixture.mjs`，访问 localhost:4179；`?scenario=drm` 和 `?scenario=old-host` 分别展示不支持的加密与助手能力。该预览使用真实构建 UI、模拟扩展消息，捕捉控制页无真实媒体源，不执行下载/捕捉；不是安装态功能演示。

## 验证边界与交接

2026-09-09 本地开发验证结果：

| 检查 | 结果 |
| --- | --- |
| 类型、前端/领域单测及脚本门禁 | 通过；93 项单测，含多表示共享模板的 endNumber 隔离、时间偏移和展开限额回归 |
| Chrome/Firefox 构建产物校验 | 通过 |
| Rust 单测、rustfmt、diff 检查 | 通过；41 项 Rust 单测 |
| Native 协议、HTTP、HLS、队列、捕捉 | 真实 x64 Host 与本地媒体回归通过 |
| DASH Native | 14 个场景通过；缺失可执行文件负例非零退出，报告不会复用旧通过状态 |
| 浏览器发现 | Chrome、Edge、官方 Firefox 各 13 个场景通过，使用独立测试配置 |
| 动态清单下载闭环 | 6 份 HLS、4 份 MPD 从实际 Chrome 发现到生产计划、Native 下载与 FFprobe 检查通过 |
| 构建 UI | 本地模拟消息环境下，筛选、批量提交、断连保留任务、详情入口、键盘焦点及窄屏检查通过；打开/关闭深搜详情后资源位置不变 |
| 工作流与文档 | YAML 解析、打包契约和本批文档相对链接通过；未运行远端 CI |

通用 ADR 格式校验仍报告三份既有文档的七个格式问题：`2026-09-07-capture-document-identity.md`、`2026-09-07-modular-discovery-and-tool-integration.md`、`2026-09-08-rule-extraction-and-tool-options.md`。新增 DASH 决策不在错误清单中；未为修复历史格式扩大改动范围。

本地报告位于忽略目录 `test-results/`。浏览器发现、Native 标准输入与模拟 UI 分别证明各自边界，不能互相替代 Native Messaging 注册、真实网站或外部工具验收。

仍需统一验收：真实网站 MPD 覆盖、已安装扩展到 Native Messaging 的完整链路、真实外部下载器、Windows ARM64、长时间播放/捕捉、安装升级及回退。未新增跨调用拼接、DASH 重启续传或 DRM 支持。
