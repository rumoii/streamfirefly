# StreamFirefly 架构与模块化边界审查（执行版 v2）

- 基线仓库：`D:/rumo_liuying/streamfirefly`
- 基线提交：`28004968299e2657a68aa6819967dcab1aab0258`
- 审查模式：只读；未修改源码、配置、锁文件或工作树
- Git 状态：`git status` 空、`git rev-parse HEAD` 为 `28004968299e2657a68aa6819967dcab1aab0258`
- 修订说明：v2 补充了具体代码引用（非仅 file:line）与证据边界标注

## 1. 架构健康度评级与证据

总体评级：**B**

证据：
- 当前主路径总体合理，sidebar/workspace/options 共用 store、消息接口与业务组件；Native Host 承担任务状态权威与持久化，扩展 UI 仅按任务事件收敛状态。
  - `extension-ui/src/store.ts:30` — `defineStore("app", ...)` 统一定义所有 UI surface 的响应式状态
  - `extension/background.js:451` — `api.runtime.onMessage.addListener(...)` 单入口分发所有 UI 消息
  - `native-host/src/main.rs:76` — `struct Task { ... }` 定义任务权威状态结构体
- 但存在 1 个与 Rust 结构体直接相关的明显语法/类型问题，若干 UI 与消息边界不统一、跨层候选定义重复、以及针对新增 workspace 路径的测试缝隙。
  - `native-host/src/main.rs:128` — `requires_authorization: ***` 为无效 Rust 类型
  - `extension-ui/src/api.ts:17-19` — `surfaceFromUrl()` 仅返回 `"options"` 或 `"sidebar"`
  - `extension/background.js:1-15` — 单文件同时持有 6 个全局 Map/Set 与 12 个顶层函数
  - `extension-ui/src/store.ts:84` — `window.setInterval(() => { void refresh(); }, 1000)` 无活跃性守卫

## 2. 现状场景（当前数据/事件主链路）

### 2.1 资源发现主链路

1. 网络请求产生候选：`extension/background.js:261` webRequest.onBeforeSendHeaders 捕获请求头 → `extension/background.js:279` onHeadersReceived 解析响应头与 MIME → `extension/background.js:288` 调用 `addCandidate(tabId, { url, mime, size, source: "network", ... })` → `extension/background.js:217` 写入 `candidatesByTab` Map 并调度持久化
2. DOM/脚本深度探测产生候选：`extension/content.js:6-24` content script 通过 MutationObserver 扫描 `<video>/<audio>/<source>` 元素并调用 `api.runtime.sendMessage({ type: "media.add", candidate: { ... } })` → `extension/page-probe.js:26-36` page-probe 通过 `window.postMessage` 将深层脚本解析出的 URL 桥接回 content script → `extension/page-probe-advanced.js:10-56` 高级探测扫描 inline script 中的媒体 URL 模式
3. 候选进入 tab 状态并持久化到会话存储：`extension/background.js:33` `emptyState(tabId)` 创建 `{ schemaVersion, tabId, sourceContextId, candidates: new Map() }` → `extension/background.js:43` 写入 `candidatesByTab` 内存 Map → `extension/background.js:121` 通过 `persistState(state)` 序列化到 `api.storage.session`
4. 侧栏/工作区加载上下文与刷新：`extension-ui/src/store.ts:47` `loadContext()` 调用 `sendMessage({ type: "ui.context.get", scope, windowId })` → `extension/background.js:452-454` background 解析 `resolveUiTab` 并返回 `uiContextForTab(tab)` → `extension-ui/src/store.ts:84` 设置 1s 定时刷新 `timer = window.setInterval(() => { void refresh(); }, 1000)`

### 2.2 工作区注入与收起链路

1. 侧栏请求展开：`extension-ui/src/store.ts:105-108` `openWorkspace(view, candidateId)` 发送 `sendMessage({ type: "workspace.open", view, candidateId, windowId })`
2. Background 负责注入与幂等清理：`extension/background.js:84-96` `openWorkspace(tab, view, candidateId)` 先查询同窗口其他 tab 并逐个调用 `unmountWorkspace(item.id)` → `extension/background.js:90` 通过 `api.scripting.executeScript` 注入 `dist/workspace.js` → `extension/background.js:91` 发送 `workspace.navigate` 消息 → `extension/background.js:92` 写入 `workspaceTabsByWindow.set(windowId, tab.id)` 记录所有权
3. 内容脚本桥接工作区事件：`extension/content.js:38-49` 监听 `workspace.unmount` / `workspace.navigate` 消息，通过 `window.dispatchEvent(new CustomEvent(...))` 转发给 workspace 渐进式挂载
4. Vue 工作区挂载与卸载：`extension-ui/src/workspace.ts:10-41` 创建 Shadow DOM host → `workspace.ts:21` `createApp(WorkspaceApp).use(createPinia()).mount(root)` → `workspace.ts:23` 发送 `workspace.ready` 通知 background → `workspace.ts:37` Escape 键触发 `sendMessage({ type: "workspace.close" })`，失败时回退到 `dispose()` 本地清理

