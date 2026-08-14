# 统一文件资产与头像上传领域

iChat 将头像和消息附件统一归入一个 `files` 领域模块：上传会话、文件资产、物理对象、回收和删除补偿共享同一套生命周期，头像与消息附件作为用途固定且不可互换的内部策略。现有头像 HTTP 路径保持兼容，但终态删除独立 `app/services/avatars`，以 `users.avatar_file_id` 和显式消息附件关系引用文件资产；头像公开发布与 CDN purge、附件私有存储与文档提取仍封装在各自用途实现内。该决定以一次持久化和模块迁移换取上传状态机的单一事实来源，同时避免通过散落的用途分支把头像隐私语义扩散到普通附件；实施完成时应同步替换 `docs/architecture/module-boundaries.md` 中“头像不抽象为通用 files/assets”的旧约束。

## 实施状态（2026-08-01）

此前头像 PRD 与旧 `module-boundaries.md` 中“头像不建设通用 files/assets 模块”的历史约束，
已由本 ADR 和统一文件上传设计取代；模块边界现以 `app/services/files` 为唯一文件领域拥有者，
详细实现与部署边界见[统一文件上传交接](../handover/2026-08-01-unified-file-upload.md)。

这不等同于已经完成 legacy avatar 的 contract 收缩。旧 object-key、状态表、任务与双读回退
仍须在生产映射验证、历史积压清零、保留窗口和灰度/回滚演练完成前保留；删除它们必须由
file-upload ticket 15 的单独变更完成，不能由本 ADR 或本次 additive migration 推断授权。
