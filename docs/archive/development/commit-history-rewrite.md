# 提交历史署名规范化改写

2026-09-16 对 `main` 的提交历史执行过一次署名规范化改写。

## 改写范围

历史重写阶段仅规范化提交元数据：统一 author 与 committer 身份，并移除提交消息中的协作者声明行。该阶段未改动任何提交的内容，重写前后对应提交的 Git tree 完全一致，提交数量、顺序、拓扑以及 author/committer 日期均保持原样。

历史重写完成后，另以普通提交同步更新依赖旧提交 SHA 的 CI 门禁，并增加本说明。

## 对历史引用的影响

改写前记录的所有提交哈希已无法在当前仓库中直接解析，包括：

- `docs/` 各记录中引用的提交哈希；
- GitHub Actions 历史运行记录中的 `head_sha`；
- 已发布内测包 `PACKAGE-INFO.json` 中的 `sourceCommit`。

这些记录中的判定结论仍以对应的 Actions 运行记录与产物为准，但无法再通过仓库中的提交哈希直接定位。`docs/` 中受影响的历史记录已在顶部加注说明。

## 对发布流程的影响

`.github/workflows/package-internal.yml` 的源码祖先校验原先指向改写前的提交，现已同步指向其等价提交；`tools/test-internal-packaging.mjs` 中的对应断言同时更新，两者保持同值。