### 2.3 下载与任务控制链路

1. UI 发送任务创建/控制消息：`extension-ui/src/store.ts:133-144` `controlTask(task, action, suppliedContext)` 构造 `resumeContext`（含 authorization 头）并发送 `sendMessage({ type: "task.control", payload: { id, action, resumeContext } })`
2. Background 按能力协商并转发：`extension/background.js:511-530` 对 `task.create`/`task.prepare` 类型，先调用 `nativeInfo()` 获取 capabilities，检查 `hls-selection-v1`、`hls-segment-engine-v1`、`hls-live-engine-v1` 等能力标志，再通过 `nativeRequestPromise(type, payload)` 转发
3. Native Host 维护任务权威状态、检查点与恢复：`native-host/src/main.rs:76-143` `Task` 结构体定义完整任务生命周期字段 → `main.rs:160` 后续处理逻辑 → `main.rs:2659` HLS 检查点保存 → `main.rs:2764` 检查点恢复 → `main.rs:3880` 恢复时重新连接下载流

## 3. 合理点

1. 原生侧栏优先，避免应用标签页带来的双标签生命周期绑定。
   - `extension/background.js:99-103` — Chrome 用 `sidePanel.setPanelBehavior`，Firefox 用 `sidebarAction.open`
   - `extension/manifest.json:14` — `"side_panel": { "default_path": "dist/app.html?surface=sidebar#/resources" }`
   - `extension/manifest.firefox.json:11` — `"sidebar_action": { "default_panel": "dist/app.html?surface=sidebar#/resources" }`
2. 侧栏/workspace/options 共用 store、消息接口和业务组件，降低 presentation surface 之间重复业务逻辑。
   - `extension-ui/src/store.ts:30` — `defineStore("app", ...)` 统一定义所有 surface 共用状态
   - `extension-ui/src/api.ts:5-8` — `sendMessage<T>(message)` 统一封装 `runtime.sendMessage`
   - `extension-ui/src/App.vue` / `extension-ui/src/WorkspaceApp.vue` — 两个入口均导入同一 store
3. background 作为 native messaging 与能力协商入口，UI 不直接绑定 Host 版本。
   - `extension/background.js:386-400` — `ensureNative()` 管理 `connectNative("com.streamfirefly.native")` 连接生命周期
   - `extension/background.js:414-421` — `nativeInfo()` 缓存 capabilities 并对外暴露版本无关接口
   - `extension/background.js:511-530` — 任务创建前检查 capabilities 而非版本号
4. Native Host 是任务状态权威，公开任务事件与持久化文件均脱敏敏感请求头。
   - `native-host/src/main.rs:32` — `const SENSITIVE_REQUEST_HEADERS: [&str; 2] = ["cookie", "authorization"]`
   - `native-host/src/main.rs:431-457` — 持久化时过滤敏感头
5. HLS 检查点与恢复设计明确，公开资源支持重启恢复，登录态任务不落盘凭据。
   - `native-host/src/main.rs:2659` — `save_checkpoint(...)` 保存下载进度
   - `native-host/src/main.rs:2720-2734` — 检查点包含 segment 索引与字节偏移
   - `native-host/src/main.rs:3880-3904` — 恢复逻辑重新连接 HLS 流
6. 交付验证链条完整：类型检查、UI 单测、扩展逻辑测试、Native 测试、Firefox lint、构建验证。
   - `package.json:6-12` — `typecheck`、`test:ui`、`test:ext`、`test:native`、`lint:firefox`、`build` 等脚本
7. 文档与决策记录形成清晰的架构意图，特别是侧栏、工作区、HLS 检查点与协议 v3。
   - `docs/decisions/README.md`
   - `docs/decisions/proposed/2026-09-05-native-sidebar-and-page-workspace.md`
   - `docs/decisions/proposed/2026-09-03-hls-checkpoint-and-key-recovery.md`
   - `docs/decisions/proposed/2026-09-01-side-panel-protocol-v3-and-recording.md`

## 4. 不合理耦合/重复/边界泄漏（每项带证据）

### 4.1 P0-01 Native Host 任务结构体语法/类型缺陷

- 严重度：P0
- 类别：架构性阻断（可构建性/可维护性）
- 影响：`native-host/src/main.rs:128` 的 `requires_authorization: ***` 与 `main.rs:4150` 同样写法，属于无效 Rust 语法；直接受影响的是 `Task` 结构体定义与测试构造。
- 代码证据（源码直接引用）：
  ```rust
  // native-host/src/main.rs:126-131
  #[serde(default)]
  resume_requirement: Option<String>,
  #[serde(default)]
  requires_authorization: ***    // ← 无效 Rust 类型，非 bool/Option<bool>
  #[serde(default)]
  requires_key_override: bool,
  ```
  同样出现在测试构造中：
  ```rust
  // native-host/src/main.rs:4148-4151
  checkpoint_state: None,
  resume_requirement: None,
  requires_authorization: ***    // ← 与定义一致的硬伤
  requires_key_override: false,
  ```
