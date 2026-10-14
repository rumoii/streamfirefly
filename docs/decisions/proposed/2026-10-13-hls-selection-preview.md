# Decision: HLS 所选范围播放预览（Issue #14）

Status: proposed

## Problem

在 HLS 解析页，只有创建下载任务后才能确认所选的画质、音轨和范围是否正确。用户需要在下载前手动播放所选主视频范围及对应音轨，同时满足三点：不扩大现有鉴权边界，不改变下载的合并方式，预览失败不阻断下载。

## Proposal

- 范围卡片里增加“播放所选范围”入口，全部、按切片、按时间三种模式共用。只有点击后才准备媒体和密钥；进入页面或修改选择都不会自动播放。预览完全在浏览器内完成，不依赖本地助手的能力。
- 点击时捕获一份选择快照 `captureHlsSelection`，内容包括候选与来源、画质、音轨、范围与实际边界、keyOverride。预览和下载用同一份快照调用 `buildHlsPlan`，预览以计划里的 `videoManifest`、`audioManifest`、`range` 和 `duration` 为准。修改画质、音轨、范围或密钥后快照作废，预览组件随之卸载并释放资源；字幕、文件名和保存目录的修改不影响预览。
- 外置音轨清单通过解析页已有的 `loadTrack()` 获取（带缓存），复用 `media.fetchText`。预览传可选的 `restrictOrigin: true`，只在候选同源请求里重放来源凭据；跨源请求不带候选头部或登录信息。缓存按轨道 URL 与模式区分，下载保持默认行为，不新增消息类型。
- `hls-selection-preview.ts` 为每个会话建立虚拟清单映射：master 只声明所选的一路画质和一条外置音轨。播放清单由 pLoader 从内存应答，未知的虚拟地址直接失败，不会发出 HTTP 请求。真实分片、MAP 和清单自带的 AES 密钥交给 hls.js 默认 loader，保留 Range 和 abort 行为。手动 Hex/Base64 密钥只在内存中解码；密钥 URL 由可取消的 loader 获取，且必须正好 16 字节，请求时不带页面登录信息。
- `HlsSelectionPreview.vue` 的状态机为 idle → preparing → playing ↔ paused → ended / failed。进度按 `0..plan.duration` 显示，不使用包含音轨尾部的 `media.duration`；终点由 100ms 定时检查加 timeupdate/seeking/ended 事件共同判定，到点即暂停并停止加载。到达终点后重播直接在原会话里跳回起点。准备期上限 15 秒；网络和媒体的致命错误各最多恢复一次；遇到 401/403 或密钥错误直接失败。
- 鉴权沿用 `preview.headers.apply` / `clear`，规则限定在候选 origin 内。同 tab 的安装与清理串行；整 tab 清理立即使此前的待安装操作失效，并删除迟到安装的规则。删除失败保留登记，便于再次清理；无规则且队列空闲时释放状态。

## Alternatives considered

- 浏览器原生播放完整 m3u8：无法限定所选轨道和范围，也不支持手动密钥，不采用。
- 由本地助手先下载合并再播放：要多生成文件、多等待，与“下载前确认”的目标不符，不采用。
- 让 FFmpeg 按主视频时长截断音轨：会改变现有下载产物，超出本次范围，不采用。
- 新增后台取消消息来中止音轨清单请求：清单很小，迟到的响应在前端丢弃即可，不值得新增后台状态。

## Risks

- 音视频对齐依赖容器时间戳，discontinuity 跨段的表现依赖 hls.js 和浏览器解码器。
- 浏览器的编解码支持各不相同；无法解码时会局部提示失败，可以改用下载。
- 需要登录的密钥 URL 能下载但不能预览，界面会明确提示原因。

## Verification

- `npm run typecheck`、`npm run test:unit`、`npm run validate:extension`。
- 手动运行 `npm run test:hls:preview -- --browser=chromium`，需要 Playwright 浏览器和 ffmpeg。该脚本用构建后的工作区播放本地生成的 TS/fMP4、AES、ByteRange 和 discontinuity 夹具，校验所选画质、音轨、终点和清理行为；扩展消息层由夹具代替。
- `npm run test:hls:preview -- --auth-only` 独立加载无头 Chromium 构建扩展，用双 origin 检查实际凭据边界、重定向、下载默认行为、Cookie 规则范围和活跃规则关 tab 清理。后台回归另验证规则安装与关闭交错、删除失败后重试。
