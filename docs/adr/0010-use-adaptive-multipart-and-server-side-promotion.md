# 文件上传采用自适应 multipart 与服务端晋升

iChat 对声明大小小于 5 MiB 的附件保留一次预签名 PUT，对声明大小不小于 5 MiB 且客户端显式声明支持的附件返回 5 MiB 分片、最多三路并发的 multipart 计划；旧客户端继续获得单次 PUT。multipart 只是传输机制，`FileUpload` 与 PostgreSQL 仍拥有上传方式、R2 upload ID、分片大小、状态、配额和清理事实，API 负责 Complete，取消、过期或事务失败负责 Abort。安全扫描与解析成功后，file-worker 使用 ETag 条件把 staging 原件在 R2 内服务端复制到 canonical，不再把已下载原件重新 PUT；新文档的派生文本只保存在 `files.document_text`，不再建立重复的 `document_extract` 对象，旧 manifest 和旧对象仍可读取、重试和清理但不回填。该选择显著减少大文件传输失败的重传范围、worker 出站流量和重复存储，代价是上传协议、R2 权限与过期清理更复杂，并要求以数据库约束、幂等 Complete/Abort、兼容旧客户端和阶段耗时指标保护边界。
