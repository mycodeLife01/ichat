# Issue Tracker：本地 Markdown

本项目使用 `.scratch/` 下的 Markdown 文件管理 PRD 和实施任务，不使用外部 issue tracker。外部 PR 不属于 triage 请求入口。

## 约定

- 每项工作使用独立目录：`.scratch/<feature-slug>/`。
- 功能目标和 ticket 索引写入 `.scratch/<feature-slug>/PRD.md`。
- 每张实施 ticket 使用独立文件：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，编号从 `01` 开始。
- Ticket 顶部使用 `Type:`、`Status:` 和 `Blocked by:` 记录类型、triage 状态和阻塞编号。
- `Status` 使用 `docs/agents/triage-labels.md` 定义的状态名称。
- `Blocked by: None` 表示可以立即开始；否则列出所有阻塞 ticket 编号。
- 讨论记录追加到对应 ticket 的 `## Comments` 小节，不覆盖历史内容。

## 技能发布任务时

创建或更新对应 feature 目录下的 `PRD.md` 和 `issues/` 文件。先写阻塞项，再写依赖它们的 ticket，并保持 PRD 索引与文件状态一致。

## 技能读取任务时

按用户提供的 feature slug、ticket 编号或文件路径读取相应 ticket，同时读取同目录的 `PRD.md` 了解目标和依赖图。

## Frontier

扫描 feature 的 `issues/` 目录；`Status` 为 `ready-for-agent` 且 `Blocked by` 中所有 ticket 均已完成的任务属于当前 frontier。
