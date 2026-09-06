# StreamFirefly Native-Host 边界审查

**基线**: `28004968299e2657a68aa6819967dcab1aab0258` (`main`)
**日期**: 2026-09-06
**方法**: 只读静态审查；未运行测试
**范围**: presentation → Pinia store → extension messaging/background → Native Messaging → Rust task/HTTP/HLS/persistence/FFmpeg
**发现**: P0×0, P1×4, P2×6, P3×2

---

## 权威与主要调用链

### 普通下载

`DownloadDialog.vue:13-15,69-77 payload/create`
→ `api.ts:5-8 sendMessage`
→ `background.js:511-530 onMessage/nativeRequestPromise`
→ `background.js:386-420 ensureNative/nativeInfo`
→ `main.rs:3890-3942 main`
→ `main.rs:903-1052 create_task`
→ `main.rs:3643-3681 start_download`
→ `main.rs:1998-2019 start_http_download`
→ `probe_size` / `start_parallel_http_download` / `start_single_http_download`
→ `curl` 子进程

### HLS v1

`HlsParserView.vue:123-160 createTask`
→ `background.js:511-527 capability gate`
→ `main.rs:654-730 hls_plan`
→ `main.rs:3429-3641 start_hls_plan_download`
→ 临时 M3U8 → FFmpeg 直接读取网络下载并合并

### HLS v2/v3

`HlsParserView.vue:131-156 createTask`
→ `main.rs:274-312 new_checkpoint`
→ `main.rs:2659-3180 start_hls_checkpoint_download`
→ `checkpoint_jobs` → 多线程 `execute_hls_job` / `hls_curl_once`
→ `save_checkpoint` → `merge_hls_checkpoint` → `run_ffmpeg_with_progress`

### 状态权威

- Native Host 的 `Store.tasks` 是顶层任务状态权威：`main.rs:159-168`
- HLS 切片恢复状态以 `checkpoint.json` 为权威：`hls.rs:104-110`, `main.rs:2363-2462`
- 扩展只通过事件和 `task.list` 派生任务列表：`store.ts:57-60,153-159`

状态流：

```text
queued -> starting -> running -> succeeded | failed | partial
running/retrying -> pausing -> paused -> retrying
active/paused -> cancelling -> cancelled
进程重启(active) -> interrupted -> retrying
live active/paused/interrupted -> stopping -> merging -> succeeded | partial | failed
```

---

## P1 发现

### P1-1：来源站点凭据可被转发到跨源切片、密钥或重定向目标

**证据**

- `extension/background.js:260-264`：`onBeforeSendHeaders` 捕获 `cookie`、`authorization`、`origin`
- `extension-ui/src/components/HlsParserView.vue:119-120`：`basePayload` 完整传递 `requestHeaders`
- `extension/background.js:358-375`：`fetchMediaText` 接受任意 HTTP(S) `requestedUrl`，未检查 origin
- `native-host/src/main.rs:582-590`：`validate_manifest_uri` 只检查 `http://`/`https://`
- `native-host/src/main.rs:1576-1580`：`add_header_args` 把同一组头加给所有 curl 请求
- `native-host/src/main.rs:2069-2098`：`hls_curl_once` 使用这些头并启用 `--location`
- `native-host/src/main.rs:2228-2237`：`load_hls_key` 清单可指定另一主机的密钥 URL
- `native-host/src/main.rs:3307-3316,3730-3737`：FFmpeg 网络输入复用整组请求头

**影响**: 来源站点 bearer token、会话 Cookie 可被发送到不受信任的服务器或本机/内网地址。

**建议**:
1. 每个请求保存并校验目标 origin；Cookie/Authorization 默认只允许发往原 origin
2. 跨源 variant、音轨、字幕、密钥使用独立头集合
3. 禁止 curl 在跨主机重定向时继续发送自定义敏感头
4. 原生侧使用 HTTP 库或受控 stdin/config 传递凭据，避免命令行暴露

---

