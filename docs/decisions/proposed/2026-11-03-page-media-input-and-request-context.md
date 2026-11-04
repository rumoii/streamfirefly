# Decision: 页面媒体输入与自动探测请求

Status: proposed

## Problem

页面探针运行在网页主世界，页面可以伪造它的媒体消息。候选地址和来源标签只是发现线索，不能证明浏览器请求过该地址，也不能授权页面提供下载请求头。自动补充大小和 HLS 元数据需要与用户主动解析、预览、下载区分，同时保留 CDN、Blob 捕捉和未播放直接下载的正常用法。

## Proposal

- 后台消息入口统一剥离页面提交的请求头、Referer、网络大小、请求 ID、请求类型、提取结果和后台派生关系。发现入口接受 HTTP(S)、Blob 和 `data:`，由既有检测规则判断媒体类型；继续拒绝 `javascript:`、`file:` 和非法控制字符。保留普通媒体信息，以及用于后台重建分组的 HTTP(S)/Blob `parentUrl`。网络 fetch 和 Native 下载入口分别验证可处理的地址，不能在资源收集入口删除普通 Blob 或 `data:` 音视频。后台文本读取和大小探测只接受 HTTP(S)；普通 `data:` 音视频的下载 payload 继续送入 Native，由既有网络地址校验拒绝，与 main 一致。
- 自动大小探测固定使用自动用途，HLS 元数据队列传 `automatic: true`。资源模块优先使用当前来源上下文中实际观察到的目标 URL 请求为证据：canonical URL 去掉 fragment、保留 query。没有精确目标证据时，仅当 owner 为 HLS、目标与 owner.url 同源、owner 有 requestId 且没有 inlineManifest，才继承 owner 的证据。跨源子清单需要自己的证据，页面提供的 inline 清单和无 requestId 的 owner 不授予继承资格。
- 证据来自嗅探启用期间带真实标签页 ID 的 `webRequest`。请求开始时记录跨文档与页面导航代次，等待导航清理结束后再读取来源上下文和嗅探 revision；响应处理和候选入库重新校验。跨文档、同文档导航、revision 或来源上下文不匹配的在途请求仍用于发现资源，保留 requestHeaders 供用户下载，仅去掉 requestId；跨文档代次仍阻止旧请求成为自动请求证据。清理失败时保留失败条目，与 main 一致；在该标签页下一次导航清理成功之前，页面 probe 安装和 capture confirmation 持续阻断，网络响应仍列出并保留 requestHeaders，但没有 requestId，自动读取使用 credentials: omit 且不带 Authorization。来源上下文读取失败的请求同样作为过期请求列出。下一次导航清理成功后，probe 和新请求的证据记录恢复正常。响应入库前确认标签页仍存在，关闭后的迟到回调不能重建候选状态。合并时，没有 requestId 的非空请求头替换旧头会同时清除旧 requestId，避免迟到请求借用旧证据。清理窗口内开始的请求在清理结束后处理。后台自身请求及通过 initiator 推测归属的请求不能获得自动携带凭据的资格，归属推测仍可用于发现资源。
- 自动请求只有在选中的精确目标或继承证据确实包含非空 Cookie 时才使用 `credentials: include`，否则使用 `omit`；Authorization 独立使用该证据实际观察到的值，不以 Cookie 存在为前提。没有证据则不带这两项。Referer/Origin 保留既有媒体防盗链语义。`restrictOrigin` 继续控制严格预览，不能由自动用途放宽。浏览器选择 Cookie，不能保证 include 只携带原请求中的 Cookie 子集。
- HLS 元数据候选在本页首次探测后，从无请求证据变为有证据时允许额外重试一次；在途探测结束后才重试，新的请求 ID 不会反复触发重试。子清单读取失败时保留主清单已解析的分辨率。
- 自动请求只校验初始地址，保留浏览器自动重定向行为。重定向目的地的 Cookie 继续由浏览器按 credentials 模式处理；不增加逐跳授权或重定向管理。用户主动解析、预览和下载不要求先播放。显式扩展文本读取仅在目标与 owner.url 同源时允许 Cookie/Authorization。当前非 HLS 调用方不会提交跨源初始地址：DashParserView 只读取 candidate.url；download-client 的 loader 由 prepareDefaultDownload 调用，后者对 DASH 抛错、对其他非 HLS 候选直接返回；HlsParserView 的工作区入口仅接受 HLS/DASH，DASH 使用独立视图。非 HLS 跨源显式读取相较 main 的收紧保留，Native 下载策略不变。
- 候选会话缓存使用 schema 3 和 `media-candidates-v3:`，不再读取旧版可被页面污染的候选。原生任务存储版本和已下载文件不变。
- 首次加载候选状态在读取 session storage 后再次检查内存；若其他加载或 `clearTab` 已建立状态，复用该状态，保留已收集候选和 sourceContextId。
- Native 任务输入和实际 curl 参数组装共用独立请求头校验：只接受既有头名白名单，拒绝 CR/LF、NUL 和其他 HTTP 非法控制字符，保留 HTAB 和合法长 Cookie，不设置统一 8 KiB 上限。跨源媒体下载继续保留 Referer/Origin，原有 Cookie/Authorization 隔离不变。
- 工作区使用 closed shadow。弹出层、模态框和窗口快捷键在所属 root 内处理；窗口级监听器仅补充外部操作与尺寸变化，并成对清理。生产代码不暴露 shadow root 供测试使用；浏览器夹具通过测试自身的构造拦截或扩展专用 DOM API 访问真实 closed root。

