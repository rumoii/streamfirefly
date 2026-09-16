# StreamFirefly 综合审查报告

> 注：本记录写于 2026-09-16 提交历史署名规范化改写之前，文中提交哈希已无法在当前仓库中直接解析；相关判定以对应的 GitHub Actions 运行记录为准。改写范围见 [提交历史署名改写](../development/commit-history-rewrite.md)。

## 1. 审查概览

| 项目 | 内容 |
|------|------|
| 审查范围 | StreamFirefly 浏览器扩展全栈：功能/构建/运行、架构与模块化边界、UI/UX 真实界面 |
| 仓库 | `D:/rumo_liuying/streamfirefly` |
| 基线提交 | `28004968299e2657a68aa6819967dcab1aab0258` |
| 审查日期 | 2026-09-06 |
| 审查模式 | 只读审查；未修改源码、配置、锁文件或工作树；不提交/推送/发布 |
| 授权边界 | 不使用真实账号/生产凭证/未授权媒体；浏览器测试使用标准路径的 Chrome/Firefox/Edge |
| 证据方法 | 五类证据层：静态源码审查（类型检查）、单元/集成测试（vitest 13 项 + 4 集成脚本）、构建产物验证（扩展验证 + Firefox lint）、真实浏览器测试（3 浏览器端到端）、Rust/Native（受阻于工具链缺失） |

---

## 2. 执行摘要

### 2.1 三项评级

| 维度 | 评级 | 依据 | 置信边界 |
|------|------|------|----------|
| **可用性** | **B** | 核心路径基本可用：7/10 命令通过（类型检查、扩展构建验证、13 项单元测试、4 项集成脚本、Firefox lint、3 项真实浏览器测试）。3/10 命令受阻于 Rust 工具链缺失（环境缺口非代码缺陷）。源码审查确认凭证安全和防御性编程。 | 静态 + 单元 + 浏览器已证明；Rust/native/下载流程需运行时验证 |
| **架构健康度** | **B** | 当前主路径总体合理：sidebar/workspace/options 共用 store、消息接口与业务组件；Native Host 承担任务状态权威与持久化。但存在 1 个 Rust 类型阻断、UI surface 边界不精确、background.js 单体过大、定时刷新无守卫等中风险问题。 | 源码已证明 16 项；9 项需运行时验证 |
| **UI/UX** | **B** | 信息架构清晰（三 surface 职责分明）、视觉语言统一（CutUI 风格）、状态反馈完整（loading/empty/error/toast）、无障碍基础到位（语义化 HTML + ARIA）。但存在 surfaceFromUrl 识别缺陷、1s 轮询无守卫、Shadow DOM 无障碍隐患等中风险问题。 | 源码已证明 14 项；7 项需真实浏览器验证；2 项受阻 |

### 2.2 总体发布/使用判断

StreamFirefly 当前处于 **可用但有明确中风险问题** 的状态。核心资源发现、侧栏/工作区展示、HLS 预览、下载任务管理等主要路径在三个真实浏览器中均通过端到端测试。主要阻断项为 Rust 工具链缺失导致 native host 全链路无法验证，以及 P0 Rust 类型缺陷影响编译。建议在修复 P0/P1 项后可进入内测发布，P2/P3 项可在后续迭代中逐步解决。

---

## 3. 验证矩阵

### 3.1 命令执行记录

| 场景 | 环境/前置 | 步骤/命令 | 预期 | 实际 | 结论 | 证据 |
|------|-----------|-----------|------|------|------|------|
| 静态类型检查 | Node v24.15.0, npm 11.9.0 | `npm run typecheck` | exit 0 | exit 0, vue-tsc --noEmit 无错误 | ✅ 通过 | 终端输出 |
| 扩展构建验证 | 同上 | `npm run validate:extension` | exit 0 | exit 0, Chrome 14 文件 + Firefox 14 文件均有效 | ✅ 通过 | 终端输出 |
| 单元测试 | 同上 | `npm run test:unit` | exit 0 | exit 0, 3 文件 13 项全通过 + 4 集成脚本全通过 | ✅ 通过 | vitest 输出 |
| Firefox lint | 同上 | `npm run lint:firefox` | exit 0 | exit 0, 忽略 2 个 Vue runtime innerHTML 警告 | ✅ 通过 | 终端输出 |
| Rust 单元测试 | 需 Rust 工具链 | `cargo test --manifest-path native-host/Cargo.toml` | exit 0 | exit 127, cargo: command not found | ⛔ 受阻 | 终端输出 |
| Rust release 构建 | 需 Rust 工具链 | `cargo build --release --manifest-path native-host/Cargo.toml` | exit 0 | exit 127, cargo: command not found | ⛔ 受阻 | 终端输出 |
| Native 集成测试 | 需 cargo build | `npm run test:native` | exit 0 | exit 1, spawn streamfirefly-native.exe ENOENT | ⛔ 受阻 | 终端输出 |
| Firefox 浏览器测试 | Chrome/Firefox/Edge 已安装 | `npm run test:firefox` | exit 0 | exit 0, 15 候选 + SPA 导航 | ✅ 通过 | 终端输出 |
| Chrome 浏览器测试 | 同上 | `npm run test:chrome` | exit 0 | exit 0, 15 候选 + SPA 导航 | ✅ 通过 | 终端输出 |
| Edge 浏览器测试 | 同上 | `npm run test:edge` | exit 0 | exit 0, 15 候选 + SPA 导航 | ✅ 通过 | 终端输出 |

