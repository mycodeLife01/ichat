# 文件上传性能优化交接

日期：2026-08-09  
相关决策：[ADR 0010](../adr/0010-use-adaptive-multipart-and-server-side-promotion.md)

## 基线与结论

在本地完整栈、真实 R2、ClamAV 与 file-worker 上，以 TXT、PNG、PDF、DOCX、PPTX、XLSX 的小文件和约 2 MiB 文件各重复 3 次，共 36 个成功样本。约 2 MiB 样本的端到端 P50 如下：

| 类型 | P50 |
|---|---:|
| TXT | 57.43 s |
| PNG | 40.24 s |
| PDF | 38.26 s |
| DOCX | 21.77 s |
| PPTX | 23.57 s |
| XLSX | 21.02 s |

阶段数据表明 queue wait 约 0.26 s、staging GET 约 0.6–1.8 s、ClamAV 多数约 0.01 s、解析约 1.3–1.7 s、PG commit 为毫秒级，而 worker 向 canonical 的 R2 PUT 达 17–36 s。重启 file-worker 后，同一约 2 MiB DOCX 的 R2 写入下降到约 1.1–1.6 s，端到端下降到约 4–7 s；同一区域内 R2 条件 Copy 约 0.89–1.09 s。7.7 MiB PNG 的单次 PUT 还出现过 confirm 前连接断开。主要瓶颈因此是重复上传原件、长寿命 SDK HTTP 连接池退化，以及大文件单次 PUT 的整文件重试风险，而不是 PG、ClamAV 或解析器。

## 已实现

- 新客户端在 5 MiB 以下使用单次 PUT；5 MiB 及以上使用 5 MiB 分片、最多三路并发、每片最多三次尝试。旧客户端未声明 `multipart_supported` 时仍返回原单次 PUT 协议。
- API 创建并完成 R2 multipart；`file_uploads` 持久化 `upload_method`、`multipart_upload_id` 与 `multipart_part_size_bytes`。Complete 丢响应时以 HEAD 保证重试幂等；取消、过期、事务回滚和 staging 清理都会 Abort 未完成上传。
- worker 保留 ETag 条件 GET、ClamAV 和受限解析；成功后对原件执行带 `CopySourceIfMatch` 的 R2 服务端 Copy，并校验 canonical 大小和 SHA-256 元数据，不再从 worker 重新上传原件。
- 新文档的解析文本只写 `files.document_text`，manifest 与 `file_objects` 不再新增 `document_extract`。旧 manifest 仍走兼容写入路径，旧对象不迁移、不回填。
- 每个文件任务创建新的 R2 SDK client，并启用 TCP keepalive、显式连接/读取超时和标准重试；file-worker 以 `--max-tasks-per-child=50` 作为进程级兜底。
- Celery worker/beat 初始化 JSON Loguru sink，阶段指标可保留 bound fields。新增 `upload_sign`、`confirm_head`、`multipart_complete`、`r2_promote`、`preview_write` 与 `legacy_extract_write` 阶段，原 queue/GET/ClamAV/parse/commit/cleanup 指标保留。

## 部署与权限

上传凭证需要 staging bucket 的 CreateMultipartUpload、UploadPart、CompleteMultipartUpload、AbortMultipartUpload、PutObject 与 HeadObject；worker 凭证需要 staging GetObject/DeleteObject/AbortMultipartUpload，以及从 staging 到 canonical 的条件 Copy、canonical Head/Delete 和 preview 写删权限。浏览器 CORS 继续允许 PUT 并暴露 ETag。

新增环境变量：

- `FILES_MULTIPART_THRESHOLD_BYTES=5242880`
- `FILES_MULTIPART_PART_SIZE_BYTES=5242880`
- `FILES_R2_CONNECT_TIMEOUT_SECONDS=5`
- `FILES_R2_READ_TIMEOUT_SECONDS=30`
- `FILES_R2_MAX_ATTEMPTS=3`
- `FILES_WORKER_MAX_TASKS_PER_CHILD=50`
- `FILES_R2_PARALLEL_DOWNLOAD_THRESHOLD_BYTES=5242880`
- `FILES_R2_PARALLEL_DOWNLOAD_MAX_CONCURRENCY=3`

## 保守型可用态加速

