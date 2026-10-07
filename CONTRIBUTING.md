# 贡献指南

English contributions are welcome. Please follow the same rules below.

## 提 issue

- 请用 [issue 表单](https://github.com/rumoii/streamfirefly/issues/new/choose)提交，并按要求填写版本、浏览器和复现步骤。
- 先把扩展和本地助手都更新到最新版，确认问题仍然存在。
- 一个 issue 只说一个问题，提交前先搜索已有 issue，包括已关闭的。
- 报告问题时附上诊断报告：扩展设置页 →“常规 → 问题反馈”→“导出诊断报告”。issue 是公开的，提交前请检查报告里的网页地址和标题。
- 安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## 提 PR

- 大的改动请先开 issue 讨论，避免做了之后方向不合适。
- 构建和测试方法见 README 的[从源码构建](README.md#从源码构建)和[开发](README.md#开发)。
- 提交前至少运行：

  ```powershell
  npm run typecheck
  npm run validate:extension
  npm run test:unit
  ```

  改了 `native-host/` 的话，再运行：

  ```powershell
  cargo test --manifest-path native-host/Cargo.toml
  npm run test:native
  ```

- 在 PR 说明里写清楚改了什么、为什么改，以及实际运行了哪些命令。

## 依赖升级

- `package.json` 里的依赖使用精确版本。
- 用 `npm install <包>@<版本>` 升级，让 npm 重新生成 `package-lock.json`，不要手改 lock 文件。
- 不要用 `overrides` 单独覆盖某个子包。同一组的包要一起升级，例如 `vue` 和全部 `@vue/*`。
- 升级后跑完上面的检查命令。

## 自动化工具和 AI 生成的 PR

可以用工具辅助，但提交人必须自己读过改动、在本地验证过，并在 PR 说明里写明验证方式。没有验证过的自动化 PR 会直接关闭。

## 不接受的改动

- 绕过 DRM 或其他内容保护
- 规避平台限制，例如让 Chrome 应用商店版识别 YouTube

## 许可

提交贡献即表示你同意按本项目的 [MIT 许可](LICENSE)发布你的贡献。
