# Decision: 一键捕捉优先录制 H.264

Status: proposed

## Problem

B 站等网站会按浏览器能力挑选编码，Chrome/Edge 支持 AV1，所以拿到的往往是 AV1（有时是 HEVC）。录制只保存网站发来的数据，成品自然也是 AV1。Windows 自带的“媒体播放器”默认不带 AV1 解码器，打开后只有声音没有画面，用户会以为录坏了。2026-10-08 用 4 倍速实测 B 站，录到的就是 AV1 640×360 的视频。

流萤合并时不转码，捆绑的 FFmpeg 是精简的 LGPL 版本，没有视频编码器，所以无法在录完之后转成 H.264。

## Proposal

- 录制面板新增“一键捕捉时优先录制兼容格式（H.264）”开关，默认开启，保存在 `storage.local.captureCompatibleCodecs`。
- 一键捕捉写入刷新标记时，带上 `compatible`（`extension/src/capture-restart.js` → `capture-content.js` → sessionStorage）。
- MAIN 世界探针在 document_start 读取标记。只有标记有效且 `compatible === true` 时，才在这一次加载的文档里包装三个接口，对 `av01`、`hev1`、`hvc1`、`dvh1`、`dvhe` 一律回答“不支持”：
  - `MediaSource.isTypeSupported`；
  - `HTMLMediaElement.prototype.canPlayType`；
  - `navigator.mediaCapabilities.decodingInfo`。
  H.264、VP9 和音频编码不受影响。网站于是改发 H.264，录出来的文件在任何播放器里都能放。
- 普通浏览、高级选项里的“开始捕捉”、没有标记的页面一律不挂这层包装。
- 无论开关如何，只要录到 AV1 或 HEVC，录制记录里都会提示要安装对应的系统扩展，或者改用 VLC、PotPlayer 播放。

## Alternatives considered

- 录完后转码：需要带视频编码器的 FFmpeg，会牵涉 GPL 或专利授权，而且长视频转码很慢。不采用。
- 只加提示，不改网站行为：普通用户仍然要自己去装解码器。所以保留提示作为兜底，但不单独依靠它。
- 在所有页面都隐藏 AV1：会改变用户日常看视频时的画质和流量。只在用户主动发起的那次刷新里生效。

## Risks

- H.264 码率更高，同样的画质文件更大；有些网站的 H.264 清晰度档位比 AV1 少。
- 只提供 AV1 或 HEVC 的网站，在包装生效后可能无法播放，这时用户要取消开关再重试。界面文案已说明开关只影响一键捕捉。
- 刷新标记放在页面可写的 sessionStorage 里，页面可以伪造带 `compatible` 的标记。后果只是这个页面自己改用 H.264，不会越过扩展边界。
- 网站也可能通过其他途径判断编码能力（比如 UA 或服务端配置），那样包装就不起作用。此时还有录制记录里的提示兜底。

## Verification

- `tools/test-capture-probe.mjs`：标记带 `compatible` 时，AV1/HEVC 在三个接口里都显示为不支持，H.264 和 VP9 不受影响；不带标记时，三个接口都是浏览器原来的实现。
- `tools/test-capture-restart.mjs`：标记默认带 `compatible: true`，关掉开关后为 false。
- `extension-ui/src/features/capture/state.test.ts`：开关默认勾选，状态会被记住；AV1 提示能正常显示。
- 待用户实测：在 B 站一键捕捉，确认录到的是 `avc1`，并且系统播放器能直接播放。
