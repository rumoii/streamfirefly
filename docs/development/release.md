# 正式发布流程

正式发布使用同一个干净的 `main` 提交；版本须同时出现在 npm、扩展清单、Cargo、安装器和安装指南中。历史内测工具保留供旧版本使用。

1. 运行 `npm ci`、`npm run verify:release:source`、`npm run validate:extension`、`npm run typecheck`、`npm run test:unit`。Windows 打包验证使用 `npm run test:release:packaging`。
2. 对该提交运行 Actions 的 **Verify release source**，要求所有步骤通过，包括三个浏览器的基础与发现测试、Native 下载链路、Windows 子进程测试和两个架构的构建。
3. 检查 Firefox 固定 ID `streamfirefly@example.invalid` 的版本占用，再用 `web-ext sign --channel unlisted --upload-source-code <可读源码 ZIP>` 提交构建运行时。凭据仅由本地受保护输入传入环境变量，不进入 Git、日志、包或 GitHub Secrets。可读源码 ZIP 只包含 Git 跟踪的扩展、界面、共享代码、构建工具和依赖锁文件，不包含本地状态、凭据和 Native 二进制。
4. 只有取得已签名 XPI 后，执行 `tools/verify-signed-firefox.ps1` 校验运行时代码。版本冲突、审核等待、签名或下载失败时停止；不得自动更换扩展 ID、提高版本或用未签名包替代。
5. 在干净提交执行：

   ```powershell
   .\tools\package-release.ps1 -SignedFirefoxXpi '<匹配当前提交的签名 XPI>'
   ```

6. 校验 FFmpeg 对应源码和构建资料可取得，按其独立许可证要求交付；许可证链接不代表对应源码已经核验齐全。项目 MIT 不覆盖 FFmpeg。
7. 创建指向该完整 SHA 的 `v1.0.0` 草稿 Release，上传两个 Windows ZIP、独立 Chromium ZIP、签名 XPI 和 `SHA256SUMS.txt`。不上传测试用 XPI、EXE 安装器或不同提交的附件。
8. 运行 **Verify draft release**，传入草稿的数字 ID 和完整源 SHA。此工作流重新下载草稿附件，核对完整资产集合、内外哈希、两种 PE 架构及来源元数据，再从实际包安装 x64 助手，验证 HTTP/HLS/DASH、队列、发现下载、捕捉、卸载。Firefox 在独立持久配置中以正常签名要求永久安装，重启后再次验证扩展和 Native Messaging；临时安装不能替代该验证。
9. 完成旧版本到新版本的升级、回滚和数据保留验证。真实 ARM64 硬件、真实网站覆盖和 7200 秒捕捉另行记录，不作为已通过事实。
10. 所有必需证据齐全后，发布稳定 Release。公开仓库由维护者另行决定。任何包内文件改变后，重新打包、审计、上传和运行附件验证。

`tools/package-release.ps1` 没有允许脏工作区或未签名替代包的开关。`tools/verify-release-assets.ps1` 核对五个正式附件，`tools/audit-release.ps1` 审计包结构和内部哈希。Mozilla 签名元数据检查只能证明文件存在；真实签名接受性由 Firefox 的永久安装验证证明。
