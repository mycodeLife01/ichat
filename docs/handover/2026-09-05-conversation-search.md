# 历史会话搜索实施与验收

日期：2026-09-05。工作位置：当前分支与工作区，未提交、未部署生产。

需求依据：[规格](../specs/2026-09-05-conversation-search.md)、[执行计划](../plans/2026-09-05-conversation-search.md)、[批准的 UI 原型](../specs/designs/conversation-search.prototype.html)。原型仅约束搜索 UI；生产组件、样式 token 和原有交互优先，未移植演示工具栏或周边一次性界面。

## 本地可用状态

- 本地数据库已升级到 `20260905_0024`，226 段会话、947 条消息均已回填，包括可恢复的删除记录和归档分支。校验没有缺失版本、文本/hash 不一致或无效索引。
- 回填前后会话 `updated_at` 完全一致。首次完整回填与校验约 1.95 秒，重复补缺回填更新 0 行。
- 使用真实 Markdown 组件在 Chrome 逐条对比全部 947 条消息，浏览器文本与服务端派生文本完全一致。
- 通过运行中的真实 API，对 9 个活跃账户的可见历史进行了 906 次标题、正文或引用检索检查，失败 0 次。范围仍按账户隔离；删除会话和旧分支不会作为可见搜索结果返回。
- API、两个 LLM Worker 实例及标题 Celery Worker 已更新并启动。本地 `.env` 的 `CONVERSATION_SEARCH_ENABLED=true`；提交的 `.env.example` 保持默认关闭。
- 前端开发服务为 `http://127.0.0.1:5173`，API 为 `http://127.0.0.1:8000`。已用真实授权会话验证“搜索 → 详情 → 精确标黄”，包括跨会话和重复点击同一会话。

当前直接打开前端即可使用。之后重启已有本地环境：

```bash
docker compose up -d
pnpm --dir frontend dev --host 127.0.0.1
```

其他环境首次升级时，先保持搜索开关关闭，发布新写入进程，再回填和校验，最后开启：

```bash
docker compose build api worker
docker compose run --rm migrate
docker compose up -d --no-deps api worker celery-worker
docker compose run --rm --no-deps api python -m app.conversation_search_admin backfill --batch-size 200 --version 1
docker compose run --rm --no-deps api python -m app.conversation_search_admin verify --version 1
# Verify succeeds: set CONVERSATION_SEARCH_ENABLED=true in the deployment environment.
docker compose up -d --no-deps api
```

回填支持 `--start-id` 和显式 `--rebuild`。正常模式只补缺失/旧版本，按主键分批、锁内读取最新原文，失败不标完成；最后从头检查遗漏。`verify` 逐行验证原文投影与 hash，并检查四个索引的有效性，失败返回非零退出码。应用回滚时先关闭能力，保留派生列；不要为关闭功能删除原始数据或在本地业务库执行 downgrade。

## 实现链路

1. 新建/重命名/自动标题，以及用户消息、编辑后新消息、助手最终正文，在业务写入事务中生成搜索字段。流式草稿不进入搜索。字段按 ORM deferred 加载，普通详情响应不携带派生文本。
2. `GET /api/v1/conversations/search` 从认证身份取 owner，返回最近 10 条或每页默认 30 条匹配会话。标题与正文共同参与匹配，按 `updated_at DESC, id DESC` 排序；正文命中不会被标题命中压后。
3. 生产 SQL 按当前用户可见会话顺序检查相关 `EXISTS`，匹配后 LIMIT。`OFFSET 0` 保留相关子查询，避免优化器将高频词检查改成全局消息哈希。查询没有预截“最近 30 段”的范围。
4. 一条 SQL 为当前页选择最新命中消息，在数据库中生成有界摘要与 UTF-16 区间。正文优先于同条消息的引用。摘要左右各最多 40 个码点；不读出整段正文用于生成摘要。
5. 游标为用途隔离的 HMAC 签名载荷，绑定账户、查询指纹、页大小、时间和公开 UUID。前端只回传，不解析；文本 hash 则用于定位一致性校验。
6. 前端独立搜索组件管理防抖、IME、请求取消、分页与内存缓存。重开时从第一页重新验证已加载范围，恢复可见行锚点与位置；新输入立即禁用旧结果，退出登录清空。
7. 点击结果先读取并验证详情，再沿用会话路由和 Run 恢复。BrowserRouter 的路由提交可能晚于详情，因此只有真实路由离开目标时才清理定位意图。此问题在真实服务验收中发现，视觉 fixture 已改用 BrowserRouter 覆盖。
8. 在真实 DOM 上生成文本映射、校验版本/hash，用 CSS Custom Highlight API 绘制 Range。它可以跨强调、链接、代码 token 等节点，不修改 React 管理的 DOM。React context 只控制目标消息的展开和代码预览切换。先稳定滚动，再保持黄色 2 秒、淡出 1 秒；减少动态效果时取消平滑滚动和淡出。

搜索结果卡片中仅加粗关键词，淡黄色只用于进入会话后的定位。搜索卡片无全局遮罩；桌面中心基于完整视口并上移卡片高度的 10%，移动视口全屏。气泡复用 `Icons.Chats`，20px；滚动条与 hover 共用 token。