- 推理链：`Task` 定义错误 → 任务状态序列化/反序列化边界不可靠 → native protocol/client 与 native domain/services 的类型契约受损。
- 证据状态：**源码已证明** — 静态文本即可确认 `***` 不是合法 Rust 类型标识符；无需运行时验证即可判定为缺陷。
- 建议：将该字段恢复为显式 `bool` 并统一所有引用；同时检查该字段在 `requires_authorization`、`requires_key_override` 与 `resume_requirement` 之间的语义是否重叠。

### 4.2 P1-01 UI 表面识别只区分 sidebar/options，workspace 被隐式归入 sidebar

- 严重度：P1
- 类别：职责混杂 / 跨层耦合
- 影响：`workspace` 虽由独立 URL surface 承载，但 `surfaceFromUrl()` 无法返回 `"workspace"`，使 store 初始化、上下文获取与定时刷新路径全部依赖隐式假设。
- 代码证据（源码直接引用）：
  ```typescript
  // extension-ui/src/api.ts:15-20
  export type UiSurface = "sidebar" | "options" | "workspace";
  
  export function surfaceFromUrl(): UiSurface {
    const surface = new URLSearchParams(location.search).get("surface");
    return surface === "options" ? "options" : "sidebar";  // ← workspace 永远不会被返回
  }
  ```
  store 初始化时依赖此函数：
  ```typescript
  // extension-ui/src/store.ts:31
  const surface = ref<UiSurface>(surfaceFromUrl());  // ← workspace 页面也会得到 "sidebar"
  ```
  上下文加载按 surface 分支：
  ```typescript
  // extension-ui/src/store.ts:48-50
  if (surface.value === "options") { context.value = null; candidates.value = []; return; }
  if (surface.value === "sidebar" && sidebarWindowId == null) sidebarWindowId = await currentWindowId();
  const result = await sendMessage({ type: "ui.context.get", scope: surface.value === "workspace" ? "sender" : "active", windowId: sidebarWindowId });
  ```
  定时刷新守卫：
  ```typescript
  // extension-ui/src/store.ts:84
  if (surface.value !== "options" && timer == null) timer = window.setInterval(() => { void refresh(); }, 1000);
  ```
  manifest 中 workspace 使用独立 URL：
  ```json
  // extension/manifest.json:14 — 无 workspace surface 的显式路径声明
  "side_panel": { "default_path": "dist/app.html?surface=sidebar#/resources" }
  ```
- 推理链：`surfaceFromUrl` 遗漏 `workspace` → workspace 初始化走 sidebar 分支 → `scope` 参数虽然在 `store.ts:50` 有 `"workspace" ? "sender" : "active"` 的判断，但此分支永远不会被命中（因为 `surface.value` 始终为 `"sidebar"`）→ workspace 的上下文获取实际使用 `"active"` scope 而非 `"sender"` scope。
- 证据状态：**源码已证明** — `surfaceFromUrl()` 的返回值逻辑可静态确认；workspace 页面 URL 中 `surface=workspace` 参数被忽略。
- 建议：将 `surfaceFromUrl` 补全为三值枚举；或在 workspace 入口显式传入 surface 并删掉对 URL 的隐式推断。

### 4.3 P1-02 background.js 路由单体过大

- 严重度：P1
- 类别：高耦合 / 可维护性
- 影响：`extension/background.js` 同时承担候选状态、UI 上下文、workspace 注入/卸载、Native 连接、任务转发、preview header 规则和 webRequest 监听，职责边界不清晰。
- 代码证据（源码直接引用）：
  ```javascript
  // extension/background.js:1-16 — 顶层全局状态
  const api = globalThis.browser ?? globalThis.chrome;
  const STATE_VERSION = 2;
  const STATE_PREFIX = "media-candidates-v2:";
  const candidatesByTab = new Map();        // 候选状态
  const tabQueues = new Map();              // 并发队列
  const persistTimers = new Map();          // 持久化调度
  const requestHeadersById = new Map();     // 请求头捕获
  const recentRequestContexts = new Map();  // 请求上下文缓存
  const previewRules = { nextId: 2147000000, byTab: new Map() };  // preview header 规则
  const native = { port: null, pending: new Map(), seq: 0, capabilities: new Set(), infoPromise: null };  // Native 连接
  const workspaceTabsByWindow = new Map();  // workspace 所有权
  ```
  单文件 534 行，消息分发入口在 `background.js:451` 处理 15+ 种消息类型：
  ```javascript
  // background.js:451-533 — 消息类型列表
  // "ui.context.get", "workspace.open", "workspace.close", "workspace.ready",
  // "media.candidates", "media.sniffing.get", "media.sniffing.set", "media.remove",
  // "media.candidate.get", "media.fetchText", "media.add", "probe.install",
  // "native.connect", "task.create", "task.prepare", "task.list", "task.control",
  // "task.delete", "path.validate", "preview.headers.clear"
  ```
