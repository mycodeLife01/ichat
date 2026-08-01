Type: chore
Status: ready-for-agent
Blocked by: 05, 06, 07, 09, 10, 13

# 文件上传生产部署、灰度与可观测性

## 目标

把已完成的文件能力安全带入开发和生产环境：完成独立执行拓扑、最小权限、动态能力、灰度
开关、真实集成 smoke、容量指标和可回滚部署说明。

## 交付范围

1. 配置独立私有 staging/canonical buckets、CORS、最小权限 R2 凭证、files queue、
   file-worker、ClamAV/clamd 和单实例 beat sweep；开发与生产资源、凭证完全隔离。
2. file-worker 只持有附件 staging/canonical 权限，不持有头像公开 bucket、CDN purge、邮件
   或 LLM 凭证；media-worker 反向不持有私有附件权限。普通 CI 继续只用 fake secrets。
3. 增加独立文件上传 feature flag。关闭只阻止新建上传，仍允许读取已有附件、queued/
   processing 排空、删除补偿和维护回收；前端隐藏入口但继续展示历史附件。
4. capabilities 动态返回开关、完整 allowlist、分类大小、五附件、50 MiB、1 GiB quota、
   128k target turn、256k context budget 和 `image_model_input=false`；前端限制来自 capabilities，
   后端仍独立执行全部策略。
5. 增加 queue wait、If-Match GET、ClamAV、解析、R2 write、final commit、cleanup、delete/purge
   的分段耗时/失败率，以及状态数量、lease 过期、最老补偿、quota drift、签名年龄和资源终止指标。
6. 确保结构化日志不包含文件名、正文、签名 URL、属性、原始 parser 异常或临时路径。
7. 编写中文部署、R2/ClamAV smoke、灰度与回滚说明；验证上线顺序为 migration/read compatibility
   → workers → API create → frontend，回滚先关新增再排空事实行。

## 验收

- 开发 R2 smoke 覆盖 presigned PUT CORS、ETag 暴露、If-Match、bucket 权限、五分钟 GET、
  Content-Disposition、对象清理和跨 Origin 拒绝。
- ClamAV 集成使用官方无害测试签名验证命中，并演练 scanner unavailable/signature stale 的
  fail-closed 与重试；不保存真实恶意样本。
- compose 开发/生产配置、queue 隔离、最小权限和 beat 单实例通过自动/手工验证。
- feature flag 开关演练证明旧附件仍可读、任务仍排空、新上传被拒绝且前端入口隐藏。
- confirm→ready 达成图片/文本 P95≤10s、PDF/Office P95≤30s、正常文件 P99≤120s 的受控验收，
  并记录测试环境和样本；浏览器 PUT 时间不计入。
- `pytest`、`ruff`、`mypy`、vitest、lint、typecheck、build 与 compose config 全绿。
