# StreamFirefly 1.0.3 安装指南

流萤由两部分组成，两部分都要装好才能下载视频：

1. **浏览器扩展**：负责在网页里找到视频。
2. **本地下载助手**：一个装在电脑上的小程序，负责把视频真正下载、合并成文件。浏览器扩展本身没有权限往硬盘写大文件，所以需要它。

整个过程大约 5 分钟，不需要管理员权限，也不需要懂命令行。

## 开始前确认

- **系统**：Windows 11（64 位或 ARM64）。
- **浏览器**：Chrome 或 Edge 141 及以上，或 Firefox 142 及以上。查看版本：在浏览器地址栏输入 `chrome://settings/help`（Edge 输入 `edge://settings/help`，Firefox 在“帮助 → 关于 Firefox”）。
- **网络**：安装包放在 GitHub 上。国内网络访问 GitHub 可能很慢或打不开，**建议先打开代理工具**（系统代理或 TUN 模式都可以，安装命令会自动使用系统代理）。

## 第一步：安装浏览器扩展

根据你用的浏览器，选一种方式即可。

### 方式 A：Chrome 应用商店（最简单）

1. 用 Chrome 打开 [流萤的商店页面](https://chromewebstore.google.com/detail/ooblmahffkiimlflhdnfojjemlibmhhj)。
2. 点击“添加至 Chrome”，再点“添加扩展程序”。

> 商店版遵守 Chrome 应用商店政策，**不能下载 YouTube 视频**，其他网站不受影响。需要 YouTube 请用方式 B。

### 方式 B：通用版（Chrome / Edge，所有网站都能用）

1. 打开 [最新版本下载页](https://github.com/rumoii/streamfirefly/releases/latest)，在页面下方的 Assets 里点击 `StreamFirefly-extension-1.0.3.zip` 下载。
2. 在下载的压缩包上点右键 →“全部解压缩”，**把解压出来的文件夹放到一个不会被删除的位置**，比如 `D:\软件\流萤`。
   > 这个文件夹就是扩展本身，以后**不要删除或移动它**，否则扩展会失效。
3. 打开扩展管理页：Chrome 在地址栏输入 `chrome://extensions`，Edge 输入 `edge://extensions`，回车。
4. 打开右上角（Edge 在左侧）的“**开发者模式**”开关。
5. 点击“**加载已解压的扩展程序**”，选择第 2 步解压出来的文件夹（里面能看到 `manifest.json` 文件的那一层）。
6. 看到“流萤 StreamFirefly”出现在列表里就成功了。建议点浏览器右上角的拼图图标，把流萤**固定**到工具栏，方便以后使用。

> 浏览器有时会提示“请停用开发者模式扩展”，点“保留”或直接关掉提示即可，不影响使用。

### 方式 C：Firefox

1. 打开 [最新版本下载页](https://github.com/rumoii/streamfirefly/releases/latest)，下载 `StreamFirefly-firefox-1.0.3-signed.xpi`。
2. 在 Firefox 地址栏输入 `about:addons` 回车，点右上角齿轮 →“从文件安装附加组件”，选择刚下载的文件，按提示确认。

## 第二步：一键安装本地下载助手

扩展装好后会自动打开流萤的设置页（没打开的话，点工具栏里的流萤图标，界面上也会提示安装）。

1. 点击“**复制安装命令**”。
2. 按键盘上的 <kbd>Win</kbd> + <kbd>R</kbd>（Win 是带 Windows 图标的键），屏幕左下角会弹出“运行”小窗口。
3. 按 <kbd>Ctrl</kbd> + <kbd>V</kbd> 粘贴，再按回车。
4. 会弹出一个黑色窗口，依次显示“正在下载”“校验通过，正在安装”，最后出现绿色的“**安装完成**”。按回车关闭窗口。
5. 回到浏览器，流萤会自动连接本地助手，设置页里显示“已连接”就全部完成了。

> 如果同时在 Chrome 和 Edge 里使用流萤，需要在另一个浏览器的流萤里再复制一次命令、再运行一次。

## 第三步：开始下载

1. 打开一个有视频的网页，让视频开始播放。
2. 点击工具栏里的流萤图标，“资源”页会列出找到的视频。
3. 在想要的视频上点“**快速下载**”或“**下载**”，进度可以在“下载”页查看。

**下载的文件在哪里？** 默认保存在 `%LOCALAPPDATA%\StreamFirefly\downloads`（把这串文字粘贴到文件资源管理器的地址栏即可打开）。建议在流萤的“设置”里把下载目录改成你常用的文件夹，比如 `D:\下载`。

**列表里的视频下载不了？** 有些网站不提供可直接下载的地址，这类视频在列表底部，按钮是“**缓存捕捉**”。点它之后按页面上的步骤操作：勾选授权 → 点“一键捕捉” → 来源页会自动刷新并从头播放 → 播完自动保存成文件。

## 常见问题

**运行命令后黑窗口一直卡住，或者提示“下载失败”**
大多是连不上 GitHub。打开代理工具后，按 <kbd>Win</kbd> + <kbd>R</kbd>、<kbd>Ctrl</kbd> + <kbd>V</kbd>、回车，重新运行同一条命令即可（命令还在剪贴板里）。实在不行，可以按下文“手动安装”操作，用浏览器下载安装包。

**提示“本地助手正在使用中”**
关闭所有浏览器窗口，再重新运行同一条命令。

**流萤一直提示“尚未安装本地助手”**
确认黑色窗口里出现过“安装完成”；如果是换了浏览器，需要在新浏览器的流萤里重新复制命令再运行一次。仍不行时，重启浏览器后再看。

**通用版扩展突然不见了或无法使用**
多半是第一步解压出来的文件夹被删除或移动了。重新下载解压，放回固定位置，再“加载已解压的扩展程序”。

**为什么商店版不能下载 YouTube？**
这是 Chrome 应用商店的政策要求。需要的话请改用通用版（方式 B），两个版本不要同时安装在同一个浏览器里。

## 升级

新版本发布后：

1. 先等正在进行的下载完成。
2. 更新扩展：
   - 商店版会由 Chrome 自动更新。
   - 通用版：下载新版本的扩展压缩包，**解压覆盖到原来的文件夹**，再到扩展管理页点流萤的“重新加载”。
   - Firefox：下载新版本的 `.xpi` 文件，按“方式 C”重新安装一次。
3. 回到流萤设置页，复制新的安装命令，再运行一次，本地助手就会升级到同一版本。

扩展和本地助手请保持同一个版本。两者不兼容时，流萤会直接显示“一键更新本地下载助手”。

## 卸载

1. 关闭所有浏览器。
2. 按 <kbd>Win</kbd> + <kbd>R</kbd>，粘贴下面这行并回车，卸载本地助手：

   ```text
   powershell -ep Bypass -f "%LOCALAPPDATA%\StreamFirefly\package\1.0.3\tools\uninstall.ps1"
   ```

3. 在浏览器的扩展管理页移除流萤。

卸载不会删除你已经下载的视频、下载记录和设置。

---

## 进阶说明

以下内容面向需要手动部署或排查问题的用户。

### 一键安装做了什么

命令从同一版本的 Release 下载 `StreamFirefly-install.ps1` 和对应架构的完整包，按脚本内记录的 SHA-256 校验后安装，并只为当前浏览器注册本地助手；完整包保留在 `%LOCALAPPDATA%\StreamFirefly\package\<版本>`。命令和脚本会自动使用 Windows 系统代理；已设置 `HTTPS_PROXY` 等环境变量时以环境变量为准。

### 手动安装完整包

从 [Releases](https://github.com/rumoii/streamfirefly/releases/latest) 下载完整包，并先核对同一 Release 的 `SHA256SUMS.txt`：

- Windows x64：`StreamFirefly-<版本>-windows-x64.zip`
- Windows ARM64：`StreamFirefly-<版本>-windows-arm64.zip`
- 通用版 Chromium 扩展：`StreamFirefly-extension-<版本>.zip`
- Firefox 签名扩展：`StreamFirefly-firefox-<版本>-signed.xpi`

完整包包含本地助手和对应架构的 FFmpeg，安装时无需下载依赖。

1. 解压完整包到固定目录，保留整个目录结构。
2. 按“第一步”安装扩展；包里的 `extension` 文件夹和签名 XPI 都是通用版。记录 Chrome/Edge 扩展管理页显示的扩展 ID。Chrome 应用商店版的扩展 ID 固定为 `ooblmahffkiimlflhdnfojjemlibmhhj`。
3. 在包根目录打开 PowerShell，安装本地助手。通过 Chrome 应用商店安装流萤时运行：

   ```powershell
   .\tools\install.ps1 -ChromeExtensionId 'ooblmahffkiimlflhdnfojjemlibmhhj'
   ```

   开发者模式加载或同时使用 Edge 时，填写各浏览器实际显示的扩展 ID。不使用的 Chromium 浏览器可以省略对应参数。Firefox ID 已固定。

   ```powershell
   .\tools\install.ps1 -ChromeExtensionId '<Chrome ID>' -EdgeExtensionId '<Edge ID>'
   ```

4. 重新启动浏览器，打开普通网页并点击流萤图标，在设置中确认本地助手已连接。

本地助手默认安装到 `%LOCALAPPDATA%\StreamFirefly\bin`，只注册当前用户的 Native Messaging，不需要管理员权限。不支持的架构会被拒绝。`PACKAGE-INFO.json` 记录版本、架构、构建工具和源提交；内部 `SHA256SUMS.txt` 覆盖包内文件。卸载脚本位于完整包的 `tools\uninstall.ps1`；曾使用自定义 `-InstallDir` 时，卸载也要传入同一路径。

### 升级回滚与数据备份

升级前可以关闭浏览器，备份 `%LOCALAPPDATA%\StreamFirefly\tasks.json`、同目录的 `tasks` 文件夹、扩展导出的配置和已下载文件，并保留上一版本的完整包。失败时关闭浏览器，重新安装上一版本的助手和扩展，并恢复备份。不要混用两个版本，也不要在任务运行中覆盖程序。

未知版本或损坏的任务文件会使助手停止写入；请保留原文件排查，勿删除任务文件作为升级步骤。

### 验证范围与许可证

Release 的 Windows x64 验证使用隔离环境和该 Release 的实际附件。ARM64 包构建并核验 PE 架构及文件完整性；真实 ARM64 设备、真实网站覆盖及 7200 秒持续捕捉不属于该验证，不能由构建成功推断。

项目代码采用 MIT；捆绑依赖各自的许可证见 `LICENSE`、`extension/THIRD_PARTY_NOTICES.md`、`native-host/THIRD_PARTY_NOTICES.md` 和 `native-host/FFMPEG-LICENSE.txt`。

本地助手捆绑的 FFmpeg 是按 LGPL 2.1 自行编译的精简版，只用于合并媒体和转换字幕。对应源码和构建脚本在同一 Release 的 `StreamFirefly-ffmpeg-source-<版本>.tar` 中，说明见包内 `native-host/FFMPEG-SOURCE.txt`。
