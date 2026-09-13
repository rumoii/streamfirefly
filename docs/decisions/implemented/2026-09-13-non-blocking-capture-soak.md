# Decision: 将长时捕捉改为非阻断诊断

Status: implemented

## Problem

内测打包流程同时承担源码与产物门禁、短安装态验收和 7200 秒长期诊断。长时运行会重复安装前的全部构建与短测，且 Windows 进程采样基础设施的瞬时失败可能在媒体长测开始前阻止产物上传。这样无法区分“构建或短链路不合格”和“长期稳定性尚未取得结论”，也使已经通过审计的同一批产物无法被独立复测。

## Decision

`Package internal test bundles` 继续作为唯一发布门禁，要求最终 main SHA 的干净源码、类型与单元检查、三浏览器检查、真实 Native、双架构构建与包审计、Chrome 60 秒、Edge 短链路以及卸载清理全部成功。该流程不接受长测时长，也不运行 7200 秒捕捉。

`Diagnose installed capture` 作为手动 Windows 诊断，接收成功短流程 run ID、完整源码 SHA、bundle 版本和 60 或 7200 秒时长。它必须验证来源工作流、成功状态、main 分支和 SHA，以固定 Action SHA 跨 run 下载同一批产物，复核外层哈希及两个包的版本、架构、源码 SHA 和干净状态，再隔离安装 x64 包运行 Chrome 捕捉。

诊断捕捉、进程收尾、注册表移除或安装目录清理任一失败时，工作流保持红色并尽可能上传证据。诊断不生产发布附件，也不改变成功短流程的结论；完整 7200 秒未成功时只能表述为“长期稳定性仍待验证”。该政策适用于 Beta 5 及后续内测版本。

## Alternatives considered

- 保留 7200 秒硬门禁：能把长期观察绑定到发布，但会让独立采样基础设施故障覆盖已经成立的短链路与产物证据，并重复昂贵构建。
- 删除长时测试：流程最简单，但失去发现缓慢内存增长、长时收尾和 Runner 调度异常的诊断能力。
- 在打包流程中忽略长测错误：会产生表面绿色而内部失败的运行，削弱失败可见性，因此不采用。

## Consequences

- Release 可以在没有完整 7200 秒成功结论时发布，不能把短流程结果扩张为长期稳定性证明。
- 独立诊断依赖来源 artifact 的保留期限；过期后必须重新运行短流程，不能改用来源不明的本地包。
- 诊断工作流仍依赖 GitHub Runner、浏览器和 Windows 进程查询，红色结论需要结合捕捉报告与清理证据解释。

## Verification

提案阶段验证了工作流 YAML、仓库门禁测试、完整单元测试和决策记录结构。提交推送后以最终源码提交 `6562ea87585c8e102f10f31423a60c253496640f` 取得以下远端与产物证据：

- 短打包流程 [34758074211](https://github.com/rumoii/streamfirefly/actions/runs/34758074211) 成功，覆盖源码行为检查、三浏览器测试、双架构构建与包审计、x64 安装态 Chrome 60 秒与 Edge 捕捉、Native 卸载清理。
- 产物 `StreamFirefly-0.10.0-beta.5-internal-x64.zip` 外层 SHA-256 为 `8ed068521ff75056595fe9909b5757385af05d46e8deef824e7decd873965fd6`，ARM64 外层 SHA-256 为 `f97d0a3327631a24af5588aa2fd5d79046a7e0feaff6c7308793a89aef3f0def`，均与包内 `INTERNAL-SHA256SUMS.txt` 一致；两个 `PACKAGE-INFO.json` 记录同一源码提交、对应架构和 `sourceDirty: false`。
- 独立诊断流程 [34760799359](https://github.com/rumoii/streamfirefly/actions/runs/34760799359) 以 60 秒模式成功，跨 run 下载、包身份审计、隔离安装、捕捉、证据上传与清理全部通过。
- Pre-release `v0.10.0-beta.5` 已在 `rumoii/streamfirefly-internal-releases` 发布，附件为上述两个 ZIP 与该校验清单。

## Rollback

如需恢复长测硬门禁，在发布任何受影响版本前，将 7200 秒步骤重新放回打包工作流的安装态测试和上传之前，恢复仓库门禁断言及发布文档，并以最终 SHA 重新生成全部附件。不得用新政策下已发布或已下载的旧 run 产物补做后宣称满足恢复后的门禁。