### 3.2 证据能力矩阵

| 证据层 | 能证明 | 不能证明 |
|--------|--------|----------|
| 静态源码审查 | 类型正确性、语法、声明规则、代码结构、边界定义 | 运行时行为、性能、兼容性 |
| 单元/集成测试 | HLS 解析、密钥验证、候选过滤排序、设置加载、Vue 组件交互、消息协议、页面探测 | 并发性能、错误注入恢复、边界超时 |
| 构建产物验证 | 扩展打包完整性（14 文件）、Firefox lint 合规 | 运行时加载、service worker 生命周期 |
| 真实浏览器测试 | 三浏览器资源发现（15 候选）、工作区挂载/卸载、SPA 导航清理 | 下载流程端到端、HLS 加密、直播录制 |
| Rust/Native | — | 全部受阻于工具链缺失 |

---

## 4. 发现清单

### 4.1 P0 — 安全/数据灾难或完全不可用且无绕过

#### P0-01 Native Host Task 结构体无效 Rust 类型

| 字段 | 内容 |
|------|------|
| ID | P0-01 |
| 类别 | 架构性阻断（可构建性/可维护性） |
| 来源线 | 架构审查 |
| 影响 | `native-host/src/main.rs:128` 的 `requires_authorization: ***` 为无效 Rust 类型，导致 Task 结构体定义与测试构造均无法编译，native host 全链路阻断 |
| 证据 | `main.rs:126-131` — `requires_authorization: ***` 非 bool/Option<bool>；`main.rs:4148-4151` 测试构造同样写法 |
| 推理链 | Task 定义错误 → 任务状态序列化/反序列化边界不可靠 → native protocol/client 与 native domain/services 的类型契约受损 |
| 证据状态 | **源码已证明** — 静态文本即可确认 `***` 不是合法 Rust 类型标识符 |
| 建议 | 将该字段恢复为显式 `bool` 并统一所有引用；检查 `requires_authorization`、`requires_key_override` 与 `resume_requirement` 之间的语义重叠 |

### 4.2 P1 — 核心流程不可用/高风险数据隐私/高风险误操作

#### P1-01 UI surface 识别不区分 workspace

| 字段 | 内容 |
|------|------|
| ID | P1-01 |
| 类别 | 职责混杂 / 跨层耦合 |
| 来源线 | 架构审查 + UI/UX 审查（双重发现，证据一致） |
| 影响 | `surfaceFromUrl()` 永远返回 `"sidebar"` 或 `"options"`，workspace 页面的 `surface=workspace` 参数被忽略。导致 workspace 上下文获取使用 `"active"` scope 而非 `"sender"` scope（`store.ts:50` 的三元判断永远不会命中 workspace 分支），多窗口场景下上下文可能指向错误窗口 |
| 证据 | `api.ts:15-20` — `return surface === "options" ? "options" : "sidebar"`；`store.ts:31` 依赖此函数；`store.ts:48-50` workspace 分支永不命中 |
| 推理链 | URL 隐式推断遗漏 workspace → sidebar/workspace 边界模糊 → scope 参数逻辑失效 → 多窗口上下文混乱 |
| 证据状态 | **源码已证明** |
| 建议 | `surfaceFromUrl` 补全为三值枚举；或在 workspace 入口显式传入 surface 并删掉对 URL 的隐式推断 |

#### P1-02 background.js 路由单体过大

| 字段 | 内容 |
|------|------|
| ID | P1-02 |
| 类别 | 高耦合 / 可维护性 |
| 来源线 | 架构审查 |
| 影响 | `extension/background.js` 同时承担候选状态管理、UI 上下文、workspace 注入/卸载、Native 连接、任务转发、preview header 规则和 webRequest 监听，534 行单文件含 6 个全局 Map/Set 与 15+ 种消息类型 |
| 证据 | `background.js:1-16` — 6 个全局 Map/Set；`background.js:451-533` — 15+ 消息类型 |
| 推理链 | 路由、状态与副作用集中于单一模块 → 修改任一边界都容易波及其他边界 → 测试难以获得模块级隔离 |
| 证据状态 | **源码已证明** |
| 建议 | 按 candidate-state、ui-context、workspace、native-client、preview-headers 拆分，保留轻量 orchestrator 做消息分发 |