搜索接口使用 `Cache-Control: no-store`。Uvicorn 搜索访问日志移除 query string，Nginx 搜索路由关闭访问日志，SQLAlchemy 不输出绑定参数；数据库超时在 savepoint 中恢复，不污染连接上的超时设置，不返回伪造空结果。

## 性能与边界

环境：本机 macOS ARM64、Docker PostgreSQL 16.13。API 基准使用真实 PostgreSQL、FastAPI ASGI 路由与响应序列化，认证身份由 fixture 注入，不包括外网延迟、防抖、真实 JWT/用户查询开销。数据为确定性合成内容，平均正文约 813 字节，包含中文、英文、符号、emoji 与引用。真实 HTTP 路径另做了上述完整本地数据检索和浏览器 smoke。

每个类别分别采样；基线/多账户每类 100 次，并发 1 与 10。压力曲线每类 10 次，仅作边界观察，不能当作 SLA。

| 数据集 | 所有类别最大 p95，并发 1 | 所有类别最大 p95，并发 10 | 错误 |
| --- | ---: | ---: | ---: |
| 目标账户 1,000 会话 / 20,000 消息 | 46.27 ms | 121.05 ms | 0 |
| 同一目标账户，加其他账户 200,000 消息 | 44.77 ms | 162.04 ms | 0 |
| 单账户 10,000 会话 / 200,000 消息，全库 420,000 消息 | 1,583.91 ms | 703.52 ms | 0 |

基线和多账户样本均达到 500ms 目标。超大账户的无结果查询仍要检查更多历史，压力样本超过 500ms；当前保留 2 秒数据库超时并允许重试，不通过缩小搜索范围规避耗时。

最初汇总全部命中消息的实现，在高频单字并发 10 下 p95 约 2,862ms，100 次中 32 次超时。最终选择相关 EXISTS，同时将 ASCII 归一化改为 C collation 下的 lower、UTF-16 长度改为补充平面字符计数。所选高频查询的 EXPLAIN 实际返回 31 行，主要使用会话排序和消息 B-tree；保留 GIN 作为高选择性计划候选，不宣称所有短词由三元组索引直接加速。

单会话 1,000 条消息（其中 10 条约 60KB）：搜索响应 645 字节、约 12.95ms；完整详情约 1.63MB、30.32ms；Chrome 使用真实 MessageThread 渲染并等待两帧约 395.5ms。该详情接口仍整段加载，此样本不代表任意超长会话都能保持相同体验。

事务内构建加 flush 的 100 次样本（不含 commit）：用户消息 p95 从 0.845ms 到 0.881ms；助手 Markdown 从 0.603ms 到 1.140ms。新增文本会增加存储和写入成本，见逐索引字节数与原始报告。

原始证据：[基线](assets/conversation-search/baseline.json)、[多账户](assets/conversation-search/multi-account.json)、[压力](assets/conversation-search/stress.json)、[长会话](assets/conversation-search/long-conversation.json)、[写入与存储](assets/conversation-search/write-cost.json)。同目录的 `*.explain.json` 保存查询计划与 buffer 指标。首次请求单独记录，未通过重启数据库声称测得冷缓存 SLA。

可重复基准入口：

```bash
# DATABASE_URL must point to a dedicated database whose name ends in _search_perf.
uv run alembic upgrade head
uv run python -m tests.performance.conversation_search seed --account baseline --conversations 1000
uv run python -m tests.performance.conversation_search bench --account baseline --repeat 100 --concurrency 1 10 --output /tmp/search-baseline.json
uv run python -m tests.performance.conversation_search seed --account other --conversations 10000
uv run python -m tests.performance.conversation_search bench --account baseline --repeat 100 --concurrency 1 10 --output /tmp/search-multi-account.json
```

## 质量门

- 后端全量 pytest：781 项通过；之后摘要边界与索引恢复调整的搜索专项回归覆盖 23 项。
- 前端最终全量 Vitest：725 项通过。
- Ruff、mypy、前端 typecheck、ESLint、生产构建通过。构建保留 chunk 大小提示，以及 CSS 优化器不识别标准 `::highlight` 伪元素的提示；生成的 CSS 保留该规则，Chrome 实测绘制正常。
- Nginx 使用临时自签证书在独立容器执行 `nginx -t`，配置校验通过。
- Chrome 桌面与移动视口共 10 项通过：搜索位置、无暗色遮罩、空态居中、rail、分页、失效提示、精确跨节点标黄、长引用展开、3 秒时间线及流式追加不拉回底部；并回归已有 thread-bottom 用例。
- 隔离测试库已完成 `0024 → 0022 → 0024` 往返；模拟无效索引后重跑 `0024` 会先清理再并发重建，verify 成功。未在本地业务数据上 downgrade。
- 没有调用真实模型生成新内容作为验收，也没有修改用户原始会话标题/正文、删除数据或发送外部邮件。

浏览器验收覆盖 Chrome 桌面和移动尺寸，并不等同于实体手机软键盘或所有浏览器版本兼容性验收。精确绘制依赖 CSS Custom Highlight API。后续修改投影语义必须同步共享 fixture、版本/hash 和存量回填，不能只修改一端。
