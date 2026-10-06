# Decision: 页面开始时被动登记缓存捕捉媒体源

Status: implemented

随 1.0.3 发布；真实站点验收见 Verification。

## Problem

默认 `sniffMode: on_open` 在打开界面后才允许资源嗅探。此前 `probe.install` 同时异步注入捕捉探针；如果播放器先创建 MediaSource、Blob 地址和 SourceBuffer，后装探针无法追溯登记，后续 appendBuffer 也没有所属源的元数据。严格 Blob 匹配和手动选择都无法解决候选为空。

## Proposal

- 两个 manifest 静态声明 `capture-probe.js`，使用 `world: MAIN`、`run_at: document_start`、`all_frames: true`，覆盖 HTTP(S) 页面。资源发现仍由嗅探设置控制，动态 `probe.install` 只安装页面发现探针。
- 页面内存保留最近完整初始化段，包括解析暂存：512 KiB/SourceBuffer、4 MiB/框架。编码变化、缓冲移除或页面销毁使其失效。普通捕捉开始和新分段时补头，正文只复制开始后追加的数据。
- 推荐重新捕捉：授权后排空旧会话、记录一次性状态并刷新。来源页及对应 HTTP(S) 框架写入带随机 token 和有效期的一次性 sessionStorage 标记。MAIN 探针在 document_start 同步读取并删除标记，只有标记有效才从首次追加起暂存；后台 token 验证失败或 5 秒确认超时即丢弃；确认后最多 2 分钟完成来源选择和握手。暂存与队列共用 16 MiB/框架，超限停止。一次性状态保存于扩展会话存储，3 分钟失效，首次新文档领取后校验新来源四项身份。
- 未授权页面不复制早期正文；仅重新捕捉授权的那次刷新在页面内存暂存，确认新文档前不外发、不落盘。隐私政策和商店说明披露范围、预算和释放条件。
- Native 整理成功同时要求 FFmpeg 退出成功、progress 的 out_time_us 大于零，以及 Rust 解析输出容器的音视频轨道数和类型与有效输入一致；生产代码不依赖 ffprobe。失败保留原始轨道，区分无新增正文、缺初始化段、合并失败。
- revoke 后保留当前媒体源的历史 Blob 地址，每源最多 16 项、最多 64 个源。revoke 调用本身继续使用浏览器原始行为。
- 唯一精确匹配自动选择；多匹配供用户选择；零匹配时展示该标签页候选，并持续提示“未确认对应此 Blob”。手动选择必须重新确认授权，发送所选源身份，省略未经匹配的旧 Blob 地址。后端重新扫描并严格校验 source id、frameId、documentToken 和 sourceContextId。
- 通用版和商店版共用探针。`tools/extension-manifest.mjs` 在商店打包阶段从 `platform.js` 的站点策略生成静态脚本排除项，不复制站点名单。Firefox 继续通用版策略。
- 刷新来源页面状态后重新扫描；捕捉进行中不启动重复扫描。

## Alternatives considered

- 仅保留 revoke 地址和允许手选：能修复有候选但匹配失败的情况，无法补救安装前已创建的源。
- 继续打开界面后异步注入：刷新后仍与播放器创建时机竞争，无法稳定保证登记。
- 在 appendBuffer 懒登记：SourceBuffer 没有公开反查所属 MediaSource 或原始 MIME 的接口，无法构建可靠身份；晚装也无法补回初始化段。本次不采用。
- 仅缓存初始化段：不能解决正文已全部缓冲且重播不追加，因此与刷新后重新捕捉组合。

## Risks

常驻 MAIN hook 扩大页面代码接触范围，可被页面篡改；它不具有扩展 API 权限。静态登记不代表回溯浏览器缓存，不保证恢复完整文件。原有 Native 路径要求轨道首段包含初始化信息，缺失时可能只保留原始片段。

MAIN 内容脚本自 Chrome 111、Firefox 128 支持；项目现有最低版本 Chrome 141、Firefox 142 已覆盖，无需变更版本或 Firefox ID。兼容事实参考 [MDN 内容脚本说明](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts)及 [MDN 兼容数据](https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/content_scripts.json)。

常驻被动登记须在隐私政策和商店用途说明中披露，包括未打开界面时处理的网站内容、内存保留范围和捕捉开始后才复制数据。[Chrome 商店用户数据说明](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)要求本地处理也如实说明；[Limited Use 政策](https://developer.chrome.com/docs/webstore/program-policies/limited-use)约束处理用途。符合声明不等于通过商店审核。

## Verification

回归覆盖相同 viewState 刷新不重启预览、三种排序模式的 Blob 后置、被动登记及容量边界、revoke 地址保留、零匹配与多匹配选择、严格身份拒绝、刷新重扫及商店排除项。

浏览器夹具在页面首个播放器脚本前验证探针存在，创建并 revoke MediaSource 地址，打开界面后校验身份保持和主框架桥接，登记阶段不发送媒体片段。真实 X、B 站按 [验收步骤](../../development/blob-capture-acceptance.md)进行 A/B 对照，尚未完成真实站点和初始化段可用性验收。

2026-10-06 本地执行 `npm run typecheck`、`npm run validate:extension`、`npm run test:unit` 通过，前端共 163 项测试。Chrome、Edge、Firefox 的 `test-browser-extension.mjs` 通过上述被动登记夹具；Chrome `--capture` 使用已有完整 FFmpeg，通过页面到 offscreen/WebSocket 合成接收端及停止排空。通用版和商店版打包通过，商店 manifest 含 6 项策略排除，Firefox lint 通过。新增记录的格式与链接校验通过；全库决策校验仍有 7 项旧文档格式错误，涉及三个未修改文件。

2026-10-06 在 Edge 真机验收（测试构建，Native 输出用测试版 ffprobe 核验）：X 的晚开始在视频已全部缓冲时正确报告无新增数据；X 的重新捕捉输出 1920×1080 h264+aac、10.6 秒；B 站的重新捕捉输出 1280×720 h264+aac 两段（跳转分段），分别 25.0 秒和 82.2 秒。小红书、真实 ARM64 设备和两小时持续捕捉未覆盖。

## Rollback

同时撤回静态 MAIN 声明并恢复 background 的动态捕捉探针注入；同步撤回商店 manifest 生成和相关声明。无需 Native 协议、持久数据或 Firefox ID 迁移，已有捕捉文件不删除。重新加载扩展并刷新来源页，使页面旧 hook 退出。