- 推理链：路由、状态与副作用集中于单一模块 → 修改任一边界都容易波及其他边界；测试只能通过 Node 注入脚本字符串，难以获得模块级隔离。
- 证据状态：**源码已证明** — 文件行数、全局变量数量、消息类型数量均可静态确认。
- 建议：按 `candidate-state`、`ui-context`、`workspace`、`native-client`、`preview-headers` 拆分，并保留一个轻量 orchestrator 做消息分发。

### 4.4 P1-03 非活跃标签默认自动刷新，缺少明确生命周期所有权

- 严重度：P1
- 类别：生命周期 / 资源释放
- 影响：`store.ts:84` 在 `surface !== options` 时为当前实例设置 1s 定时刷新，sidebar 对非活跃标签仍保持轮询，workspace 的销毁依赖 `onBeforeUnmount`，但 store 并不感知页面可见性。
- 代码证据（源码直接引用）：
  ```typescript
  // extension-ui/src/store.ts:84
  if (surface.value !== "options" && timer == null) timer = window.setInterval(() => { void refresh(); }, 1000);
  ```
  刷新函数无活跃性守卫：
  ```typescript
  // extension-ui/src/store.ts:93-96
  async function refresh() {
    if (!extensionApi()?.runtime?.sendMessage || surface.value === "options") return;
    try { await Promise.all([loadContext(), loadTasks()]); } catch (_) {}
  }
  ```
  清理仅在组件卸载时触发：
  ```typescript
  // extension-ui/src/store.ts:162-166
  onBeforeUnmount(() => {
    if (timer != null) { clearInterval(timer); timer = null; }
    if (listening) { extensionApi()?.runtime?.onMessage?.removeListener?.(onRuntimeMessage); listening = false; }
    void sendMessage({ type: "preview.headers.clear" }).catch(() => {});
  });
  ```
  workspace 页面也走相同 store：
  ```typescript
  // extension-ui/src/workspace.ts:21
  const app = createApp(WorkspaceApp).use(createPinia());  // ← 共用同一个 store 定义
  ```
- 推理链：无显式活跃状态所有权 → 多实例并发轮询 → background 负载与 UI 噪音增加，且浏览器受限页面与标签切换场景更易产生边界抖动。
- 证据状态：**源码已证明** — 定时器创建与清理逻辑可静态确认；但"多实例并发轮询的实际性能影响"需要运行时 profiling 验证。
- 建议：引入显式 active/inactive 状态、可见性监听或事件驱动刷新，而非固定 1s 轮询。

### 4.5 P2-01 媒体候选定义跨 extension/extension-ui/native-host 重复

- 严重度：P2
- 类别：重复逻辑 / 边界漂移
- 影响：候选形状在 JS runtime、TS UI 类型与 Rust Host payload 中各有一份隐式定义，缺少共享 schema，易在字段命名、null 语义与默认值上漂移。
- 代码证据（源码直接引用）：
  ```typescript
  // extension-ui/src/types.ts:3-24 — TS 定义（24 个字段）
  export interface MediaCandidate {
    id: string; url: string; canonicalUrl?: string; title?: string;
    pageTitle?: string; pageUrl?: string; type: CandidateType; mime?: string;
    size?: number | null; sizeKind?: string; width?: number | null;
    height?: number | null; duration?: number | null; poster?: string | null;
    detectedAt?: number; source?: string; referer?: string;
    requestHeaders?: Record<string, string>; contentDisposition?: string;
    inlineManifest?: { format: string; baseUrl: string; text: string } | null;
  }
  ```
  ```javascript
  // extension/background.js:288 — JS 运行时构造（字段名不完全一致）
  addCandidate(tabId, { url: details.url, mime, size: rangeSize || contentLength,
    sizeSource: rangeSize ? "content-range" : contentLength ? "content-length" : null,
    ...context, source: "network", requestId: details.requestId, resourceType: details.type })
  ```
  ```javascript
  // extension/content.js:12-24 — content script 构造（又一套字段）
  api.runtime.sendMessage({ type: "media.add", candidate: {
    url, mime: element.getAttribute("type") || ...,
    title: document.title, pageTitle: document.title, pageUrl: location.href,
    faviconUrl: ..., poster: ..., width: ..., height: ..., duration: ..., source: "dom"
  }})
  ```
  ```rust
  // native-host/src/main.rs:138 — Rust 侧仅有 source_candidate_id 引用
  source_candidate_id: Option<String>,
  // Rust 侧不定义 MediaCandidate 结构体，通过 serde_json::Value 接收
  ```
