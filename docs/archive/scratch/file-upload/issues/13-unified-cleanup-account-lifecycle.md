Type: feat
Status: completed
Blocked by: 11, 12

# 跨用途删除补偿与账户生命周期

## 目标

让统一 files 模块真正拥有私有附件和公开头像的外部副作用收尾，并把账户停用/注销时的
差异化保留规则固化为可验证行为。

## 交付范围

1. `file_object_deletions` 作为所有正式对象删除的唯一持久事实：记录 storage location、
   object key、可空 purge URL、分步完成时间、attempt、available_at、错误摘要和完成时间。
2. 私有对象以 R2 delete 完成为终态；公开头像要求 R2 delete 与 CDN purge 两步都完成。
   每步支持 404 幂等、部分成功续跑、暂时故障退避和关系已删除后的独立完成。
3. 账户注销继续采用软停用：禁止创建新上传与签发新下载 URL，取消 pending/queued/
   processing 上传；私有已绑定附件和业务记录保留，不启动 30 天账户物理清除。
4. 公开头像在账户注销事务中解除引用并创建删除补偿，随后 delete+purge；运维恢复账户时
   不自动恢复旧头像。附件未绑定/临时对象仍按正常回收规则清理。
5. 明确成功提交与取消/注销竞态：取消先锁定则不得创建 FileAsset；成功先提交则按文件当前
   绑定和账户规则回收。关闭浏览器不产生虚假取消。
6. 增加 bounded sweep、最老补偿和分步骤失败指标；日志仅含内部 ID、storage role、状态和
   稳定错误码，不含 object URL、文件名或未经清洗的外部响应。

## 验收

- 私有单步、头像双步、404、delete 成功/purge 失败、任务重复和 DB 关系已清除场景都能最终完成。
- 账户注销后不能上传或获取新签名 URL，在途任务不生成新业务文件，私有已绑定附件继续保留；
  公开头像最终不可访问且完成 CDN purge。
- 注销与 worker 最终提交的所有交错顺序有集成测试，无泄漏、重复配额释放或悬空业务引用。
- 恢复停用账户不恢复旧头像；符合权限的私有历史数据恢复可见性但不会绕过已有会话删除状态。
- media/file worker 凭证边界和 queue claim 按 purpose/storage location 过滤有自动化断言。
- 后端、任务和生命周期测试全绿。