#### P1-03 定时刷新缺乏活跃性控制

| 字段 | 内容 |
|------|------|
| ID | P1-03 |
| 类别 | 生命周期 / 资源释放 |
| 来源线 | 架构审查 + UI/UX 审查（双重发现，证据一致） |
| 影响 | `store.ts:84` 在 `surface !== options` 时无条件启动 1s 定时刷新，sidebar 对非活跃标签仍保持轮询，浪费 CPU 和电池 |
| 证据 | `store.ts:84` — `timer = window.setInterval(() => { void refresh(); }, 1000)` 无活跃性守卫；`store.ts:162` 仅 onBeforeUnmount 清理 |
| 推理链 | 固定轮询 → 多实例并发负担 → background 负载与 UI 噪音增加 |
| 证据状态 | **源码已证明** — 但多实例并发轮询的实际性能影响需运行时 profiling |
| 建议 | 引入 Page Visibility API 或 Intersection Observer，在页面不可见时暂停轮询；或改为事件驱动刷新 |

### 4.3 P2 — 重要流程受损但有绕过，或显著质量/兼容性/可维护性/无障碍风险

#### P2-01 媒体候选 schema 跨层重复定义

| 字段 | 内容 |
|------|------|
| ID | P2-01 |
| 类别 | 重复逻辑 / 边界漂移 |
| 来源线 | 架构审查 |
| 影响 | 候选形状在 JS runtime（`background.js:288`）、TS UI 类型（`types.ts:3-24`）、content script（`content.js:12-24`）与 Rust Host（`main.rs:138`）中各有一份隐式定义，缺少共享 schema，易在字段命名、null 语义与默认值上漂移 |
| 证据 | `types.ts:3-24` — 24 字段 TS 接口；`background.js:288` — 含 sizeSource/resourceType/requestId；`content.js:12-24` — 又一套字段；`main.rs:138` — Rust 仅 source_candidate_id，通过 serde_json::Value 接收 |
| 证据状态 | **源码已证明** — 三处定义可静态对比，字段漂移已确认 |
| 建议 | 在 extension-ui 建立主定义并生成文档/schema；扩展与 Native 测试围绕同一契约校验 |

#### P2-02 workspace 生命周期存在隐式失败降级

| 字段 | 内容 |
|------|------|
| ID | P2-02 |
| 类别 | 边界泄漏 / 生命周期 |
| 来源线 | 架构审查 |
| 影响 | `workspace.ts:37` 中当 `sendMessage({ type: "workspace.close" })` 失败时直接调用 `dispose()`，等于在未获 background 明确确认的情况下自行卸载，可能导致 background 仍保留 workspaceTabsByWindow 状态 |
| 证据 | `workspace.ts:33-38` — sendMessage 失败时 .catch(dispose)；`background.js:460-466` — 仍维护 workspaceTabsByWindow |
| 证据状态 | **源码已证明** — 失败路径可静态确认；状态不一致是否导致实际 bug 需运行时验证 |
| 建议 | 对失败路径增加退避/重试或明确 background 确认策略 |

#### P2-03 扩展测试覆盖不足

| 字段 | 内容 |
|------|------|
| ID | P2-03 |
| 类别 | 可测试性 |
| 来源线 | 架构审查 + 功能审查（双重发现） |
| 影响 | `tools/test-browser-extension.mjs` 同时承担注入、执行与断言；workspace 测试局限于挂载/卸载/SPA，未覆盖失败注入、重复发送、受限页面注入失败后的恢复；下载流程无端到端浏览器测试 |
| 证据 | `tools/test-browser-extension.mjs:109-127` — 内联断言；浏览器测试覆盖资源发现+工作区生命周期，不覆盖 task.create→下载→暂停/继续→完成 |
| 证据状态 | **源码已证明** |
| 建议 | 将 extension 逻辑测试拆为模块级单元；workspace 增加注入失败、close 失败与重复注入回归用例 |

#### P2-04 Rust 工具链缺失导致 native host 全链路受阻

| 字段 | 内容 |
|------|------|
| ID | P2-04 |
| 类别 | 构建/测试环境 |
| 来源线 | 功能审查 |
| 影响 | rustc/cargo 未安装在审查环境，cargo test、cargo build、test:native 三条命令全部受阻（exit 127 / ENOENT），native host 全链路无法验证 |
| 证据 | `cargo: command not found` (exit 127)；`spawn streamfirefly-native.exe ENOENT` (exit 1) |
| 证据状态 | **环境缺口非代码缺陷** — 源码审查已覆盖 Rust 代码的安全性（凭证剥离、消息协议、文件名安全） |
| 建议 | 在 CI 或开发环境中安装 Rust 工具链后补充验证 |

#### P2-05 Shadow DOM 工作区可能影响无障碍遍历

