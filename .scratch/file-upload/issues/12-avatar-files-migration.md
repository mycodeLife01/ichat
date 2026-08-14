Type: refactor
Status: completed
Blocked by: 01

# 头像迁移到统一 Files 领域

## 目标

在保持现有头像 HTTP 与 UI 契约的前提下，把新头像写入、当前头像引用和现有公开对象迁移到
统一 files 深模块；旧表和读回退暂时保留以便安全排空。

## 交付范围

1. 头像路由继续固定 purpose=avatar，复用统一上传状态骨架和 files 高层 interface，但仍由
   media queue/media-worker 执行，使用公开头像 bucket 与独立 Cloudflare purge 凭证。
2. 新上传维持现有裁剪/缩放规则，只生成公开 512×512 WebP `avatar_512` FileObject；不保留
   原件或中间图，头像不计入消息附件 1 GiB 配额。
3. 头像替换保持原子切换：新成品和 `users.avatar_file_id` 提交前旧头像继续可见；成功后旧
   FileAsset 进入公开对象删除补偿，要求 R2 delete 与 CDN purge 均完成。
4. 为每个用户当前有效的现有头像创建 avatar FileAsset/FileObject 并设置 avatar_file_id。
   数据迁移不访问 R2，不转换历史上传；未知大小/hash 使用明确 `legacy import` 表达。
5. 读取短期优先 avatar_file_id，回退旧 avatar object key；新写只写统一模型。迁移提供幂等
   批处理、映射数量校验、缺失/冲突报告和安全重跑。
6. 旧 avatar uploads/deletions 继续由原执行路径排空。本票不得删除旧表、旧字段、旧任务或
   fallback；收缩留给 ticket 15。

## 验收

- 现有头像创建、替换、读取、账户注销和前端展示的 HTTP contract 保持兼容。
- 新头像只产生 avatar_512 对象，不保留原件、不影响附件 quota，并正确执行旧头像 delete+purge。
- 迁移在含现有头像、无头像、缺失 key、重复执行的数据库上可复现，过程中没有任何 R2 调用。
- avatar_file_id 优先读取和 legacy fallback 均有测试；新写不再增加旧模型记录。
- media-worker 不获得私有附件 bucket 权限，file-worker 不获得公开头像/purge 权限。
- 后端、前端、migration 和 worker 测试全绿。
