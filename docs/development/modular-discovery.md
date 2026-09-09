# 模块化发现、工具交接与缓存捕捉

2026-09-08 的工具草稿、URL 提取和统一设置布局见 [工具交接、规则提取与设置界面](tools-and-extraction.md)。该开发进度不替代后续统一验收。


2026-09-09 的动态 MPD、实验性 DASH 选轨和资源优先界面见 [DASH 点播开发说明](dash-vod.md)。下文关于 DASH 未实现的范围描述属于 Beta 1 历史基线，不作为当前源码能力结论。

Beta 2 的当前状态、模块职责、证据边界和下一步验收顺序统一见 [捕捉与深搜 Beta 2 开发交接](capture-beta2.md)。下文保留 Beta 1 的实现与验证基线，不代表新增改动已通过安装态验收。

Beta 2 将捕捉与深搜状态分别放在 `extension-ui/src/features/capture/state.ts` 和 `extension-ui/src/features/deep-search/state.ts`，通过 `extension-ui/src/features/session-client.ts` 使用 `shared/capture.ts` 的请求契约；配置面板仍负责交互和既有上下文接入。详细生命周期不在本页重复维护。

## 代码边界

扩展保持模块化单体，不增加后台服务框架或旧实现兼容层。

| 模块 | 职责 | 不拥有 |
| --- | --- | --- |
| `shared/discovery.ts` | 规则校验、匹配顺序与解释 | 浏览器、持久化、任务 |
| `shared/templates.ts` | 字符串模板与文件名校验 | shell、网络、页面状态 |
| `extension/src/background.js` | 组合模块、消息与权限路由 | 隐式共享脚本作用域 |
| `resources.js` / `workspace.js` / `preview.js` | 各自的页面资源、工作区与预览生命周期 | 下载进程 |
| `discovery.js` / `evaluation.js` | 配置、重评估、限额与可终止计算 | 外部工具执行 |
| `integrations.js` / `integration-request.js` / `integration-adapters.js` | 回执去重、参数展开、不同传输适配 | 内置下载任务状态机 |
| `deep-search.js` | 页、框架与文档身份绑定，密钥内存 | 密钥持久化 |
| `capture-coordinator.js` / `capture-transport.js` | 捕捉控制、页面收尾、认证传输与 ACK | 文件写入和合并 |
| `native-host/src/repository.rs` | 下载任务持久化 | 调度器、线程和子进程 |
| `runtime.rs` / `queue.rs` / `task_runner.rs` | 运行资源、队列与执行 | 配置界面 |
| `capture.rs` | 捕捉会话和工作线程所有权 | WebSocket 帧解析、FFmpeg 参数细节 |
| `capture_model.rs` / `capture_catalog.rs` / `capture_storage.rs` | 捕捉模型、恢复目录索引、持久 ACK | 页面控制和下载队列 |
| `capture_socket.rs` / `capture_merge.rs` | 认证帧传输、代际分别合并 | 扩展配置 |
| `features/settings` / `features/downloads` / `features/configuration` | 分域状态与功能界面 | Native 持久化真相 |

`store.ts` 保留 UI 门面和上下文同步，设置与下载状态由独立模块拥有。Native 入口只声明模块并进入协议循环，生产代码不再从根模块通配导入。扩展通过 esbuild 生成后台入口，删除原共享作用域脚本。模块检查拒绝依赖环、共享业务代码的平台依赖及任务仓库持有执行资源。

## 外部交接

状态为 `sending → accepted / started / requested / failed / unknown`。这些状态只表示交接，不等同下载完成。发送前先保存回执；同一请求 ID 去重。连接中断、响应无法解释等情况保留 unknown，不自动重发；只有明确拒绝或确认未启动才提供逐项手动重试。HTTP/Aria2 自动发送需要单独配置站点，程序和协议不会自动执行。

路径和参数分离，本机程序不通过 shell 启动。常见解释器不能作为工具目标。目标服务固定、禁止重定向、不附带浏览器环境凭据；资源请求字段按工具白名单提供。工具会话令牌不持久化。模板不是脚本语言，正则和字符串变换在可终止 Worker 中执行。

## 捕捉生命周期

`armed → capturing → finalizing → complete / partial`；页面关闭、导航、连接中断或助手退出进入 interrupted。停止先禁止新片段，再等待已排队数据的持久 ACK，随后合并；异常停止不假装完整成功。助手退出时标记会话、关闭传输并回收自身工作线程和合并子进程。外部交接启动的下载程序不属于内置下载任务，退出助手不会撤销交接。

每次最多 2 个活动捕捉、100 个登记会话、32 条轨道/代际，单块不超过 256 KiB、每会话不超过 64 GiB。MAIN 队列原始数据不超过 16 MiB。选择媒体源后不会混入其他源；拖动时间线或编码变化创建新代际，分别整理为 MKV。缺初始化、丢帧或合并失败保留原始文件并标记部分结果。启动前的缓冲不回溯读取，DRM 不处理。

Native 接收端只监听回环地址，验证 Origin 和一次性随机会话令牌。写盘同步及检查点成功后才 ACK；重复最后一块必须字节相同。索引支持自定义保存目录；损坏检查点显示 unavailable，阻止覆盖，并要求人工处理。不迁移、不重置旧下载文件。恢复是整理已经落盘的片段，不是恢复网页播放或补齐遗漏片段。

## 验证与限制

开发入口 `npm run verify:features` 包含类型、构建、静态边界、单元和真实 Native 集成；`npm run test:capture:browser` 验证实际 Chrome 中 MAIN、content、offscreen、WebSocket 及停止排空。浏览器捕捉测试接收端是 WS 夹具，Native 测试单独运行真实 Rust Host 和 FFmpeg/FFprobe；两者不等同已安装扩展经 Native Messaging 注册的完整实机链路。

Native 集成仅使用临时 `LOCALAPPDATA`。需要先准备 x64 FFmpeg 与 FFprobe，或设置 `STREAMFIREFLY_FFMPEG_EXE`、`STREAMFIREFLY_FFPROBE_EXE`；可用 `STREAMFIREFLY_NATIVE_EXE` 指向待测产物。浏览器使用独立测试配置，不读取日常浏览器配置。

2026-09-07 的本地证据：37 项前端单测、38 项 Rust 单测、真实 HTTP/HLS/队列/恢复测试及捕捉认证、重放、代际合并通过；实际 Chrome 捕捉传输和 Chrome/Edge 原工作区链路通过；Firefox 构建与 lint 通过，未安装 Firefox，实际 Firefox 验收未完成。Playwright MCP 的规则保存/复制/重载、工具保存、模板预览使用 localhost 模拟扩展接口，不是外部下载器联调。

`npm audit` 仍报告既有 `web-ext → addons-linter → image-size` 开发工具链的 3 项 high 风险，本次未强制升级或降级该工具链。

后续完整验收仍需补：已安装助手的浏览器捕捉全链路、真实 Aria2/N_m3u8DL-RE/协议处理器、Firefox、长时播放压力和 Windows ARM64 包验收。DASH 完整轨道选择不在本次实现内。
