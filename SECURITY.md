# 安全策略

[English](#english)

## 支持的版本

只为最新正式版修复安全问题。使用旧版本时请先升级到[最新版](https://github.com/rumoii/streamfirefly/releases/latest)，扩展和本地助手需要一起升级。

## 报告漏洞

请不要开公开 issue。到仓库的 [Security](https://github.com/rumoii/streamfirefly/security) 页点击 “Report a vulnerability”，[私下提交](https://github.com/rumoii/streamfirefly/security/advisories/new)。

报告中请写明受影响的版本、复现步骤和可能的影响，有概念验证更好。

## 重点范围

- 扩展与本地助手之间的 Native Messaging 通信
- 一键安装命令和安装脚本
- 下载文件和缓存捕捉的写入路径
- Cookie、Authorization 等凭据的处理
- 发送到外部工具（Aria2、HTTP 服务、本机程序、自定义协议）

## 不算漏洞的情况

- 流萤不绕过 DRM，这是有意的设计。
- 依赖扫描工具报告的漏洞，如果流萤的代码用不到相关功能（例如扩展从不使用 SSR），不构成可利用的问题。请说明它在流萤中实际会被触发的路径。

## 处理流程

流萤由个人维护，通常一周内回复。确认后会在修复版本发布时公开安全公告，并在版本说明中致谢报告者（如你同意）。

---

## English

Only the latest release receives security fixes. Please do not open a public issue. Report vulnerabilities privately via [Security → Report a vulnerability](https://github.com/rumoii/streamfirefly/security/advisories/new), including the affected version, reproduction steps and impact.

Areas of interest: Native Messaging between the extension and the native helper, the install command and scripts, file write paths, handling of cookies and authorization headers, and external tool integrations. Not bypassing DRM is by design. Dependency advisories for code paths StreamFirefly never reaches (such as SSR) are not considered vulnerabilities unless you can show a reachable path.

StreamFirefly is maintained by one person; expect a reply within about a week.