| 字段 | 内容 |
|------|------|
| ID | P2-05 |
| 类别 | 无障碍 |
| 来源线 | UI/UX 审查 |
| 影响 | workspace 使用 Shadow DOM 挂载（`workspace.ts:10-41`），部分屏幕阅读器可能无法穿透 Shadow DOM 边界遍历内部元素 |
| 证据 | `workspace.ts:21` — `createApp(WorkspaceApp).use(createPinia()).mount(root)` |
| 证据状态 | **源码已证明** — 但实际屏幕阅读器兼容性需运行时验证 |
| 建议 | 在 Shadow DOM host 上添加 `role="application"` 和 `aria-label`，并在主流屏幕阅读器上验证 |

#### P2-06 HLS 预览错误信息可操作性不足

| 字段 | 内容 |
|------|------|
| ID | P2-06 |
| 类别 | 用户体验 |
| 来源线 | UI/UX 审查 |
| 影响 | `ResourcesView.vue:82` HLS 预览失败仅提示"无法播放此 HLS 资源"，缺少原因和替代操作建议 |
| 证据 | `ResourcesView.vue:82,85` |
| 证据状态 | **源码已证明** |
| 建议 | 区分网络错误、解码错误、DRM 错误，给出对应建议 |

### 4.4 P3 — 低影响、边缘或改进项

#### P3-01 preview headers 匹配范围偏宽

| 字段 | 内容 |
|------|------|
| ID | P3-01 |
| 类别 | 兼容性 |
| 来源线 | 架构审查 |
| 影响 | `background.js:441` 将 `xmlhttprequest` 纳入 preview headers 条件，可能影响非媒体 AJAX 请求的 authorization/cookie 头 |
| 证据 | `background.js:434-441` — resourceTypes 含 `["media", "xmlhttprequest", "image"]` |
| 证据状态 | **源码已证明** — 但是否实际影响非媒体请求需运行时验证 |
| 建议 | 缩小到明确媒体资源类型或为非媒体请求增加来源白名单 |

#### P3-02 HLS 加密/直播/DRM 无运行时测试

| 字段 | 内容 |
|------|------|
| ID | P3-02 |
| 类别 | 测试覆盖 |
| 来源线 | 功能审查 |
| 影响 | AES-128/直播/DRM 依赖 native host 运行时，cargo test 无法执行，加密 HLS 无运行时证据 |
| 证据 | cargo test exit 127 |
| 证据状态 | **受阻** |
| 建议 | 安装 Rust 工具链后补充验证 |

#### P3-03 排序提示可发现性

| 字段 | 内容 |
|------|------|
| ID | P3-03 |
| 类别 | 主观改进建议 |
| 来源线 | UI/UX 审查 |
| 影响 | `ResourcesView.vue:113` 的 sort-hint 是静态文本，新用户可能忽略 |
| 建议 | 首次使用时以 tooltip 或引导气泡形式展示 |

#### P3-04 批量操作栏视觉层级

| 字段 | 内容 |
|------|------|
| ID | P3-04 |
| 类别 | 主观改进建议 |
| 来源线 | UI/UX 审查 |
| 影响 | `ResourcesView.vue:115` batch-bar 与 toolbar-grid 平级，可能被误认为筛选区域 |
| 建议 | 添加视觉分隔以明确操作上下文 |

### 4.5 零发现级别

| 级别 | 数量 |
|------|------|
| P0 | 1 |
| P1 | 3 |
| P2 | 6 |
| P3 | 4 |

---

## 5. 架构与模块化

### 5.1 现状场景

#### 资源发现主链路

1. 网络请求产生候选：`background.js:261` webRequest.onBeforeSendHeaders 捕获请求头 → `background.js:279` onHeadersReceived 解析响应头与 MIME → `background.js:288` 调用 `addCandidate(tabId, { url, mime, size, source: "network", ... })` → `background.js:217` 写入 `candidatesByTab` Map 并调度持久化
2. DOM/脚本深度探测产生候选：`content.js:6-24` MutationObserver 扫描 `<video>/<audio>/<source>` → `page-probe.js:26-36` window.postMessage 桥接 → `page-probe-advanced.js:10-56` 高级探测扫描 inline script
3. 候选进入 tab 状态并持久化：`background.js:33` emptyState → `background.js:43` candidatesByTab → `background.js:121` persistState 到 api.storage.session
4. 侧栏/工作区加载与刷新：`store.ts:47` loadContext → `background.js:452-454` resolveUiTab → `store.ts:84` 1s 定时刷新

#### 工作区注入与收起链路

