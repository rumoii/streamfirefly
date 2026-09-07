# Decision: 一网页一应用页与 HLS 多输出任务

Status: proposed

本记录中新旧扩展/Host 混用与单端回滚约定已由 `2026-09-07-unified-download-queue-and-atomic-upgrade.md` 取代。HLS 检查点恢复由 `2026-09-03-hls-checkpoint-and-key-recovery.md` 负责，不再统一要求重建所有点播任务。

本记录的完整应用页入口、`AppSession` 和资源快照生命周期由 `2026-09-05-native-sidebar-and-page-workspace.md` 取代。HLS 多输出任务、能力协商、敏感信息边界和任务存储兼容要求继续有效。

## Problem

窄侧边栏无法同时容纳大量资源、固定预览详情、HLS 轨道选择和完整下载任务信息。以浏览器当前活动标签推断来源也会在应用页获得焦点后失效。HLS 选择需要跨越浏览器解析、Native Messaging、FFmpeg 子进程和任务持久化，且一次下载可能产生主视频与多个字幕文件。

## Proposal

- 主界面入口、来源上下文与 UI 生命周期以 `2026-09-05-native-sidebar-and-page-workspace.md` 为准。
- `task.create` 以可选 `hlsPlan` 表示选定的视频、音轨、字幕和切片范围。Native Host 通过 `hls-selection-v1`、`hls-subtitle-sidecar-v1` 和 `task-output-group-v1` 声明支持。
- `TaskSnapshot.outputs` 记录主视频和字幕文件。顶层 `output` 继续表示主文件，任务存储版本保持 1，旧任务和旧扩展仍可读取。
- Cookie 和 Authorization 只存在于当前 Native Host 进程内存；公开任务事件和持久化文件必须移除敏感请求头。

## Alternatives considered

- 每条字幕创建独立任务：下载页会被附属文件占满，删除和重试无法表达整组关系。
- 主界面替代方案及其取舍由 `2026-09-05-native-sidebar-and-page-workspace.md` 维护。

## Risks

- 标签媒体状态通过随顶层导航轮换的 `sourceContextId` 隔离任务归属；UI 生命周期由替代记录负责。
- 新扩展连接旧 Native Host 时不得发送 `hlsPlan`；高级下载必须禁用并提示升级。
- FFmpeg 无转码只能按完整切片边界处理时间范围，界面必须显示实际执行范围。
- HLS 任务计划不持久化登录凭据或清单正文；Native Host 重启后相关任务标记中断，需要从来源页面重新发起。

## Verification

- 源码与单元层：来源上下文轮换、HLS 解析、范围换算、派生清单和协议校验。
- 集成层：旧任务读取、新旧扩展与 Host 兼容、多输出状态、取消、重试和整组文件删除。
- 浏览器层：主界面验收由替代记录负责；本记录继续验证 HLS 解析、任务与控制台错误，Edge 完成人工兼容验收。
- 交付层：Vue 构建产物必须进入 Chrome ZIP、Firefox XPI 和 Windows 内测包。

## Rollback

- 0.9 Native Host 保留旧 `task.create` 字段和协议 v3 外壳，0.8 扩展可以继续执行普通下载。
- 0.9 扩展连接缺少新能力的 Host 时只禁用高级 HLS 下载，普通下载仍可使用。
- 任务存储保持版本 1；旧 Host 会忽略新增 `outputs` 和 `source_context_id` 字段，并继续读取顶层主输出。
- 回滚扩展不会删除已下载文件，但无法展示新增的字幕输出明细。