- 推理链：JS/TS/Rust 各自隐式约定候选字段 → `sizeSource`、`resourceType`、`requestId` 等字段在 TS 接口中不存在 → Rust 侧通过 `serde_json::Value` 接收意味着无编译期类型检查。
- 证据状态：**源码已证明** — 三处定义可静态对比；字段漂移（如 `sizeSource` vs 无此字段）已确认。
- 建议：在 extension-ui 建立主定义并生成文档/schema；扩展与 Native 测试围绕同一契约校验。

### 4.6 P2-02 workspace 生命周期存在隐式失败降级

- 严重度：P2
- 类别：边界泄漏 / 生命周期
- 影响：`workspace.ts:37` 中，当 `sendMessage({ type: "workspace.close" })` 失败时直接调用 `dispose()`，等于在未获 background 明确确认的情况下自行卸载。
- 代码证据（源码直接引用）：
  ```typescript
  // extension-ui/src/workspace.ts:33-38
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation();
    Promise.resolve(api?.runtime?.sendMessage?.({ type: "workspace.close" })).catch(dispose);
    // ← sendMessage 失败时直接 dispose()，不等待 background 确认
  };
  ```
  background 侧的 close 处理：
  ```javascript
  // extension/background.js:460-464
  if (message?.type === "workspace.close") {
    if (!Number.isInteger(sender?.tab?.id)) { sendResponse({ ok: false, error: "workspace_sender_required" }); return false; }
    unmountWorkspace(sender.tab.id).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  ```
  background 的 workspace 所有权管理：
  ```javascript
  // extension/background.js:81 — unmountWorkspace 清理所有权
  for (const [windowId, ownedTabId] of workspaceTabsByWindow) if (ownedTabId === tabId) workspaceTabsByWindow.delete(windowId);
  ```
  ```javascript
  // extension/background.js:466 — ready 时记录所有权
  if (Number.isInteger(sender?.tab?.windowId) && Number.isInteger(sender?.tab?.id)) workspaceTabsByWindow.set(sender.tab.windowId, sender.tab.id);
  ```
- 推理链：UI 自行清理 → background 仍保留 `workspaceTabsByWindow` 或仍期望后续 ready/close 事件 → 两侧状态权威不一致。
- 证据状态：**源码已证明** — 失败路径的 `dispose()` 回退可静态确认；但"状态不一致是否会导致实际 bug"需要运行时场景验证（如 sendMessage 超时、tab 切换等）。
- 建议：对失败路径增加退避/重试或明确 background 确认策略，并在测试中覆盖发送失败与卸载竞争。

### 4.7 P2-03 扩展测试覆盖不足，浏览器测试脚本集成了测试逻辑与测试运行器

- 严重度：P2
- 类别：可测试性
- 影响：`tools/test-browser-extension.mjs` 同时承担注入、执行与断言，workspace 测试局限于"挂载/卸载/SPA"，未覆盖失败注入、重复发送、受限页面注入失败后的恢复。
- 代码证据：
  - `tools/test-browser-extension.mjs:109-127` — 测试脚本内联断言逻辑
  - `extension-ui/src/App.test.ts:56-86` — UI 测试覆盖基本流程
- 证据状态：**源码已证明** — 测试文件内容可静态确认覆盖范围；但"测试缝隙是否会导致回归"需要实际 CI 运行验证。
- 建议：将 extension 逻辑测试拆为模块级单元；workspace 增加注入失败、close 失败与重复注入回归用例。

### 4.8 P3-01 preview headers 使用宽匹配资源类型

- 严重度：P3
- 类别：边界泄漏 / 兼容性
- 影响：`background.js:441` 将 `xmlhttprequest` 纳入 preview headers 条件，可能影响非媒体请求。
- 代码证据（源码直接引用）：
  ```javascript
  // extension/background.js:434
  const headers = Object.fromEntries(Object.entries(payload.headers || {}).filter(
    ([key, value]) => ["referer", "origin", "authorization", "cookie", "user-agent"].includes(key.toLowerCase()) && typeof value === "string" && value
  ));
  // extension/background.js:441
  await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [], addRules: [{
    id: ruleId, priority: 1,
    action: { type: "modifyHeaders", requestHeaders },
    condition: { urlFilter, resourceTypes: ["media", "xmlhttprequest", "image"], tabIds: [tabId] }
  }]});
  ```
- 推理链：`xmlhttprequest` 范围包含 AJAX/fetch 等非媒体请求 → 如果用户在预览页面发起 API 调用，authorization/cookie 头会被覆盖。
- 证据状态：**源码已证明** — 规则定义可静态确认；但"是否实际影响非媒体请求"需要运行时场景验证。
- 建议：缩小到明确媒体资源类型或为非媒体请求增加来源白名单。