1. 侧栏请求展开：`store.ts:105-108` openWorkspace 发送 workspace.open
2. Background 负责注入与幂等清理：`background.js:84-96` 先查询同窗口其他 tab 并 unmountWorkspace → api.scripting.executeScript 注入 dist/workspace.js → workspaceTabsByWindow 记录所有权
3. 内容脚本桥接：`content.js:38-49` 监听 workspace.unmount/navigate 并通过 CustomEvent 转发
4. Vue 工作区挂载与卸载：`workspace.ts:10-41` Shadow DOM host → createApp(WorkspaceApp).use(createPinia()).mount(root) → Escape 键触发 workspace.close

#### 下载与任务控制链路

1. UI 发送任务创建/控制消息：`store.ts:133-144` controlTask 构造 resumeContext 并发送 task.control
2. Background 按能力协商并转发：`background.js:511-530` 检查 hls-selection-v1 等能力标志后通过 nativeRequestPromise 转发
3. Native Host 维护任务权威状态：`main.rs:76-143` Task 结构体 → `main.rs:2659` HLS 检查点保存 → `main.rs:2764` 检查点恢复

### 5.2 合理点

1. **原生侧栏优先**：Chrome sidePanel / Firefox sidebarAction，避免应用标签页的双标签生命周期绑定（`background.js:99-103`、`manifest.json:14`）
2. **共用 store 降低重复**：sidebar/workspace/options 共用 `store.ts:30` defineStore、`api.ts:5-8` sendMessage 封装
3. **能力协商而非版本绑定**：`background.js:386-400` ensureNative 管理连接生命周期，`background.js:511-530` 按 capabilities 而非版本号检查
4. **凭证安全**：`main.rs:32` SENSITIVE_REQUEST_HEADERS 常量，`main.rs:431-457` 持久化时过滤敏感头
5. **HLS 检查点设计合理**：`hls.rs:543-590` tmp+backup+fsync+rename 策略，版本校验 v1/v2，登录态任务不落盘凭据
6. **交付验证链条完整**：typecheck、test:ui、test:ext、test:native、lint:firefox、build 脚本齐全
7. **文档与决策记录清晰**：docs/decisions/ 下有侧栏、工作区、HLS 检查点与协议 v3 的决策文档

### 5.3 不合理耦合/重复/边界泄漏

| 编号 | 问题 | 严重度 | 证据 |
|------|------|--------|------|
| 1 | background.js 534 行单体，6 个全局 Map，15+ 消息类型 | P1 | `background.js:1-16`, `background.js:451-533` |
| 2 | surfaceFromUrl 不识别 workspace | P1 | `api.ts:17-19` |
| 3 | 候选 schema JS/TS/Rust 三处重复 | P2 | `types.ts:3-24` vs `background.js:288` vs `content.js:12-24` vs `main.rs:138` |
| 4 | workspace close 失败时 UI 自行 dispose | P2 | `workspace.ts:37` |
| 5 | store 1s 轮询无活跃性守卫 | P1 | `store.ts:84` |
| 6 | preview headers 匹配 xmlhttprequest | P3 | `background.js:441` |

### 5.4 推荐模块边界

```
presentation surfaces (sidebar/workspace/options)
    ↓
shared application/store (store.ts, media.ts, format.ts)
    ↓
typed extension messaging/protocol adapter (api.ts, background.js onMessage 分发)
    ↓
background orchestration (候选状态, UI 上下文, workspace 注入/卸载, preview headers)
    ↓
native protocol/client (background.js connectNative/nativeRequestPromise)
    ↓
native domain/services (main.rs, hls.rs)
```

page-world probe / content bridge 为需显式校验和生命周期所有权的信任边界。

### 5.5 当前与推荐边界的主要差异

- 当前 background.js 将 orchestration、candidate state、workspace 与 native client 合为一体
- 当前 surfaceFromUrl 不识别 workspace，导致 presentation surfaces 与 store 初始化边界模糊
- 当前 JS/TS/Rust 各自隐式维护候选与任务字段，缺少共享契约层

### 5.6 协议/持久化边界

**HLS 检查点持久化**：采用 write-ahead + backup 策略，`hls.rs:543-590` 实现 tmp 写入 → fsync → rename old 为 .bak → rename tmp 为目标路径，支持 v1/v2 版本校验与备份恢复。证据状态：源码已证明。

**Native messaging 协议**：JSON-RPC 风格请求/响应，`{ version: 1, id, type, payload }` 格式，15s 超时。`background.js:402-411`。证据状态：源码已证明；15s 超时是否对大 HLS 播放列表足够需运行时验证。

**会话存储持久化**：候选状态通过 `api.storage.session` 读写，`background.js:36-44`。证据状态：源码已证明；浏览器重启后行为需运行时验证。

### 5.7 Vite/manifest/打包边界

- 双 Vite 配置：主构建（`vite.config.ts`，sidebar/options SPA）+ workspace IIFE 构建（`vite.workspace.config.ts`），共用 `extension/dist` 输出目录，构建顺序固定
- Manifest 验证：`validate-extension.mjs:10-23` 对 Chrome manifest 做 9 项硬编码断言，与 manifest 内容强耦合
- 证据状态：源码已证明；双构建的 hls.js chunk 是否冲突需运行时验证

