# Decision: 页面媒体输入与自动探测请求

Status: proposed

## Problem

页面探针运行在网页主世界，网页可以伪造媒体消息。媒体发现需要接受页面提供的地址和普通媒体信息，同时阻止页面写入后台字段，并保持登录站点、CDN、Blob 捕捉和未播放直接下载的正常用法。

## Proposal

- 后台 `media.add` 入口通过 `sanitizePageCandidate` 过滤请求头、Referer、网络大小、请求类型、提取结果和后台派生关系等字段。发现入口接受 HTTP(S)、Blob 和 `data:`，由既有检测规则判断媒体类型；拒绝 `javascript:`、`file:` 和非法控制字符。保留普通媒体信息，以及用于后台重建分组的 HTTP(S)/Blob `parentUrl`。后台文本读取与大小探测只接受 HTTP(S)，普通 Blob 媒体保留捕捉入口。
- 候选会话缓存使用 schema 3 和 `media-candidates-v3:`，不读取旧版可被页面污染的候选。首次读取 session storage 后再次检查内存；若另一次加载或 `clearTab` 已建立状态，复用该状态，保留已收集候选和来源上下文。
- 自动大小探测和 HLS 元数据读取的凭据行为与 `main` 一致。大小探测使用 `credentials: "include"`；HLS 文本读取对候选同源地址携带 Cookie/Authorization，对跨源子清单不转发这两项。非 HLS 文本读取继续遵循既有规则，严格预览继续限制候选凭据的 origin。Referer/Origin 保留媒体防盗链语义，自动跳转由浏览器处理。用户主动解析、预览、下载不要求先播放。
- Native 任务输入和实际 curl 参数组装共用请求头校验：只接受既有头名白名单，拒绝 CR/LF、NUL 等控制字符，保留 HTAB 和合法长 Cookie，不设置统一 8 KiB 上限。跨源媒体下载继续保留 Referer/Origin，原有 Cookie/Authorization 隔离不变。
- 工作区使用 closed shadow。弹出层、模态框和快捷键在所属 root 内处理；窗口级监听器补充外部操作与尺寸变化，并成对清理。生产代码不暴露 shadow root 供测试使用，浏览器夹具通过测试自身的构造拦截或扩展专用 DOM API 访问 closed root。

**已知风险：** 用户在恶意网页上打开流萤时，网页可以伪造媒体地址，让扩展向其他网站发带 Cookie 的 GET 请求，这和 `main` 现状相同。字段过滤和 closed shadow 使网页不能通过页面媒体消息修改请求头，也读不到面板显示的结果。issue #19 第 3 项的自动探测部分不修；第 4 项（跨源保留 Origin）保持原样，因为防盗链需要。

主动 HLS 下载与恢复继续遵循 [HLS 检查点与密钥恢复](2026-09-03-hls-checkpoint-and-key-recovery.md)，严格预览继续遵循 [HLS 选段预览](2026-10-13-hls-selection-preview.md)。

## Alternatives considered

- 曾实现“请求证据”机制，并考虑过“同站才带 Cookie”。这些方案会让登录站点缺少元数据，并增加复杂度，因此放弃；自动探测采用 `main` 的既有行为。
- 必须先播放、逐域授权或自动重定向逐跳校验：增加用户操作和请求管理复杂度，影响未播放下载和正常跳转。
- 统一拒绝 Blob、统一限制头值为 8 KiB、跨源移除 Origin：分别影响捕捉入口、合法鉴权和媒体防盗链。

## Verification

后台路由与页面输入测试覆盖字段过滤、`data:` 音视频发现、非媒体 `data:` 检测，以及 `javascript:`、`file:` 和非法控制字符拒绝。后台文本读取与大小探测拒绝 `data:` 且不发请求；旧缓存失效和重叠的首次 session storage 读取有独立回归用例。

本地双 origin、隔离浏览器配置与虚构 Cookie 夹具检查：浏览器未请求过的同源媒体地址可以带 Cookie 探测大小，同源 HLS 地址携带 Cookie，跨源 HLS 子清单不带 Cookie，页面伪造的请求头不进入实际请求，自动跳转和严格预览、DNR 清理保持原有行为。源码对照固定的 `main` 提交核对后台请求逻辑和 HLS 元数据队列。

`typecheck`、`validate:extension`、`test:unit`、构建后 UI 夹具和 Chrome/Edge/Firefox 扩展夹具用于验证类型、构建、字段边界及 closed root 交互。Native 代码与其请求头测试保留，Native 发包不属于本次自动探测退回的验收范围。

本地夹具不代表真实会员网站、全部浏览器 Cookie 设置或发行包已经验收。该记录保持 proposed。

## Rollback

回退对应源码并重新构建扩展即可；不迁移下载任务和文件。候选缓存是临时状态，回退或升级后重新收集，不复用旧版页面可写的字段。若同时回退 Native 请求头校验，需要重新构建对应的 Native 版本。
