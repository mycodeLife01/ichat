Type: refactor
Status: completed
Blocked by: None

# 统一 Files 领域的 additive 基础

## 目标

以不改变现有头像行为为前提，建立 `files` 深模块的持久化模型、高层 interface 和
adapter seam，为消息附件与头像迁移提供共同地基。这是 expand-contract 的 expand
阶段，允许它作为后续纵向切片的基础设施例外。

## 交付范围

1. 新建统一 `app/services/files/` 领域包，定义不可由客户端任意指定的固定用途
   `avatar` 与 `message_attachment`，以及创建、确认、查询、取消、处理、绑定、读取许可、
   回收和删除所需的高层 interface。路由和调用者不得接触 bucket、object key、lease
   或 parser 细节。
2. 通过 additive Alembic migration 建立 `file_uploads`、`files`、`file_objects`、
   `message_attachments`、每用户配额状态和 `file_object_deletions`；为用户增加 nullable
   `avatar_file_id`，保留现有头像字段与表。
3. 落实 PRD 中三层概念、显式 Message/User 关系、随机 public ID、用途不可变、上传状态机、
   output manifest、lease、错误码、生命周期时间和删除补偿字段。SHA-256 只作完整性记录，
   不建立物理去重、共享 blob 或引用计数。
4. 定义 storage、scanner、parser、publisher、download signer 的窄协议和 fake adapter；
   storage location/role 是内部受控词汇，不允许任意 bucket 或 key 穿透外部 interface。
5. 把跨用途状态转换、终态不可重入、配额增减和删除记录建立定义成可测试的领域规则；
   本票不接管现有头像运行路径，也不开放消息附件 API。

## 验收

- 全新数据库和已有数据库均可 `alembic upgrade head`；迁移不访问 R2、不回填文件字节，
  downgrade 能力或不可逆保护有明确说明。
- 领域 interface 测试覆盖用途隔离、允许的状态转移、终态不可重入、显式关联约束、
  SHA-256 不触发复用以及配额行并发锁定的基本行为。
- fake adapters 可在不连接 R2、Redis、ClamAV 的测试中驱动完整状态变化。
- 现有头像 API、头像 worker 和前端测试行为不变；`pytest`、`ruff check .`、`mypy app`
  全绿。

## 非目标

- 不开放附件上传入口，不处理真实文件，不绑定消息，也不切换头像读写路径。