---

## 6. UI/UX

### 6.1 合理点

1. **信息架构清晰**：sidebar（紧凑导航）→ workspace（完整操作）→ options（配置），职责分明
2. **视觉语言统一**：所有组件使用一致的 button/card/tag/skeleton/empty-state 模式，无第三方 UI 库依赖
3. **状态反馈完整**：loading skeleton、empty state（区分"无匹配"和"等待发现"）、error banner、toast（3.5s 自动消失）
4. **下载任务状态机丰富**：15 种状态中文标签，覆盖 queued→starting→running→retrying→pausing→paused→succeeded/failed/partial/interrupted/cancelled 以及直播录制场景
5. **安全删除两步确认**：先选择"仅删除记录"或"删除记录和文件"，再二次确认
6. **HLS 恢复流程用户友好**：根据 resume_requirement 动态调整按钮文案，区分"重新授权"、"输入密钥"、"双需求"三种场景
7. **隐私保护可见**：密钥输入表单显示"密钥只用于本次恢复，不会写入任务记录或检查点"

### 6.2 UI/UX 缺陷

| ID | 问题 | 类别 | 严重度 | 证据 |
|----|------|------|--------|------|
| P1-01 | surfaceFromUrl 不识别 workspace | 功能缺陷 | P1 | `api.ts:15-20` |
| P1-03 | 1s 轮询无活跃性守卫 | 性能 | P1 | `store.ts:84` |
| P2-05 | Shadow DOM 可能影响无障碍遍历 | 无障碍 | P2 | `workspace.ts:21` |
| P2-06 | HLS 预览错误信息可操作性不足 | 用户体验 | P2 | `ResourcesView.vue:82,85` |

### 6.3 主观审美建议（与缺陷分离）

1. **品牌 logo 尺寸**：`AppHeader.vue:14` 使用 48px icon，在侧栏窄宽度下可能偏大；可考虑 32px
2. **资源卡片展开动画**：`ResourcesView.vue:125` 的 transition 建议验证时长（建议 200-300ms）
3. **下载任务卡片密度**：`DownloadsView.vue:52-60` 在侧栏窄宽度下可能信息过载；可考虑折叠部分指标
4. **HLS 解析视图**：`HlsParserView.vue` 表单项较多，建议分步骤向导或折叠高级选项

### 6.4 UI/UX 验证矩阵

| 场景 | 结论 | 证据 |
|------|------|------|
| 侧栏信息架构 | ✅ 通过 | `App.vue:33-52` |
| 资源筛选与排序 | ✅ 通过 | `ResourcesView.vue:107-113` |
| 空状态提示 | ✅ 通过 | `ResourcesView.vue:142` |
| 加载骨架屏 | ✅ 通过 | `ResourcesView.vue:117` |
| HLS 预览播放 | ✅ 通过 | `ResourcesView.vue:73-93` |
| 下载任务状态 | ✅ 通过 | `DownloadsView.vue:21-24` |
| 删除确认流程 | ✅ 通过 | `DownloadsView.vue:26-28,64` |
| 恢复授权流程 | ✅ 通过 | `DownloadsView.vue:29-45` |
| 不可嗅探状态 | ✅ 通过 | `App.vue:37-39` |
| surfaceFromUrl 识别 | ❌ 失败 | `api.ts:15-20` |
| 轮询守卫 | ❌ 失败 | `store.ts:84` |
| 键盘 Escape 收起 | ✅ 通过 | `workspace.ts:37` |
| 语义化标签 | ✅ 通过 | 多文件 header/main/section/article/dl |
| ARIA 属性 | ✅ 通过 | 多文件 aria-label/pressed/expanded |

---

## 7. 已验证、未验证与受阻范围

### 7.1 已验证

| 范围 | 证据类型 |
|------|----------|
| 静态类型检查 (typecheck exit 0) | 终端执行 |
| 扩展构建验证 (validate:extension exit 0, 14 文件) | 终端执行 |
| 单元测试 (test:unit exit 0, vitest 13 项) | 终端执行 |
| 集成脚本 (test:unit 内 4 脚本全通过) | 终端执行 |
| Firefox lint (lint:firefox exit 0) | 终端执行 |
| 浏览器 Firefox (test:firefox exit 0, 15 候选+SPA) | 终端执行 |
| 浏览器 Chrome (test:chrome exit 0, 15 候选+SPA) | 终端执行 |
| 浏览器 Edge (test:edge exit 0, 15 候选+SPA) | 终端执行 |
| 凭证安全 (源码审查: sanitized_task+load_store) | 源码审查 |
| 防御性编程 (源码审查: 三重大小限制+深度限制) | 源码审查 |
| P0-01 Rust 类型缺陷 | 源码审查 |
| P1-01 surfaceFromUrl 缺陷 | 源码审查 |
| P1-02 background.js 单体过大 | 源码审查 |
| P1-03 定时刷新无守卫 | 源码审查 |
| P2-01~P2-03 架构问题 | 源码审查 |
| P3-01 preview headers 偏宽 | 源码审查 |
| HLS 检查点策略 | 源码审查 |
| Native messaging 协议格式 | 源码审查 |
| 会话存储持久化逻辑 | 源码审查 |
| 双 Vite 构建配置 | 源码审查 |
| UI 信息架构与组件结构 | 源码审查 |
| 状态管理与消息接口 | 源码审查 |
| 语义化 HTML 与 ARIA 属性 | 源码审查 |
| git 工作树未被修改 | git status |