### P1-2：`stopping` 任务可被直接删除，后台工作继续访问已删除记录和工作目录

**证据**

- `main.rs:1215-1252`：`task_control("stop")` 设为 `stopping`，不停止当前工作
- `main.rs:1489-1492`：`delete_task` 活跃状态集合遗漏 `stopping`
- `extension-ui/src/components/DownloadsView.vue:59`：删除按钮对所有状态可见
- `main.rs:3116-3180`：停止后仍读取工作目录并执行 FFmpeg 合并

**影响**: 可产生孤儿下载、损坏输出、错误清理和不可观察的后台进程。

**建议**: 将 `stopping` 纳入不可直接删除的活跃状态；删除操作必须先取得执行句柄所有权、发出取消、等待 bounded terminal state。

---

### P1-3：任务存储在损坏或版本不兼容时静默清空并覆盖原数据

**证据**

- `main.rs:342-351`：JSON 解析失败、Store 版本不是 1、Task 反序列化失败均退化为 `Vec::new()`
- `main.rs:427`：加载结束立即 `save_store`
- `main.rs:431-442`：`save_store` 先删后 rename，所有错误被忽略
- `main.rs:1049-1052`：无论保存是否成功都返回任务

**影响**: 任务历史和恢复信息可整体丢失。

**建议**: "文件不存在"与"文件存在但无效"分开处理；使用 `tmp + fsync + backup + rollback` 策略；`save_store` 返回 `Result`。

---

### P1-4：Native Host 退出时未关闭 curl/FFmpeg 子进程

**证据**

- `main.rs:1076-1169`：进程只在显式任务控制路径中登记和停止
- `main.rs:3890-3944`：stdin EOF 时直接退出，无 shutdown guard
- `main.rs:508-511`：stdout 写失败被忽略

**影响**: 孤儿进程、凭据生命周期超出 Host、输出竞争、恢复数据损坏。

