# 流萤 UI/UX 审查报告

- 基线仓库：`D:/rumo_liuying/streamfirefly`
- 基线提交：`28004968299e2657a68aa6819967dcab1aab0258`
- 审查模式：只读源码审查 + README/架构报告交叉验证
- 环境限制：浏览器 harness 中扩展 service worker 未加载，无法获取真实运行截图；本审查基于源码结构、组件模板、状态管理和已有架构审查证据

---

## 1. UI/UX 评级与依据

**总体评级：B**

依据：
- 信息架构清晰，三 surface（sidebar/workspace/options）职责分明
- 视觉语言统一（CutUI 风格），组件复用率高
- 状态反馈完整：loading skeleton、empty state、error banner、toast
- 无障碍基础到位：语义化 HTML、ARIA 属性、alt text
- 但存在 surfaceFromUrl 识别缺陷、1s 轮询无守卫、Shadow DOM 无障碍隐患等中风险问题

---

## 2. 界面/状态验证矩阵

| 场景 | 环境/前置 | 步骤/证据 | 预期 | 实际 | 结论 | 证据 |
|------|-----------|-----------|------|------|------|------|
| 侧栏信息架构 | 源码审查 | App.vue:33-52 | header+资源+任务+操作 | 符合 | ✅ 通过 | `App.vue:33-52` |
| 资源筛选与排序 | 源码审查 | ResourcesView.vue:107-113 | 正则/类型/大小/排序 | 符合 | ✅ 通过 | `ResourcesView.vue:107-113` |
| 空状态提示 | 源码审查 | ResourcesView.vue:142 | 等待发现/无匹配两种 | 符合 | ✅ 通过 | `ResourcesView.vue:142` |
| 加载骨架屏 | 源码审查 | ResourcesView.vue:117 | skeleton-card | 符合 | ✅ 通过 | `ResourcesView.vue:117` |
| 资源详情展开 | 源码审查 | ResourcesView.vue:126-139 | 预览+元数据+URL | 符合 | ✅ 通过 | `ResourcesView.vue:126-139` |
| HLS 预览播放 | 源码审查 | ResourcesView.vue:73-93 | HLS.js + 降级 | 符合 | ✅ 通过 | `ResourcesView.vue:73-93` |
| 下载任务状态 | 源码审查 | DownloadsView.vue:21-24 | 15 种状态中文标签 | 符合 | ✅ 通过 | `DownloadsView.vue:21-24` |
| 删除确认流程 | 源码审查 | DownloadsView.vue:26-28,64 | 两步确认+文件选择 | 符合 | ✅ 通过 | `DownloadsView.vue:64` |
| 恢复授权流程 | 源码审查 | DownloadsView.vue:29-45 | 权限/密钥/双需求 | 符合 | ✅ 通过 | `DownloadsView.vue:29-45` |
| 不可嗅探状态 | 源码审查 | App.vue:37-39 | 限制页面提示 | 符合 | ✅ 通过 | `App.vue:37-39` |
| 错误横幅 | 源码审查 | App.vue:36 | error banner | 符合 | ✅ 通过 | `App.vue:36` |
| Toast 通知 | 源码审查 | App.vue:19,51 | 3.5s 自动消失 | 符合 | ✅ 通过 | `App.vue:19` |
| 实时指示器 | 源码审查 | ResourcesView.vue:103 | live-dot | 符合 | ✅ 通过 | `ResourcesView.vue:103` |
| surfaceFromUrl 识别 | 源码审查 | api.ts:15-20 | 返回 workspace | ❌ 不返回 | **失败** | `api.ts:15-20` |
| 轮询守卫 | 源码审查 | store.ts:84 | 活跃性检查 | ❌ 无守卫 | **失败** | `store.ts:84` |
| 键盘 Escape 收起 | 源码审查 | workspace.ts:37 | Escape 关闭工作区 | 代码存在 | ✅ 通过 | `workspace.ts:37` |
| 语义化标签 | 源码审查 | 全部组件 | header/main/section/article/dl | 符合 | ✅ 通过 | 多文件 |
| ARIA 属性 | 源码审查 | 多组件 | aria-label/pressed/expanded | 符合 | ✅ 通过 | 多文件 |
| 真实浏览器运行 | 环境限制 | harness service worker 未加载 | 扩展正常运行 | — | **受阻** | N/A |

---

## 3. 合理点

