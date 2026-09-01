# Decision: 侧边栏主界面、协议 v3 与录制数据通道

Status: proposed

## Problem

流萤原有弹窗适合快速下载，但无法稳定承载媒体解析、批量操作、长时间任务和录制。Native Messaging v2 只有任务创建、查询和删除，也不能把持续的大块媒体数据作为 JSON 消息可靠传输。

## Proposal

- Chrome/Edge 点击扩展图标直接打开侧边栏；Firefox 使用原生侧栏。资源、下载和设置共享同一个侧栏文档，媒体工作台使用独立扩展页面。
- Native Host 使用协议 v3，同时声明支持 v2；旧消息保持原语义，新能力必须通过 `capabilities` 协商。
- Native Host 是下载任务状态的唯一权威，支持暂停、继续、取消和重试。扩展界面只根据任务事件和 `task.list` 收敛状态。
- 任务文件不持久化 Cookie、Authorization 或密钥。需要登录态才能继续的任务，在进程重启后保持中断并要求用户从来源页面重新发起。
- 后续 MediaSource/WebRTC 录制只通过 Native Messaging 创建和控制会话。持续媒体数据使用绑定 `127.0.0.1`、短期令牌保护的有界流式通道；若页面策略阻断该通道，回退到浏览器内 MediaRecorder 并明确标注录制模式。
- 标准 HLS AES-128 可以发现、验证和解密；SAMPLE-AES、Widevine、FairPlay 和 PlayReady 只识别并提示，不绕过 DRM。

## Alternatives considered

- 保留弹窗作为完整主界面：空间和生命周期不足，设置与高级工具仍会不断打开新页面。
- 通过 Native Messaging JSON 传输所有录制字节：存在消息大小、复制开销、背压和 MV3 Service Worker 生命周期风险。
- 直接引入 CutUI：当前扩展没有 Vue 构建体系，且私有组件库授权不适合作为未来开源依赖；只采用其视觉与交互原则。

## Risks

- Chrome `sidePanel` 与 Firefox `sidebar_action` 行为不同，必须分别进行真实浏览器验收。
- 暂停后的 Range 续传依赖服务端能力；不支持续传时只能重新开始并明确提示。
- 录制通道仍需完成独立威胁模型、背压原型和长时间压力验证，因此本记录保持 proposed。

## Verification

- 源码与单元层：协议协商、状态转换、HLS/MPD 解析器和扩展清单校验。
- 组装层：Native Host 下载集成测试覆盖暂停、继续、取消、重试和进程退出。
- 浏览器层：使用专用测试配置验证侧栏入口、内嵌设置、筛选批量操作、媒体工作台、控制台和网络错误。
- 录制层：在本地 MediaSource、WebRTC 和直播夹具完成至少两小时压力测试前，不标记 implemented。

## Rollback

- 0.8 扩展可以回退到 0.7 弹窗版本；协议 v3 Host 保留 v2 消息，因此旧扩展仍可使用原有下载能力。
- 如果任务控制发现严重问题，可从扩展隐藏 `task-control-v1` 操作；已有任务文件仍使用兼容字段，不需要降级迁移。
- 录制通道尚未发布，不存在需要回滚的持久录制格式或监听端口。