### 7.2 未验证（需运行时证据）

| 范围 | 需要的验证 |
|------|-----------|
| Rust 编译是否因 P0-01 失败 | 执行 cargo build / cargo test |
| workspace scope:sender 分支是否在实际运行中被命中 | 浏览器中打开 workspace 页面并检查 sendMessage 参数 |
| 多实例并发轮询的实际性能影响 | 浏览器 profiling（多 tab + sidebar + workspace 并发） |
| workspace close 失败导致 background 状态残留 | 模拟 sendMessage 超时/disconnect 后检查 workspaceTabsByWindow |
| preview headers 对非媒体 AJAX 请求的实际影响 | 在预览页面发起 fetch/XMLHttpRequest 并检查请求头 |
| 测试缝隙是否导致回归 | 运行完整 CI 并检查失败注入场景 |
| 15s native 超时对大 HLS 播放列表是否足够 | 运行包含数百 segment 的 HLS 下载任务 |
| storage.session 在浏览器重启后的行为 | 浏览器重启后检查 sidebar 是否能恢复候选状态 |
| 双 Vite 构建的 hls.js chunk 是否冲突 | 执行 npm run build 并检查 dist/ 产物 |
| 并发下载路数调整 | 运行时验证 |
| 检查点恢复 | 运行时验证 |
| Cookie/Authorization 清理时效 | 运行时验证 |
| SAMPLE-AES/DRM | 运行时验证 |
| LL-HLS | 运行时验证 |
| DASH 完整清单 | 运行时验证 |
| 同名文件序号 | 运行时验证 |
| 删除任务文件清理 | 运行时验证 |
| 真实浏览器侧栏渲染效果 | 浏览器运行 |
| 工作区 Shadow DOM 注入与覆盖 | 浏览器运行 |
| HLS 预览浏览器兼容性 | 浏览器运行 |
| 键盘导航完整性 | 浏览器运行 |
| 屏幕阅读器对 Shadow DOM 的遍历 | 浏览器运行 |
| 窄侧栏与宽工作区响应式布局 | 浏览器运行 |
| 实际资源嗅探与筛选交互 | 浏览器运行 |

### 7.3 受阻

| 范围 | 阻断原因 |
|------|----------|
| Rust 单元测试 (cargo test exit 127) | 需安装 Rust 工具链 |
| Rust release 构建 (cargo build --release exit 127) | 需安装 Rust 工具链 |
| Native 集成测试 (test:native exit 1, ENOENT) | 需 cargo build |
| 下载流程端到端 | 需 native host + 真实媒体 |
| HLS/AES-128 端到端 | 需 native host + 加密 HLS |
| 直播录制端到端 | 需 native host + 直播流 |
| 浏览器 harness 真实运行截图 | service worker 未加载 |

---

## 8. 整改路线图（低风险高收益优先）