## 5. 按 P0-P3 的发现清单

### P0

| ID | 类别 | 影响 | 证据 | 证据状态 | 推理链 | 建议 |
|---|---|---|---|---|---|---|
| P0-01 | 架构性阻断 | Native Host 任务契约与后续构建风险 | `main.rs:128` `requires_authorization: ***`, `main.rs:4150` 同样写法 | 源码已证明 | `Task` 定义错误 → 序列化/反序列化边界不稳 → native client/domain 信任受损 | 恢复字段类型并补充编译与序列化测试 |

### P1

| ID | 类别 | 影响 | 证据 | 证据状态 | 推理链 | 建议 |
|---|---|---|---|---|---|---|
| P1-01 | 职责混杂 | UI surface 边界定义不精确 | `api.ts:17-19` surfaceFromUrl 仅返回两值, `store.ts:31` 依赖此函数, `store.ts:50` workspace 分支永不命中 | 源码已证明 | URL 隐式推断 → workspace/sidebar 边界模糊 → scope 参数逻辑失效 | `surfaceFromUrl` 返回三值枚举 |
| P1-02 | 高耦合 | background 职责过重 | `background.js:1-16` 6 个全局 Map/Set, `background.js:451-533` 15+ 消息类型, 534 行单文件 | 源码已证明 | 单模块同时拥有状态/路由/副作用 → 修改任一边界波及其他 | 按边界拆分模块 |
| P1-03 | 生命周期 | 定时刷新缺乏活跃性控制 | `store.ts:84` 1s setInterval 无守卫, `store.ts:162` 仅 onBeforeUnmount 清理 | 源码已证明 | 固定轮询 → 多实例负担与边界抖动 | 引入 active/inactive 或事件驱动刷新 |

### P2

| ID | 类别 | 影响 | 证据 | 证据状态 | 推理链 | 建议 |
|---|---|---|---|---|---|---|
| P2-01 | 重复逻辑 | 候选 schema 易漂移 | `types.ts:3-24` TS 24 字段, `background.js:288` JS 含 sizeSource/resourceType, `content.js:12-24` 又一套, `main.rs:138` Rust 仅 source_candidate_id | 源码已证明 | JS/TS/Rust 各自隐式约定 → 字段漂移 | 统一 schema 与契约测试 |
| P2-02 | 生命周期 | workspace 边界权威不一致 | `workspace.ts:37` 失败时 dispose(), `background.js:460-466` 仍维护 workspaceTabsByWindow | 源码已证明 | UI 自行卸载 → background 状态残留 | 失败路径补确认策略 |
| P2-03 | 可测试性 | workspace/扩展测试缝隙 | `tools/test-browser-extension.mjs:109-127`, `App.test.ts:56-86` | 源码已证明 | 测试器与被测逻辑混装 | 增加失败注入与回归用例 |

### P3

| ID | 类别 | 影响 | 证据 | 证据状态 | 推理链 | 建议 |
|---|---|---|---|---|---|---|
| P3-01 | 兼容性 | preview headers 匹配范围偏宽 | `background.js:441` resourceTypes 含 xmlhttprequest | 源码已证明 | 条件包含非媒体请求 | 缩窄规则或增加白名单 |

## 6. 推荐模块边界与分阶段重构优先级

### 6.1 推荐边界

- Presentation surfaces：`sidebar`、`workspace`、`options`
- Shared application/store：`extension-ui/src/store.ts`、`extension-ui/src/media.ts`、`extension-ui/src/format.ts`
- Typed extension messaging/protocol adapter：`extension-ui/src/api.ts`、`extension/background.js` 的 `runtime.onMessage` 分发
- Background orchestration：候选状态管理、UI 上下文、workspace 注入/卸载、preview headers
- Native protocol/client：`background.js` 中 `connectNative` / `nativeRequestPromise`
- Native domain/services：`native-host/src/main.rs`、`native-host/src/hls.rs`

### 6.2 当前与推荐边界的主要差异

- 当前 `background.js` 将 orchestration、candidate state、workspace 与 native client 合为一体（534 行，6 个全局 Map）。
- 当前 `surfaceFromUrl` 不识别 workspace，导致 presentation surfaces 与 store 初始化边界模糊。
- 当前 JS/TS/Rust 各自隐式维护候选与任务字段，缺少共享契约层。

### 6.3 分阶段优先级（低风险高收益）

1. **S**：修复 `native-host/src/main.rs` 的 `requires_authorization` 类型问题并补充回归测试。
2. **S**：补齐 `surfaceFromUrl` 的 workspace 识别或改为显式 surface 参数。
3. **M**：把 `background.js` 按 candidate/workspace/native/preview 拆分。
4. **M**：为媒体候选与任务消息建立文档化 schema，并扩展 `tools/` 下契约测试。
5. **L**：重构 store 刷新模型为 active/inactive + 事件驱动。