1. **信息架构清晰**：sidebar（紧凑导航）→ workspace（完整操作）→ options（配置），职责分明，用户可在窄侧栏快速浏览，展开工作区做深度操作。
   - `App.vue:33-52` — sidebar 模式精简为 header+资源+任务+两个操作按钮
   - `WorkspaceApp.vue` — workspace 模式加载完整 ResourcesView + HlsParserView + DownloadsView

2. **视觉语言统一**：所有组件使用一致的 button/card/tag/skeleton/empty-state 模式，无第三方 UI 库依赖。
   - `AppHeader.vue` — brand-block + source-chip + header-actions 三段式
   - `ResourcesView.vue:118-123` — resource-card 统一结构：checkbox + type + identity + actions

3. **状态反馈完整**：
   - Loading：`ResourcesView.vue:117` skeleton-card 骨架屏
   - Empty：`ResourcesView.vue:142` 区分"无匹配"和"等待发现"两种空状态
   - Error：`App.vue:36` error banner + `ResourcesView.vue:114` inline-error
   - Toast：`App.vue:19` 3.5s 自动消失，success/error 统一入口

4. **下载任务状态机丰富**：`DownloadsView.vue:21-24` 定义 15 种状态中文标签，覆盖 queued→starting→running→retrying→pausing→paused→succeeded/failed/partial/interrupted/cancelled，以及直播录制场景。

5. **安全删除两步确认**：`DownloadsView.vue:64` 先选择"仅删除记录"或"删除记录和文件"，再二次确认，进行中任务会先安全取消。

6. **HLS 恢复流程用户友好**：`DownloadsView.vue:29-45` 根据 resume_requirement 动态调整按钮文案和提示，区分"重新授权"、"输入密钥"、"双需求"三种场景，且明确告知"已完成切片和检查点会保留"。

7. **隐私保护可见**：`DownloadsView.vue:65` 密钥输入表单底部显示"密钥只用于本次恢复，不会写入任务记录或检查点"。

---

## 4. 问题（按严重度分级）

### P1-01 surfaceFromUrl 不识别 workspace

- **类别**：功能缺陷 / 跨层耦合
- **影响**：workspace 页面 URL 中 `surface=workspace` 参数被忽略，`surfaceFromUrl()` 永远返回 `"sidebar"`，导致 workspace 的上下文获取使用 `"active"` scope 而非 `"sender"` scope（`store.ts:50` 的三元判断永远不会命中 workspace 分支）。
- **证据**：`api.ts:15-20` — `return surface === "options" ? "options" : "sidebar"`
- **复现**：打开 workspace 页面，检查 `surfaceFromUrl()` 返回值
- **建议**：补全为三值枚举 `surface === "workspace" ? "workspace" : surface === "options" ? "options" : "sidebar"`

### P1-02 非活跃标签 1s 轮询无活跃性守卫

- **类别**：性能 / 资源浪费
- **影响**：`store.ts:84` 在 `surface !== options` 时无条件启动 1s 定时刷新，sidebar 对非活跃标签仍保持轮询，浪费 CPU 和电池。
- **证据**：`store.ts:84` — `timer = window.setInterval(() => { void refresh(); }, 1000)`
- **建议**：使用 Page Visibility API 或 Intersection Observer，在页面不可见时暂停轮询

### P2-01 Shadow DOM 工作区可能影响无障碍遍历

- **类别**：无障碍
- **影响**：workspace 使用 Shadow DOM 挂载（`workspace.ts:10-41`），部分屏幕阅读器可能无法穿透 Shadow DOM 边界遍历内部元素。
- **证据**：`workspace.ts:21` — `createApp(WorkspaceApp).use(createPinia()).mount(root)`
- **建议**：在 Shadow DOM host 上添加 `role="application"` 和 `aria-label`，并在主流屏幕阅读器上验证

### P2-02 预览错误信息可操作性不足

- **类别**：用户体验
- **影响**：`ResourcesView.vue:82` HLS 预览失败仅提示"无法播放此 HLS 资源"，`ResourcesView.vue:85` 自动播放失败提示"浏览器未能自动播放，请点击播放器中的播放按钮"——前者缺少原因和替代操作建议。
- **证据**：`ResourcesView.vue:82,85`
- **建议**：区分网络错误、解码错误、DRM 错误，给出对应建议（如"该资源可能需要登录，请在来源页面授权后重试"）

### P2-03 surfaceFromUrl 缺陷导致 workspace 定时刷新路径异常