在 VLESS 节点下复测后，浏览器直传已不再是主要瓶颈：1.6–2.5 MiB 单次 PUT 约 0.88–1.79 s，6.27 MiB multipart PUT 约 1.70–3.31 s。worker 从入队到 ready 的小图约 5.1–5.5 s，6.27 MiB 图片约 8.1–18.9 s；其中大文件 staging GET 波动约 2.1–11.8 s，前端旧退避轮询还会额外延迟感知 ready。

当前采用保守方案，不改变状态和发送语义：文件必须实际进入 `ready` 后，前端才结束上传态并允许发送。只缩短安全路径上的等待：

- 前端在进入服务端处理后的前 10 秒每 250 ms 查询一次状态，之后从 1 秒开始退避，最高 5 秒；页面卸载和状态终结仍会停止轮询。
- worker 对 5 MiB 及以上 staging 对象使用最多三路带同一 `If-Match` 的 Range GET，并按字节顺序合并；小文件继续单请求下载，避免增加请求成本。
- 原文件服务端晋升和预览写入在解析、扫描均成功后并行执行；任一失败仍进入原有重试/失败处理，不会提前提交 `ready`。

这组改动主要降低大文件 GET 长尾、图片双写串行等待和前端发现 ready 的延迟；不会跳过病毒扫描、解析、R2 持久化或 PG 最终提交。

重建 API 与 file-worker 后，以 5,939,558 B 有效 PNG 对真实 R2 连续执行三次 smoke，全部成功。multipart PUT 为 1.280–1.311 s，confirm 为 0.849–0.927 s，confirm 后到 250 ms 轮询观测 `succeeded` 为 4.774–5.376 s，总计 7.542–8.350 s。worker 阶段中 queue wait 为 0.850–1.110 s、三路 Range GET 为 1.532–2.088 s、解析为 1.556–1.600 s；preview write 为 0.343–0.422 s，原件晋升为 1.388–1.726 s，而并行后的总 `r2_write` 为 1.388–1.727 s，验证了两个写入分支按较慢者收敛而非串行相加。

## 实现后真实 smoke

重建 API、file-worker 与 beat 后，对真实 R2/ClamAV 上传 50,000 B TXT 和 6,483,314 B 有效 PNG，均成功且 staging 已清理。TXT 选择 single，端到端 4.743 s：浏览器 PUT 0.786 s、confirm 0.353 s、queue 0.353 s、GET 0.641 s、ClamAV 0.073 s、parse 1.218 s、R2 promote 1.433 s、final commit 0.010 s、cleanup 0.285 s；PG 中 `document_text` 长度为 50,000，物理 role 只有 `original`。

PNG 选择两片 multipart；API Create 0.344 s、Complete/confirm 0.859 s，worker 的 queue 0.857 s、GET 5.362 s、ClamAV 0.430 s、parse 2.090 s、R2 promote 1.312 s、preview write 13.531 s、final commit 0.011 s、cleanup 0.528 s。smoke 脚本顺序上传两片，浏览器传输共 55.318 s，不能代表前端三路并发收益；它验证的是 R2 multipart/Complete、条件晋升与清理语义。原件晋升已经从基线 17–36 s 降至约 1.3–1.4 s；该次 preview 写入仍有 13.5 s 网络波动，应在灰度期按新增的独立 phase 指标继续观察，不能与原件晋升回归混为一个 R2 write 指标。

上线顺序为 additive migration、API、前端、file-worker/beat。回滚时先关闭新前端 multipart 协议或 `FILE_UPLOAD_ENABLED`，但保留新版 API、worker、beat 和凭证直到 pending multipart、queued/processing、staging 与删除补偿归零。

## 验证

```bash
alembic upgrade head
ruff check app tests
mypy app
pytest
pnpm --dir frontend test -- --run
pnpm --dir frontend exec tsc --noEmit
docker compose config --quiet
docker compose -f compose.prod.yml config --quiet
```

真实 R2 验收至少覆盖 4 MiB、5 MiB、6 MiB、25 MiB 的 TXT/PDF/Office/PNG：记录浏览器分片 PUT、API Complete、queue wait、If-Match GET、ClamAV、parse、R2 promote、preview write、final commit 与 cleanup 的 P50/P95/P99；同时验证中断单片只重传该片、取消/过期无 multipart 残留、canonical 原件 SHA-256 一致、文档没有新 `document_extract` 对象，并连续处理超过 50 个文件观察子进程轮换。
