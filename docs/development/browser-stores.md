# Chrome 与 Edge 商店草稿

先上传草稿取得商店扩展 ID，再配置本地助手和准备审核材料。上传草稿不等于提交审核或发布；完整发布验收见[正式发布流程](release.md)。

## 准备上传包

在依赖已按锁文件安装的仓库根目录运行：

```powershell
.\tools\package-extension.ps1
```

产物为 `release\StreamFirefly-extension-1.0.1.zip`，ZIP 根目录包含 Chromium 的 `manifest.json` 和批准的运行时文件。Chrome 和 Edge 使用这个 ZIP；Firefox 使用单独的 Mozilla 签名 XPI。

当前 Chromium 清单没有 `update_url`，名称和描述无需浏览器品牌替换。使用的 `sidePanel`、`offscreen`、`scripting`、`declarativeNetRequest` 等 API 在 Microsoft 的[支持列表](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)中；实际浏览器行为仍须通过项目测试。最低浏览器版本为 Chrome／Edge 141。

## Chrome 草稿

1. 登录 [Chrome Web Store 开发者后台](https://chrome.google.com/webstore/devconsole)，选择添加新内容。
2. 选择上述 ZIP，等待包校验完成并进入条目编辑页。
3. 记录该条目的扩展 ID、上传版本和 ZIP 的 SHA-256，保留草稿。

后续补齐商店说明、截图、权限用途、隐私声明和本地助手安装说明，再单独提交审核。完整流程见 [Chrome 官方发布说明](https://developer.chrome.com/docs/webstore/publish)。

## Edge 草稿

1. 登录 [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview)，使用 Microsoft Edge 扩展开发者账户创建扩展。
2. 在包上传页面选择同一个 Chromium ZIP，保存草稿。
3. 记录商店提供的 **Extension ID**、上传版本和包哈希。Extension ID 是 32 个 `a` 到 `p` 的小写字符；不要把 Partner Center 产品 ID 当作扩展 ID。

入口标签可能随后台调整，按 [Edge 官方发布说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)操作。若后台提示包错误，保留错误信息并检查，不自动更改版本或创建重复条目。

## Native Messaging

Chrome、Edge 的商店 ID 分别配置，不能用开发模式加载时的 ID 代替。取得两个实际 ID 后，在经过验收的完整 Windows 包根目录安装助手：

```powershell
.\tools\install.ps1 -ChromeExtensionId '<Chrome 商店扩展 ID>' -EdgeExtensionId '<Edge 商店扩展 ID>'
```

仅使用一个浏览器时省略另一个参数。安装工具分别注册 Chrome 和 Edge 的 Native Host，每个清单的 `allowed_origins` 使用对应的 `chrome-extension://<商店扩展 ID>/`；Firefox 使用固定 ID `streamfirefly@example.invalid`。Microsoft 的[迁移指南](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension#setting-allowed_origins-for-a-native-app)说明了 Edge 商店 ID 的要求。

只有完成真实扩展安装、助手连接和下载验证，才能记录 Native Messaging 已通过。草稿阶段仅记录商店 ID 与预期注册值；待签名安装、依赖源码交付和最终包验收完成后，按正式发布流程推进。