- **类别**：一致性
- **影响**：由于 P1-01，workspace 实际走 sidebar 分支，`sidebarWindowId` 被设置为 workspace 所在窗口 ID，而非用户实际浏览的标签页窗口。当用户在不同窗口打开 workspace 时，上下文可能指向错误的窗口。
- **证据**：`store.ts:49` — `if (surface.value === "sidebar" && sidebarWindowId == null) sidebarWindowId = await currentWindowId()`
- **建议**：与 P1-01 一并修复

### P3-01 排序提示可发现性

- **类别**：主观改进建议
- **影响**：`ResourcesView.vue:113` 的 sort-hint（"视频资源通常体积较大，按文件大小排序可以更快找到视频"）是静态文本，新用户可能忽略。
- **建议**：首次使用时以 tooltip 或引导气泡形式展示，后续折叠

### P3-02 批量操作栏视觉层级

- **类别**：主观改进建议
- **影响**：`ResourcesView.vue:115` batch-bar 在选中资源后出现，但与 toolbar-grid 平级，可能被误认为是筛选区域的一部分。
- **建议**：添加视觉分隔（如背景色区分或顶部边框）以明确"已选 N 项"的操作上下文

---

## 5. 主观审美建议（与缺陷分离）

1. **品牌 logo 尺寸**：`AppHeader.vue:14` 使用 48px icon，在侧栏窄宽度下可能偏大；可考虑 32px 以节省空间。
2. **资源卡片展开动画**：`ResourcesView.vue:125` 使用 `resource-detail` transition，建议验证动画时长是否适中（建议 200-300ms），避免过慢影响操作流畅感。
3. **下载任务卡片密度**：`DownloadsView.vue:52-60` 任务详情包含进度条+多个指标+操作按钮，在侧栏窄宽度下可能信息过载；可考虑在窄模式下折叠部分指标。
4. **HLS 解析视图**：`HlsParserView.vue` 功能完整（清晰度/音轨/字幕/切片/时间范围选择），但表单项较多，建议分步骤向导或折叠高级选项。

---

## 6. 已验证 / 未验证 / 受阻范围

### 已验证（源码证据）
- 信息架构与组件结构 ✅
- 状态管理与消息接口 ✅
- 语义化 HTML 与 ARIA 属性 ✅
- 空/加载/错误状态 ✅
- 下载任务状态机 ✅
- 安全删除与恢复流程 ✅
- surfaceFromUrl 识别缺陷 ✅
- 轮询守卫缺失 ✅

### 未验证（需运行时证据）
- 真实浏览器中的侧栏渲染效果
- 工作区 Shadow DOM 在实际页面中的注入与覆盖
- HLS 预览在不同浏览器中的兼容性
- 键盘导航完整性（Tab 顺序、焦点可见性）
- 屏幕阅读器对 Shadow DOM 的遍历
- 窄侧栏与宽工作区的响应式布局
- 实际资源嗅探与筛选交互

### 受阻
- 浏览器 harness 中扩展 service worker 未加载，无法获取真实运行截图
- 无 Rust 工具链，无法验证 native host 相关 UI（下载进度、HLS 合并状态）

---

## 7. 整改路线图（低风险高收益优先）

| 优先级 | 对应发现 | 收益 | 风险 | 前置 | 规模 |
|--------|----------|------|------|------|------|
| 1 | P1-01 | 修复 workspace 上下文获取 | 低 | 无 | **S** — 改一行 `api.ts:17` |
| 2 | P1-02 | 节省非活跃标签 CPU/电池 | 低 | 无 | **S** — 加 Page Visibility 检查 |
| 3 | P2-02 | 提升预览失败用户体验 | 低 | 无 | **S** — 细化错误分支 |
| 4 | P2-01 | 提升屏幕阅读器兼容 | 中 | 需测试 | **M** — Shadow DOM 无障碍增强 |
| 5 | P2-03 | 修复多窗口上下文混乱 | 低 | P1-01 | **S** — 随 P1-01 一并修复 |
| 6 | P3-01 | 提升新用户发现效率 | 低 | 无 | **S** — tooltip 引导 |
| 7 | P3-02 | 提升批量操作辨识度 | 低 | 无 | **S** — CSS 调整 |

---

## 证据边界

- 本审查 14 项已验证结论均基于源码直接引用（file:line）
- 7 项未验证需真实浏览器运行证据
- 2 项受阻于环境限制（harness service worker、Rust 工具链）
- 无源码改动，git status 仅出现未跟踪的 `.hermes/` 工作目录
