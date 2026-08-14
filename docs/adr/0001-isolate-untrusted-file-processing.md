# 隔离不可信文件处理

文件上传将引入 PDF、OOXML 等高攻击面解析器以及显著的 CPU、内存和临时磁盘开销。文件解析使用独立 `file-worker` 和独立 Celery queue，并仅授予私有文件 bucket 所需的最小权限；它不与头像 `media-worker` 共用进程，也不持有头像公开 bucket、Cloudflare purge、邮件或 LLM 凭证。该隔离增加一个部署进程和一组运维配置，但能限制解析器漏洞与资源耗尽的影响范围，避免不可信文档处理阻塞头像任务或泄露无关凭证。
