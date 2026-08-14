Type: feat
Status: completed
Blocked by: 01

# TXT 上传到 Ready 的安全纵向切片

## 目标

仅以 TXT 为首个格式，打通“选择文件 → R2 直传 → confirm → 安全处理 → ready 草稿卡片”
的完整用户路径。该切片止于可绑定 FileAsset，不向模型发送内容。

## 交付范围

1. 增加附件上传创建、confirm、合并状态查询、显式取消、下载许可 API；purpose 由附件
   路由固定。仅 active 且邮箱已验证的用户可创建。
2. 创建前执行 TXT 扩展名/2 MiB 限制、每用户每小时 100 次、每 IP 每小时 500 次、
   每用户五个在途上传以及 1 GiB 原件配额预留。限流使用 Redis 且故障时 fail-closed；
   配额与上传状态在同一 PG 事务提交。
3. 使用私有 staging bucket 的单次预签名 PUT，固定随机 key、Content-Type 和声明大小
   元数据。confirm 通过 HEAD 校验对象、大小、元数据和 ETag；重复 confirm 幂等且不可
   更换 ETag。
4. 增加独立 `files` Celery queue 与 file-worker 处理入口。PG 状态行为事实源，任务只是
   唤醒；claim/lease 幂等，worker 以 If-Match 读取确认对象，计算长度和 SHA-256。
5. 所有原件先经 clamd。TXT 仅接受 UTF-8/UTF-8 BOM，拒绝 NUL 与非法编码，派生文本
   去 BOM 并统一 LF；原件不改变。扫描器不可用或签名过期按暂时故障处理，恶意命中和
   内容策略失败进入 rejected。
6. 写 canonical 前持久化 output manifest；成功原子创建 FileAsset/FileObject、把
   reserved 转为 used，并删除 staging。失败、取消或崩溃留下的对象由幂等维护路径清理。
7. 落实 pending 30 分钟、最大三次处理、30 秒/5 分钟退避、120 秒 parser 上限、
   180 秒 attempt 上限和五分钟 lease。显式取消与成功提交锁同一上传行。
8. 前端 composer 支持选择、上传、合并轮询、取消、失败重试提示和 ready 草稿卡片；
   轮询从约一秒退避至五秒，页面不可见时暂停，刷新可从本地草稿恢复 ID 和状态。

## 验收

- 用户能上传合法 TXT 并在刷新后看到 ready 卡片和原件下载；本票阶段发送按钮仍不把
  附件提交给消息。
- API/worker 集成测试覆盖所有权、过期、ETag/大小/元数据不匹配、confirm 幂等、
  If-Match 覆盖竞态、publish 丢失后的 sweep、lease 抢占、三次重试和所有取消竞态。
- 配额测试覆盖并发预留、成功转移、失败/取消/过期释放；限流与 Redis fail-closed 可复现。
- scanner/text parser 使用 fake 作为普通 CI seam，并有 clamd 无害测试签名的独立集成
  测试入口；日志断言不包含文件名、内容、签名 URL 或 parser 原始异常。
- 后端检查和前端 `vitest`、lint、typecheck、build 全绿。
