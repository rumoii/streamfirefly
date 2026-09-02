# Decision: 一网页一应用页与 HLS 多输出任务

Status: proposed

## Problem

窄侧边栏无法同时容纳大量资源、固定预览详情、HLS 轨道选择和完整下载任务信息。以浏览器当前活动标签推断来源也会在应用页获得焦点后失效。HLS 选择需要跨越浏览器解析、Native Messaging、FFmpeg 子进程和任务持久化，且一次下载可能产生主视频与多个字幕文件。

## Proposal

- 每个来源网页标签最多绑定一个流萤应用页。重复点击扩展图标聚焦已有应用页，不在普通新建标签时自动打开。
- `AppSession` 使用稳定 `sessionId`，每次来源网页导航创建新的 `sourceContextId`。会话和资源快照仅保存于 `storage.session`。
- 来源网页关闭后，应用页保留资源快照和任务归属；应用页关闭后清理会话。浏览器重启不恢复资源历史。
- 资源、下载和设置使用完整应用页顶部页签；HLS 解析作为资源页内部子页面。
- `task.create` 以可选 `hlsPlan` 表示选定的视频、音轨、字幕和切片范围。Native Host 通过 `hls-selection-v1`、`hls-subtitle-sidecar-v1` 和 `task-output-group-v1` 声明支持。
- `TaskSnapshot.outputs` 记录主视频和字幕文件。顶层 `output` 继续表示主文件，任务存储版本保持 1，旧任务和旧扩展仍可读取。
- Cookie 和 Authorization 只存在于当前 Native Host 进程内存；公开任务事件和持久化文件必须移除敏感请求头。

## Alternatives considered

- 浏览器只保留一个全局流萤页：切换来源时容易混淆不同网页资源和任务归属。
- 每次点击都创建新应用页：同一网页会产生重复会话和重复操作。
- 每条字幕创建独立任务：下载页会被附属文件占满，删除和重试无法表达整组关系。
- 继续使用侧边栏和独立工作台：导航割裂且不足以承载左右分栏资源详情。

## Risks

- 标签页关闭、导航、Service Worker 重启和标签 ID 复用必须由稳定会话标识隔离。
- 新扩展连接旧 Native Host 时不得发送 `hlsPlan`；高级下载必须禁用并提示升级。
- FFmpeg 无转码只能按完整切片边界处理时间范围，界面必须显示实际执行范围。
- HLS 任务计划不持久化登录凭据或清单正文；Native Host 重启后相关任务标记中断，需要从来源页面重新发起。

## Verification

- 源码与单元层：会话绑定、导航换页、HLS 解析、范围换算、派生清单和协议校验。
- 集成层：旧任务读取、新旧扩展与 Host 兼容、多输出状态、取消、重试和整组文件删除。
- 浏览器层：Chrome、Firefox 使用独立测试配置验证一网页一流萤、完整应用页交互和控制台错误；Edge 完成人工兼容验收。
- 交付层：Vue 构建产物必须进入 Chrome ZIP、Firefox XPI 和 Windows 内测包。

## Rollback

- 0.9 Native Host 保留旧 `task.create` 字段和协议 v3 外壳，0.8 扩展可以继续执行普通下载。
- 0.9 扩展连接缺少新能力的 Host 时只禁用高级 HLS 下载，普通下载仍可使用。
- 任务存储保持版本 1；旧 Host 会忽略新增 `outputs` 和 `source_context_id` 字段，并继续读取顶层主输出。
- 回滚扩展不会删除已下载文件，但无法展示新增的字幕输出明细。