主动 HLS 下载与恢复继续遵循 [HLS 检查点与密钥恢复](2026-09-03-hls-checkpoint-and-key-recovery.md)，严格预览继续遵循 [HLS 选段预览](2026-10-13-hls-selection-preview.md)。本记录补充自动探测和页面输入边界。

## Alternatives considered

- 所有跨域资源匿名：正常 CDN 地址通常跨域，不能用网页与媒体的 origin 不同判断是否允许正常鉴权。
- 必须先播放或逐域授权：给用户主动解析和下载增加额外步骤及状态管理。
- 自动重定向逐跳校验：增加请求控制复杂度并影响正常跳转，保留浏览器既有处理方式。
- 内容脚本重复维护字段白名单、统一拒绝 Blob、统一限制头值为 8 KiB：分别增加规则同步、捕捉入口和合法鉴权兼容问题。

## Verification

后台消息/webRequest 回归测试覆盖字段过滤、精确地址证据优先、跨文档与同文档迟到回调、延迟工作区卸载期间的请求、revision 变化、旧缓存失效和严格预览。跨文档、同文档及清理失败的过期响应仍列出并保留下载凭据头，但没有 requestId，自动读取为 omit 且无 Authorization；合并替换头不能保留旧 requestId。真实预览规则删除失败夹具覆盖清理前、清理中和失败结束后的请求，以及关闭后的迟到回调。失败清理持续使 probe.install 返回错误、capture confirmation 保持关闭，直到该标签页下一次导航清理成功；成功后合法 probe 可安装，新请求正常记录证据并恢复相应的自动凭据策略，capture 仍需有效重启标记与新文档上下文。两个首次 session storage 读取重叠时，后完成的读取保留先完成后收集的候选和 sourceContextId。

页面输入单测接受 `data:`，继续拒绝 `javascript:` 与 `file:`；真实 media.add 路由列出带媒体 MIME 的 `data:video/...` 和 `data:audio/...`，不列出无媒体 MIME 的 `data:text/html`。后台文本读取与大小探测拒绝 `data:` 且不发请求。源码对照 main 检查普通音视频的下载准备提前返回，以及 Native 对非 HTTP(S) 地址的既有拒绝。

同源 HLS 子清单继承 Cookie 模式和 Authorization，跨源、inline owner、非 HLS owner、无 requestId 的 owner 不继承；继承证据没有 Cookie 时仍为 omit。HLS 队列单测覆盖获得证据后的单次重试、在途证据更新、重试失败不循环和部分元数据保留。源码追踪覆盖所有非自动 media.fetchText 调用方及 prepareDefaultDownload 的非 HLS 提前返回。构建与单测使用 typecheck、validate:extension、test:unit 和 diff --check 验证。

浏览器与 Native 发包验收另行运行：本地双 origin 与虚构 Cookie 夹具检查匿名提示、无 Cookie 请求之后仍匿名、观察到 Cookie 后自动鉴权、同源继承、跨源子清单独立证据和自动跳转；Native 集成测试检查合法长 Cookie、HTAB 与非法头的实际发包；UI 单测和 Chrome/Edge/Firefox 扩展夹具覆盖 closed root 的交互、来源页面不可见性和 Blob 捕捉；媒体夹具覆盖 HLS/DASH 与防盗链。

夹具证据不代表真实会员网站、全部浏览器 Cookie 设置或发行包已经验收。该记录在合并和发行验收前保持 proposed。

## Rollback

回退扩展与 Native 对应源码、重新构建即可；不迁移下载任务和文件。候选缓存是临时状态，回退或再次升级时重新收集，不把旧版页面可写的字段当作网络证据。
