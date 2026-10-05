# Chrome Web Store 商店资料

条目：流萤 StreamFirefly，扩展 ID `ooblmahffkiimlflhdnfojjemlibmhhj`，上传包 `release/StreamFirefly-extension-1.0.0.zip`。公开范围为公开。上传草稿的步骤见 [商店草稿准备](../docs/development/browser-stores.md)。

## 商品详情

名称和摘要取自包内清单，不能在后台修改。

- 类别：工具
- 语言：中文（简体）
- 官方网址：无。首页网址：`https://github.com/rumoii/streamfirefly`；支持信息页面网址：`https://github.com/rumoii/streamfirefly/issues`。提交审核前确认均可公开访问。
- 成人内容：关

说明：

```text
流萤是本地优先的网页媒体发现与下载工具。打开侧栏或页面内工作区，即可识别当前网页加载的视频、音频、图片以及 HLS、DASH 流媒体，并查看封面、大小、分辨率和时长。

主要功能
• 识别网页中的视频、音频、图片和流媒体资源，可按类型、名称和地址筛选
• 预览媒体，查看资源详情，复制资源地址
• 单个或批量下载，支持自定义文件名和保存目录
• HLS 解析：下载前选择清晰度、音轨和字幕，或按时间、切片截取片段，合并为 MP4
• 下载任务实时显示速度和进度，支持暂停、继续、失败重试和直播录制
• 悬浮工作区：在网页内展开完整的资源列表和详情
• 可按需把资源交给你自己配置的外部下载工具

使用前须知
下载由 Windows 本地下载助手执行，本扩展需要配合助手使用，目前仅支持 Windows。安装扩展后，请按安装指南安装同版本的本地助手。流萤不支持 YouTube。

隐私
流萤没有云端账号，不向开发者服务器上传浏览记录、下载记录或登录凭据。任务和设置保存在本机。下载所需的 Cookie 和 Authorization 只在下载期间临时使用，不写入任务记录。

流萤不绕过 DRM 或其他版权保护措施。请只下载你拥有版权、已获授权或法律允许下载的内容。
```

## 图片资源

| 位置 | 文件 | 规格 |
| --- | --- | --- |
| 商店图标 | `extension/icon128.png` | 128×128 |
| 屏幕截图 1 | `store-assets/screenshot-popup.png` | 1280×800，24 位无 alpha |
| 屏幕截图 2 | `store-assets/screenshot-downloads.png` | 同上 |
| 屏幕截图 3 | `store-assets/screenshot-workspace.png` | 同上 |
| 屏幕截图 4 | `store-assets/screenshot-hls.png` | 同上 |
| 小型宣传图块 | `store-assets/promo-small.png` | 440×280，24 位无 alpha |

顶部宣传图块（1400×560）为可选项，暂不提供。

截图由同名 HTML 模板以 1280×800 视口、缩放比 1 渲染生成，界面图片来自 `docs/images/`。界面更新后，应先重新生成 `docs/images/`，再重新渲染截图。`screenshot-popup.png` 和 `promo-small.png` 会被打进发布包，不要重命名。

## 隐私权

单一用途：

```text
识别当前网页加载的媒体资源，并按用户操作交给本机下载助手下载。
```

权限理由：

| 权限 | 理由 |
| --- | --- |
| `tabs` | 获取当前标签页的地址和标题，把发现的媒体关联到对应页面，并在页面关闭时清理结果。 |
| `webNavigation` | 页面导航时清除旧页面的媒体候选，避免把不同页面的资源混在一起。 |
| `webRequest` | 读取网页请求的 URL、响应类型和大小，用于识别媒体资源，并取得下载所需的请求头。 |
| `declarativeNetRequest` | 用户播放预览时，临时为媒体请求附加 Referer 等必要请求头，使预览能够加载。 |
| `storage` | 在本机保存设置、规则和界面状态。 |
| `scripting` | 在当前页面识别媒体元素和由脚本生成的媒体地址，并在用户打开时注入页面内工作区。 |
| `nativeMessaging` | 把用户确认的下载任务交给本机安装的流萤下载助手，并接收任务进度。 |
| `sidePanel` | 在浏览器侧栏中显示资源列表、下载任务和设置。 |
| `offscreen` | 运行可终止的规则计算 Worker，并在缓存捕捉期间保持与本机助手的连接。 |
| 主机权限 `http://*/*`、`https://*/*` | 媒体可能出现在任何网站上，扩展需要在用户访问的页面中识别媒体并发起下载。 |

远程代码：否，所有代码都打包在扩展内。

数据使用：如实勾选以下类别，然后勾选三项承诺（不向第三方出售或转让、不用于与单一用途无关的目的、不用于确定信用或贷款资格）：

- 身份验证信息：下载时临时使用的 Cookie 和 Authorization。
- 网络记录：媒体所在页面的地址。
- 用户活动：观察网页的网络请求以识别媒体。
- 网站内容：网页中的媒体地址和页面元素。

隐私政策网址：`https://github.com/rumoii/streamfirefly/blob/main/PRIVACY.md`。提交审核前确认可公开访问。

## 测试说明

```text
无需账号。下载功能需要 Windows 本地助手。
1. 在 Windows 11 上，从 https://github.com/rumoii/streamfirefly/releases/tag/v1.0.0 下载 StreamFirefly-1.0.0-windows-x64.zip 并解压。
2. 在解压目录运行 PowerShell：
.\tools\install.ps1 -ChromeExtensionId 'ooblmahffkiimlflhdnfojjemlibmhhj'
3. 重启 Chrome，打开 https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video
4. 点击流萤图标打开侧栏，资源列表显示页面媒体；点“下载”后在“下载”页查看进度。
未安装助手时仍可识别和预览媒体，但无法下载。
```

后台“其他说明”限 500 字。用户名和密码留空；仓库公开后把占位符换成 Release 地址，替换后仍须不超过 500 字。

## 提交审核前

- 仓库公开、v1.0.0 Release 发布后，用无痕窗口确认隐私政策、首页、支持、Release 四个地址都能公开访问，然后再提交审核。
- 宣传图上的“开源透明”在仓库公开后才成立，届时复核。