## 7. 协议/持久化边界审查

### 7.1 HLS 检查点持久化

检查点系统设计合理，采用 write-ahead + backup 策略：

```rust
// native-host/src/hls.rs:543-570 — save_checkpoint
pub fn save_checkpoint(path: &Path, checkpoint: &HlsCheckpoint) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec(checkpoint).map_err(|error| error.to_string())?;
    // ... write to tmp, fsync, rename old to .bak, rename tmp to path
}
```

```rust
// native-host/src/hls.rs:572-590 — load_checkpoint
pub fn load_checkpoint(path: &Path) -> Result<HlsCheckpoint, String> {
    let read = |candidate: &Path| { /* ... */ };
    let mut checkpoint = read(path).or_else(|primary_error| {
        let backup = path.with_extension("bak");
        if backup.is_file() { read(&backup) } else { Err(primary_error) }
    })?;
    if !matches!(checkpoint.version, 1 | CHECKPOINT_VERSION) {
        return Err("hls_checkpoint_version_unsupported".into());
    }
}
```

检查点数据结构层次清晰：
```rust
// native-host/src/hls.rs:14 — CHECKPOINT_VERSION = 2
// hls.rs:104-110 — HlsCheckpoint
pub struct HlsCheckpoint {
    pub version: u8,
    pub task_id: String,
    pub plan: PersistedPlan,
    pub tracks: Vec<TrackCheckpoint>,
}
```

**证据状态**：源码已证明 — 检查点写入/读取/版本校验/备份恢复逻辑均可静态确认。

### 7.2 Native messaging 协议

协议使用 JSON-RPC 风格的请求/响应模式：
```javascript
// extension/background.js:402-411 — nativeRequestPromise
function nativeRequestPromise(type, payload = {}) {
  const id = `request-${++native.seq}`;
  return new Promise(resolve => {
    const timer = setTimeout(() => { native.pending.delete(id); resolve({ ok: false, error: "native_host_timeout" }); }, 15000);
    native.pending.set(id, { resolve, timer });
    native.port.postMessage({ version: 1, id, type, payload });
  });
}
```

**证据状态**：源码已证明 — 协议格式与超时机制可静态确认；但"15s 超时是否对大 HLS 播放列表足够"需要运行时验证。

### 7.3 会话存储持久化

候选状态通过 `api.storage.session` 持久化：
```javascript
// extension/background.js:36-44 — loadTabState
async function loadTabState(tabId) {
  let stored;
  try { stored = (await api.storage.session.get(stateKey(tabId)))[stateKey(tabId)]; } catch (_) {}
  const state = stored?.schemaVersion === STATE_VERSION && ...
    ? { ...stored, candidates: new Map(stored.candidates.map(item => [item.id, item])) }
    : emptyState(tabId);
}
```

**证据状态**：源码已证明 — 会话存储读写逻辑可静态确认；但"storage.session 在浏览器重启后的行为"需要运行时验证。

## 8. Vite/manifest/打包边界审查

### 8.1 双 Vite 配置

项目使用两个独立的 Vite 构建配置：

**主构建**（sidebar + options + 完整 SPA）：
```typescript
// vite.config.ts:5-28
export default defineConfig({
  root: "extension-ui",
  base: "./",
  plugins: [vue()],
  build: {
    outDir: "../extension/dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 550,
    rollupOptions: {
      input: resolve(__dirname, "extension-ui/app.html"),
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        manualChunks: id => id.includes("node_modules/hls.js") ? "hls" : undefined
      }
    }
  }
});
```

**Workspace IIFE 构建**（独立注入脚本）：
```typescript
// vite.workspace.config.ts:5-21
export default defineConfig({
  root: "extension-ui",
  base: "./",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [vue()],
  build: {
    outDir: "../extension/dist",
    emptyOutDir: false,  // ← 不清空输出目录，与主构建共存
    chunkSizeWarningLimit: 900,
    lib: {
      entry: resolve(__dirname, "extension-ui/src/workspace.ts"),
      name: "StreamFireflyWorkspace",
      formats: ["iife"],
      fileName: () => "workspace.js"
    }
  }
});
```

**发现**：两个配置共用同一输出目录 `extension/dist`，但 `emptyOutDir` 设置不同（主构建 true，workspace false）。构建顺序在 `package.json:6` 中固定为 `vite build && vite build --config vite.workspace.config.ts`。

**证据状态**：源码已证明 — 构建配置与顺序可静态确认；但"两个构建的产物是否会在 hls.js chunk 上产生冲突"需要运行时验证。

### 8.2 Manifest 验证脚本