**建议**: Windows 使用 Job Object `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；增加 Host 级 shutdown owner；stdout 写失败触发关闭流程。

---

## P2 发现

### P2-1：协议 v3/v2 兼容仅声明未强制执行

- `extension/background.js:409`：所有请求固定 `{version: 1}`
- `native-host/src/main.rs:3900-3903`：路由忽略请求 `version`
- `native-host/src/main.rs:3904`：却声明 `protocolVersion:3, supportedProtocolVersions:[2,3]`
- `extension/background.js:414-420`：`nativeInfo` 不检查协议版本

### P2-2：相对 URI 直播清单在任务创建阶段被拒绝

- `extension-ui/src/media.ts:73-75,102-149`：UI 解析时能正确处理相对 URI
- `HlsParserView.vue:131,145-153`：直播计划发送原始 `rawText`
- `main.rs:592-617`：非注释 URI 及 `URI=` 属性必须已经是 HTTP(S) 绝对地址
- `test-native-hls.mjs:56-62`：现有夹具只生成绝对 URL

### P2-3：`task.create` 无幂等身份

- `extension/background.js:395-410`：15 秒超时或断开只返回失败
- `native-host/src/main.rs:935,1049`：每次创建新 UUID
- `test-native-download.mjs:116-117,172`：明确期望重复创建产生两个独立任务

### P2-4：带认证的普通 HTTP/HLS v1 重启后暴露无凭据"重试"

- `main.rs:352-360`：重启识别并清除敏感头
- `main.rs:377-386`：非可恢复 HLS 的 `resume_requirement` 被设为 `None`
- `DownloadsView.vue:59`：`interrupted && !resume_requirement` 显示"重试"

### P2-5：任务数、并发、HLS job 数和 `task.list` 响应无全局边界

- `main.rs:27-31`：仅限制单条入站消息和单个清单大小
- `hls.rs:221-390`：解析切片数量无上限
- `main.rs:3925-3927`：`task.list` 一次返回全部任务
- `main.rs:502-506`：出站消息没有大小上限

### P2-6：HTTP/FFmpeg 期限和停止路径不完整

- `main.rs:1680-1699`：普通 HTTP 下载无总 deadline
- `main.rs:1155-1168`：`stop_process` 的 `kill`/`wait` 无超时
- `main.rs:3331-3426`：FFmpeg 运行没有 deadline
- `main.rs:3397-3400`：最终合并把 `stopping` 改回 `running`，状态回退

---

## P3 发现

### P3-1：状态、阶段和协议 DTO 全为自由字符串，没有 revision

- `main.rs:76-143`：`state`、`phase` 均为 `String`
- `extension-ui/src/types.ts:37-74`：状态继续使用 `string`
- `extension-ui/src/api.ts:5-8`：消息和响应大量使用 `any`

### P3-2：FFmpeg/curl 诊断被丢弃，故障无法分类

- `main.rs:1599-1604,1695-1699,2096-2100,3341-3345,3749-3753`：多个路径 stderr 设为 `null`
- 最终错误收敛为 `curl_download_failed` 或 `ffmpeg_unavailable_or_failed`

---

## 合理点

1. **Native Messaging framing 有边界**：`main.rs:488-506` 拒绝 0 和大于 16 MiB 的帧
2. **命令执行未经过 shell**：curl/FFmpeg 通过 `Command::args` 传参
3. **文件名与目录校验**：`main.rs:517-540,832-876` 处理 Windows 非法名、保留设备名
4. **Cookie/Authorization 不进入普通任务 JSON**：`main.rs:342-360,446-482` 在加载和持久化前清理
5. **手动密钥不进入 checkpoint**：`main.rs:217-236` 与 `hls.rs:90-102` 无 `key_override`
6. **HLS checkpoint 比任务 Store 更稳健**：`hls.rs:543-590` 使用 `sync_all`、备份回退
7. **HLS retry 有分类、次数和可取消退避**：`main.rs:2169-2208,2250-2360`
8. **HLS 终态区分**：`main.rs:3141-3179` 主视频成功但字幕失败标记为 `partial`
9. **恢复事件晚于首个响应**：`main.rs:3939-3942` 先发送响应再恢复
10. **临时资源有所有权**：`main.rs:145-156 TempManifestFile` 使用 Drop 删除

---

## 测试缝隙

1. 协议矩阵：v2→v3、缺失/未知 version、重复 request id
2. 提交后断连：`task.create` 已创建但响应丢失，随后重试
3. 任务 Store 故障注入：截断 JSON、未知版本、磁盘满
4. 生命周期：活跃任务时关闭 stdin/Host 崩溃
5. 停止竞态：`stop → cancel`、`stop → delete`、合并阶段删除
6. 真实 URI：直播相对 URI、`../segment.ts`、`//cdn/segment.ts`
7. 跨源隔离：variant/segment/key 跳转到另一 origin
8. 认证恢复：HLS v1/v2 在 Host 重启后的重新授权
9. 容量边界：大量历史任务、超大 segment 数
10. 不合作进程：curl/FFmpeg 忽略或延迟退出
11. checkpoint 身份：`task_id` 与目录不一致、备份损坏
12. 状态收敛：事件和 `task.list` 乱序、迟到成功

---

## Gate 汇总

| Gate | 结果 |
|---|---|
| Native framing 基本边界 | PASS（源码证据） |
| 协议版本协商与混合版本 | FAIL |
| Native Host 状态权威 | PASS（架构归属） |
| 状态转换完整性 | FAIL |
| HTTP/HLS 凭据隔离 | FAIL |
| HLS checkpoint 版本与备份 | PASS（源码证据） |
| 顶层任务持久化可靠性 | FAIL |
| 重试边界 | 部分 PASS；普通 HTTP/幂等性 FAIL |
| 暂停/取消/停止一致性 | FAIL |
| Host 退出资源释放 | FAIL |
| FFmpeg 故障可观测性 | FAIL |
| 真实 Windows/浏览器/打包行为 | UNVERIFIED |
