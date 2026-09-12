# 设计确认归档

工作台“导出待确认记录”生成草稿。只有用户明确确认后，才保存为 `<日期>-<proposal-id>.json` 并填写确认信息；当前没有自动生成的批准记录。

记录必须包含：proposalId、需求文档、sourceCommit、designCommit（未提交时先记录内容指纹，提交后补齐）、sceneIds、viewport、截图证据、确认范围和例外、approvedBy、approvedAt。

`designStatus` 使用 draft / approved / superseded；`implementationStatus` 使用 not-started / in-progress / verified。实施完成后填写 implementationCommit 和对照证据。设计确认与产品上线是两项不同事实。

初版 current 来自已有产品，是等待验收的迁移基线。`example-composer` 仅验证隔离机制，不代表产品需求、用户批准或待实施功能。
