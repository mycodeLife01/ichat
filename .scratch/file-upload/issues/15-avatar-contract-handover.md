Type: refactor
Status: ready-for-agent
Blocked by: 12, 13, 14

# 收缩旧头像实现并完成文件领域交接

## 目标

在统一模型和生产路径已验证后完成 expand-contract 的 contract 阶段：删除旧头像领域状态、
旧引用和双读逻辑，使 files 成为头像与消息附件唯一文件领域，并交付权威中文文档。

## 前置检查

- 新头像已只写 `avatar_file_id`，现有 current avatar 映射校验无遗漏。
- 旧头像 queued/processing/deletion 积压为零，且已跨过约定的历史保留窗口。
- 生产 feature flag、file/media workers、删除补偿和回滚路径已经过 ticket 14 验证。

## 交付范围

1. 删除 avatar 旧 object-key 读回退、新写兼容代码和不再使用的模型字段；Alembic migration
   删除旧 avatar uploads/deletions 表及约束，必要时采用分阶段 migration 控制锁和回滚风险。
2. 删除已无调用者的独立头像 lifecycle/storage/maintenance 实现；头像 HTTP 路由可保留在
   `api/v1/avatars`，但业务只调用 files 高层 interface。不得为了目录整洁改写冻结的 HTTP contract。
3. 搜索并移除旧 queue/task/config/env、测试 fake 和文档引用；确认 media-worker 仍只负责
   avatar purpose 的公开派生与 purge，而非重新形成第二套领域状态机。
4. 更新 `docs/architecture/module-boundaries.md`、`docs/README.md`、部署文档、相关架构总览和
   `CONTEXT.md`；新增中文 handover，记录数据模型、状态机、权限拓扑、运行手册、已知限制、
   smoke 命令和后续图片理解边界。
5. 历史 PRD 保持原样作为当时决策记录；在新文档中明确 ADR 0002 已取代“头像不建设通用文件
   领域”的旧约束。

## 验收

- repo 搜索确认运行代码不再读取旧 avatar object key 或旧状态表，新/旧用户头像均正常。
- 在迁移前快照数据上演练 upgrade，验证映射数量、旧积压保护和删表条件；不满足前置检查时
  migration/运维步骤必须安全停止。
- 头像上传/替换/注销、附件全格式、编辑/重生成、分享、恢复/回收和删除补偿回归通过。
- 模块边界测试证明头像和消息附件只通过统一 files interface，worker 权限隔离仍成立。
- 全套后端、前端、migration、compose 检查通过；handover 足以由新 agent 独立维护该功能。
