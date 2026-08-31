# Chrome Web Store 内测资料

发布渠道：Private，测试人员通过 Google 群组管理。

## 商店文案

名称：流萤 StreamFirefly

简短说明：本地优先的网页媒体发现、预览与下载工具。

详细说明：

> THIS EXTENSION IS FOR BETA TESTING.
>
> 流萤可以识别当前网页加载的视频、音频、图片及 HLS/DASH 媒体资源，显示资源大小、分辨率、时长和预览，并通过本机下载助手保存到用户选择的目录。下载任务支持自定义文件名、实时速度和进度、多连接下载以及任务记录管理。
>
> 流萤不提供云端账号，任务和设置保存在用户本机。Cookie 和 Authorization 只在当前下载期间临时使用，不写入任务历史文件。流萤不绕过 DRM，请仅下载自己拥有版权或已获授权的内容。

隐私政策：使用仓库中的 `PRIVACY.md`，提交审核前必须确保对应 URL 对商店审核人员和测试用户公开可访问。

## 提交清单

- `release/StreamFirefly-extension-0.7.0.zip`；
- 128×128 扩展图标：`extension/icon128.png`；
- 440×280 小型宣传图：`store-assets/promo-small.png`；
- 1280×800 界面截图：`store-assets/screenshot-popup.png`；
- 隐私实践表单按 `PRIVACY.md` 如实填写；
- 创建 Private 测试条目并记录商店分配的正式扩展 ID；
- 使用正式 ID 运行 `tools/prepare-release.ps1`，不要把开发 ID 构建的安装包交给测试人员。
