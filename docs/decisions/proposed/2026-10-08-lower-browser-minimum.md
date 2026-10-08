# Decision: 放低最低浏览器版本

Status: proposed

Chrome/Edge 从 141 降到 116，Firefox 桌面从 142 降到 140。旧版本浏览器上的实测结果见 Verification。

## Problem

用户反馈浏览器版本低于要求，装不上流萤。Chromium 的 141 是为了用 `sidePanel.close()` 定的，当时侧栏是主界面。现在主界面已经换成页面内悬浮面板，侧栏只在页面无法注入时兜底，所有侧栏 API 都已判空调用。Firefox 的 142 是首次支持 Firefox 时定的，没有对应的 API 依据。

## Proposal

最低版本取实际用到、且没有判空调用的能力中要求最高的那个：

| 能力 | 位置 | Chrome | Firefox |
| --- | --- | ---: | ---: |
| `runtime.getContexts` 检测离屏文档 | `extension/src/evaluation.js` | 116 | 不使用（后台页可直接起 Worker） |
| Popover API | `extension-ui/src/ui/popover.ts` | 114 | 125 |
| `content_scripts.world: MAIN` | 两个 manifest | 111 | 128 |
| CSS `color-mix()`、`@container`、`:has()` | `extension-ui/src` 样式 | 111 | 121 |
| `offscreen` | `extension/src/evaluation.js` | 109 | 不使用 |
| `sender.documentId`、`documentIds` | 捕捉与后台 | 106 | 不使用 |
| `storage.session` | 重新捕捉、资源状态 | 102 | 115 |
| `data_collection_permissions` | Firefox manifest | 不适用 | 桌面 140，安卓 142 |

`sidePanel.open`、`setPanelBehavior`、`onOpened`、`close` 都是判空调用；`scrollbar-color`/`scrollbar-width` 不支持时只是没有细滚动条。esbuild 目标 `es2022` 和 Vite 默认的 baseline 目标都低于上述版本。

因此 Chromium 取 116，Firefox 桌面取 140（ESR）。Firefox 安卓版要到 142 才支持 `data_collection_permissions`，所以用 `gecko_android.strict_min_version` 单独声明为 142；不写这项时，`web-ext lint` 会报 `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`。原先的 142 很可能就是因为这一点。`tools/validate-extension.mjs` 和 `tools/validate-firefox-extension.mjs` 同步改为校验新门槛，并校验安卓门槛不低于 142。

Chrome 116 加载扩展时会把 `side_panel.default_path` 当成文件路径检查，带 `?surface=sidebar#/resources` 会报“Side panel file path must exist”，扩展直接装不上。因此 Chromium 的侧栏路径改为 `dist/app.html`：页面在没有 `surface` 参数时本来就按侧栏界面渲染，侧栏也不靠 hash 选视图。Firefox 的 `sidebar_action` 接受查询参数，保持不变。

## Alternatives considered

- 给 `getContexts` 加降级，把 Chromium 降到 114：多出两个版本，却要为一条已经废弃的路径维护两套离屏文档检测，不划算。
- Firefox 降到 128：`data_collection_permissions` 是 AMO 对新扩展的要求，低于 140 时浏览器不会展示数据收集声明；保留 140。

## Risks

- Chrome/Edge 116–140 上没有 `sidePanel.close` 和 `onOpened`。兜底侧栏打开后，再到正常页面点工具栏图标时，悬浮面板会打开，但侧栏不会自动关闭，要用户手动关。
- Firefox 门槛改变后需要重新提交 AMO 签名。
- 旧版本浏览器没有进入 CI，以后用到更新的 API 时，validate 脚本拦不住。新增浏览器 API 时要对照本表。

## Verification

2026-10-08 本地实测，浏览器装在 `D:\Tools\browsers`：

- 源码：`npm run test:unit`、`npm run typecheck`、`npm run validate:extension`、`npm run lint:firefox`（加上 `gecko_android` 后通过）。
- Firefox ESR 140.17.0：`tools/test-browser-extension.mjs --browser firefox` 原样通过（临时加载，未签名）。
- Chrome for Testing 116.0.5845.96：改侧栏路径前，扩展装不上；改后 `tools/test-browser-extension.mjs --browser chrome` 只卡在被动登记夹具。原因是 Chrome for Testing 构建不含 H.264（`MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')` 为 false，正式版 Chrome 154 为 true），夹具的 `addSourceBuffer` 抛错。在临时副本里把这个夹具的编码换成 VP9 后整套通过；仓库里的测试未改。
- 当前正式版 Chrome 154：侧栏路径修改后，同一测试回归通过。
- 未验证：正式版 Chrome/Edge 116–140（含 H.264）上的真实网站录制；兜底侧栏实际打开时的界面；Firefox 签名 XPI 的永久安装。
