# Decision: 扩展向 GitHub 检查新版本

Status: proposed

## Problem

通用版（解压加载）和自行分发的 Firefox XPI 都没有 `update_url`，浏览器不会替它们检查更新；扩展和本地助手里也没有任何版本检查。只有商店版会由 Chrome 自动更新。结果是绝大多数用户不知道发了新版，只能自己去 GitHub 或 B 站看。

## Proposal

- 后台模块 `extension/src/update-check.js` 请求 `https://api.github.com/repos/rumoii/streamfirefly/releases/latest`：不带 Cookie（`credentials: 'omit'`），8 秒超时。取 `tag_name` 按 `x.y.z` 逐段和清单版本比较；不是 `x.y.z` 格式的标签视为没有更新。`html_url` 不是本仓库 Releases 页面时，链接回退到 `releases/latest`。
- 手动检查：设置“常规 → 版本”里的“检查更新”按钮（消息 `update.check`）。失败时提示“连不上 GitHub，请开启浏览器或系统代理后重试”，并在说明文字里写明“下载代理”只作用于本地助手，不影响检查更新。
- 每天自动检查：默认开启，存储键 `autoCheckUpdates`（缺省视为开启），开关切换后立即写入，不走“验证并保存”，也不受“恢复默认”影响。侧栏和页面工作区挂载时发送 `update.auto`，后台按本地日期每天最多请求一次：请求前先写入当天日期，同一时刻打开的多个界面共用同一次请求。请求失败不提示，也不在当天重试。
- 有新版且该版本未被忽略时，在面板顶部显示“流萤 x.y.z 已发布”，提供“查看更新”和“忽略此版本”（`update.dismiss`）。手动检查不受“忽略”影响。
- 状态保存在 `storage.local.updateState`：`lastAutoCheckDay`、`latestVersion`、`releaseUrl`、`checkedAt`、`dismissedVersion`。
- Chrome 应用商店版：不显示检查按钮和开关，后台也不发请求。

## Alternatives considered

- 只做手动检查：没有新增默认联网行为，但用户很少会主动去点，提醒的作用很有限。
- 自动检查默认关闭：严格本地优先，但几乎没人会去打开，等于没做。
- 在界面页面里直接请求：侧栏和工作区可能同时打开，会各请求一次；放在后台才能共用一份状态并去重。
- 给 Firefox 清单加 `update_url` 让浏览器自动升级：只覆盖 Firefox，而且已安装的旧版要先手动装一次带 `update_url` 的版本，可以以后另做。

## Risks

- 新增了一个默认开启的对外请求，GitHub 能看到 IP 地址和浏览器标识。已在 `PRIVACY.md` 写明，并提供关闭开关。
- 未登录调用 GitHub API 每个 IP 每小时限 60 次。每天一次加上手动点击远远用不完；共用出口 IP 时如果被限流，会按“连不上 GitHub”处理。
- 国内直连 GitHub 不稳定：自动检查连不上时不打扰用户，靠第二天重试或手动检查。

## Verification

- `tools/test-update-check.mjs`：版本比较、手动检查的各类失败、超时、每天只查一次与并发去重、失败后保留上次结果、忽略版本、关闭开关、升级后不再提示、商店版不请求。
- `extension-ui/src/components/UpdateCard.test.ts` 与 `App.test.ts`：新版提示与下载页链接、已是最新、连不上 GitHub 的文案、开关写入与记忆、商店版不显示、侧栏提示条与“忽略此版本”。
- 实际浏览器里请求 GitHub API 的验证在发版前补记。