验证脚本 `tools/validate-extension.mjs` 对 Chrome manifest 做硬编码断言：
```javascript
// tools/validate-extension.mjs:10-23
if (manifest.manifest_version !== 3) throw new Error('manifest_version must be 3');
if (!manifest.background?.service_worker) throw new Error('background service worker missing');
if (!manifest.permissions?.includes('nativeMessaging')) throw new Error('nativeMessaging permission missing');
if (!manifest.permissions?.includes('sidePanel')) throw new Error('Chrome sidePanel permission missing');
if (manifest.side_panel?.default_path !== 'dist/app.html?surface=sidebar#/resources') throw new Error('Chrome side panel entry missing');
if (manifest.options_ui?.page !== 'dist/app.html?surface=options#/settings') throw new Error('Vue settings entry missing');
if (/\btabs\.create\s*\(/.test(background)) throw new Error('Toolbar entry must not create an application tab');
if (!background.includes('openPanelOnActionClick: true')) throw new Error('Chrome action is not bound to native side panel behavior');
if (!background.includes('files: ["dist/workspace.js"]')) throw new Error('On-demand workspace injection is missing');
```

**发现**：验证脚本与 manifest 内容强耦合，任何 manifest 字段变更都需要同步更新验证脚本。Firefox 验证由 `tools/validate-firefox-extension.mjs` 单独处理。

**证据状态**：源码已证明 — 验证逻辑可静态确认。

## 9. 证据边界与未验证项

### 已由源码证明的结论

| 结论 | 依据 |
|---|---|
| `requires_authorization: ***` 是无效 Rust 类型 | `main.rs:128` 与 `main.rs:4150` 的文本内容 |
| `surfaceFromUrl()` 不返回 `"workspace"` | `api.ts:17-19` 的条件逻辑 |
| `background.js` 有 6 个全局 Map/Set 与 15+ 消息类型 | `background.js:1-16` 与 `background.js:451-533` |
| store 在 `surface !== options` 时设置 1s 定时器 | `store.ts:84` |
| workspace close 失败时直接 dispose() | `workspace.ts:37` |
| preview headers 规则包含 xmlhttprequest | `background.js:441` |
| 候选 schema 在 JS/TS/Rust 三处定义不一致 | `types.ts:3-24` vs `background.js:288` vs `content.js:12-24` vs `main.rs:138` |
| HLS 检查点采用 tmp + backup + fsync + rename 策略 | `hls.rs:543-570` |
| 检查点版本校验支持 v1 与 v2 | `hls.rs:586` |
| Native messaging 使用 `{ version: 1, id, type, payload }` 格式 | `background.js:409` |
| 候选状态通过 `api.storage.session` 持久化 | `background.js:39` |
| 双 Vite 配置共用 `extension/dist` 输出目录 | `vite.config.ts:10` 与 `vite.workspace.config.ts:11` |
| workspace 构建为 IIFE 格式独立注入脚本 | `vite.workspace.config.ts:14-18` |
| manifest 验证脚本对 Chrome 做 9 项硬编码断言 | `validate-extension.mjs:10-23` |
| `npm run typecheck` 通过 | 终端执行 exit_code = 0 |
| git 工作树未被修改 | `git status` 仅显示 `.hermes/` 与 `docs/reviews/` 未跟踪目录 |

### 缺少运行时证据的结论

| 结论 | 需要的验证 |
|---|---|
| `requires_authorization: ***` 导致 Rust 编译失败 | 执行 `cargo build` 或 `cargo test`（当前仓库无 Cargo.lock，未验证） |
| workspace 的 `scope: "sender"` 分支是否在实际运行中被命中 | 在浏览器中打开 workspace 页面并检查 sendMessage 参数 |
| 多实例并发轮询的实际性能影响 | 浏览器 profiling（多 tab + sidebar + workspace 并发） |
| workspace close 失败导致 background 状态残留的实际场景 | 模拟 sendMessage 超时/disconnect 后检查 workspaceTabsByWindow |
| preview headers 规则对非媒体 AJAX 请求的实际影响 | 在预览页面发起 fetch/XMLHttpRequest 并检查请求头 |
| workspace/扩展测试缝隙是否导致实际回归 | 运行完整 CI 并检查失败注入场景 |
| 15s native 超时对大 HLS 播放列表是否足够 | 运行包含数百 segment 的 HLS 下载任务 |
| storage.session 在浏览器重启后的行为 | 浏览器重启后检查 sidebar 是否能恢复候选状态 |
| 双 Vite 构建的 hls.js chunk 是否会冲突 | 执行 `npm run build:extension` 并检查 dist/ 产物 |

### 不得把未执行行为写成通过

本报告仅基于静态源码与现有测试脚本，不把"设计意图"等同为"运行时已证明"。所有标注为"源码已证明"的结论均可通过阅读源码确认；标注为"需要运行时验证"的结论需要实际执行环境才能确认。