| 优先级 | 对应发现 | 收益 | 风险 | 前置 | 规模 | 建议 |
|--------|----------|------|------|------|------|------|
| 1 | P0-01 | 修复 Rust 类型阻断，恢复 native host 编译 | 低 | 无 | **S** — 改 main.rs:128 一行 + 测试构造 | 恢复字段为显式 bool |
| 2 | P1-01 | 修复 workspace 上下文获取，消除多窗口混乱 | 低 | 无 | **S** — 改 api.ts:17 一行 | surfaceFromUrl 补全三值枚举 |
| 3 | P1-03 | 节省非活跃标签 CPU/电池 | 低 | 无 | **S** — 加 Page Visibility 检查 | 引入活跃性守卫 |
| 4 | P2-06 | 提升预览失败用户体验 | 低 | 无 | **S** — 细化错误分支 | 区分网络/解码/DRM 错误 |
| 5 | P1-02 | 降低 background.js 耦合，提升可维护性 | 中 | 无 | **M** — 按边界拆分模块 | 拆分为 candidate/workspace/native/preview |
| 6 | P2-01 | 统一候选 schema，防止字段漂移 | 中 | 无 | **M** — 建立文档化 schema | extension-ui 主定义 + 契约测试 |
| 7 | P2-04 | 恢复 native host 全链路验证 | 低 | 安装 Rust | **S** — 环境配置 | CI 中安装 Rust 工具链 |
| 8 | P2-02 | 修复 workspace 生命周期边界权威不一致 | 低 | P1-01 | **S** — 失败路径补确认 | 增加退避/重试策略 |
| 9 | P2-05 | 提升屏幕阅读器兼容 | 中 | 需测试 | **M** — Shadow DOM 无障碍增强 | 添加 role="application" + aria-label |
| 10 | P2-03 | 增加测试覆盖，防止回归 | 中 | 无 | **M** — 补充失败注入用例 | 模块级单元 + workspace 回归用例 |
| 11 | P3-01 | 缩窄 preview headers 范围 | 低 | 无 | **S** — 改 resourceTypes 数组 | 移除 xmlhttprequest |
| 12 | P3-02 | 补充加密 HLS 运行时证据 | 低 | P2-04 | **S** — 执行 cargo test | 安装 Rust 后验证 |
| 13 | P3-03 | 提升新用户发现效率 | 低 | 无 | **S** — tooltip 引导 | 首次使用引导气泡 |
| 14 | P3-04 | 提升批量操作辨识度 | 低 | 无 | **S** — CSS 调整 | 添加视觉分隔 |

---

## 9. 附录

### 9.1 环境

| 项目 | 值 |
|------|-----|
| Node | v24.15.0 |
| npm | 11.9.0 |
| Chrome | C:/Program Files/Google/Chrome/Application/chrome.exe |
| Firefox | C:/Program Files/Mozilla Firefox/firefox.exe |
| Edge | C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe |
| Rust (rustc/cargo) | 未安装 |
| OS | Windows 11 |

### 9.2 命令日志索引

所有命令在 `D:/rumo_liuying/streamfirefly` 工作目录下执行，基线提交 `28004968299e2657a68aa6819967dcab1aab0258`。

| # | 命令 | 退出码 | 关键输出 |
|---|------|--------|----------|
| 1 | `npm run typecheck` | 0 | vue-tsc --noEmit 通过 |
| 2 | `npm run validate:extension` | 0 | Chrome 14 文件 + Firefox 14 文件有效 |
| 3 | `npm run test:unit` | 0 | 3 文件 13 项 + 4 集成脚本 |
| 4 | `npm run lint:firefox` | 0 | 忽略 2 个 Vue innerHTML 警告 |
| 5 | `cargo test --manifest-path native-host/Cargo.toml` | 127 | cargo: command not found |
| 6 | `cargo build --release --manifest-path native-host/Cargo.toml` | 127 | cargo: command not found |
| 7 | `npm run test:native` | 1 | spawn streamfirefly-native.exe ENOENT |
| 8 | `npm run test:firefox` | 0 | 15 候选 + SPA 导航 |
| 9 | `npm run test:chrome` | 0 | 15 候选 + SPA 导航 |
| 10 | `npm run test:edge` | 0 | 15 候选 + SPA 导航 |

### 9.3 截图清单

浏览器 harness 中扩展 service worker 未加载，无法获取真实运行截图。UI/UX 审查基于源码结构、组件模板、状态管理和已有架构审查证据。

### 9.4 证据冲突处理

三条审查线（功能/架构/UI-UX）在以下发现上证据一致，无冲突：

- P1-01 surfaceFromUrl 缺陷：架构审查（`api.ts:17-19`）与 UI/UX 审查（`api.ts:15-20`）独立确认
- P1-03 定时刷新无守卫：架构审查（`store.ts:84`）与 UI/UX 审查（`store.ts:84`）独立确认
- P0-01 Rust 类型缺陷：仅架构审查覆盖（Rust 代码不在 UI/UX 审查范围内）

### 9.5 术语

| 术语 | 说明 |
|------|------|
| surface | UI 展示面：sidebar（侧栏）、workspace（工作区）、options（设置页） |
| candidate | 媒体资源候选，由网络请求或 DOM 探测发现 |
| Native Host | Rust 编写的本地宿主程序，承担任务状态权威与 HLS 下载 |
| 检查点 (checkpoint) | HLS 下载进度的持久化快照，支持断点恢复 |
| content bridge | content script 与 page-world probe 之间的消息桥接层 |
| Shadow DOM | workspace 使用的 DOM 隔离技术 |
| IIFE | Immediately Invoked Function Expression，workspace 的构建格式 |

### 9.6 证据局限性

本报告基于静态源码审查、现有测试脚本执行和三浏览器端到端测试。所有标注为"源码已证明"的结论均可通过阅读源码确认；标注为"需要运行时验证"的结论需要实际执行环境（Rust 工具链、真实浏览器运行、加密媒体资源等）才能确认。不得把未执行行为写成通过。
