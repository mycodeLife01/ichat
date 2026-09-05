# 历史对话搜索实施计划

日期：2026-09-05

状态：待实施。本文是执行方案，未运行迁移、建立索引或完成性能验证。

需求依据：[历史对话搜索 spec](../specs/2026-09-05-conversation-search.md)。
UI 依据：[已确认的搜索样稿](../specs/designs/conversation-search.prototype.html)。仅参考搜索相关 UI；设计工具栏、场景面板、模拟宿主侧栏、消息区及输入框等一次性界面不作为实现参考。UI 冲突时，以实施时的前端设计规范、现有 token 和共享组件为准。

## 1. 交付目标与实现边界

采用 **PostgreSQL 服务端搜索 → 按会话分页返回摘要 → 点击后按需读取一个会话 → 定位命中文字**。

- 前端不下载用户全部历史正文；API 不把全部消息加载到 Python 后循环过滤。
- 每页默认 30 个会话，最多 50 个；不查询命中总数，不为生成摘要逐条调用详情接口。
- 标题、可见消息正文及已发送引用快照参与匹配；按会话更新时间倒序，一段会话一条结果。
- 不引入 LLM、向量检索、独立搜索服务或新的常驻后台 worker；`app/search/` 继续只负责外部联网搜索。
- 正式消息及标题仍是事实源。用于搜索的文本是可重建的派生数据，不进入 transcript 或公开分享。
- 首版复用现有单会话详情接口。该接口仍读取目标会话的全部可见消息，不把“没有拉全部历史”误写成“超长会话详情已经分页”。

成功条件：spec S01–S20 有对应验证；静态数据连续翻页不重复、不遗漏；搜索结果与落点一致；搜索不改变会话更新时间、草稿或 Run；性能达到第 7 节目标。

## 2. 已核对的实现入口

| 现有文件 | 现状与接入方式 |
| --- | --- |
| `app/models/conversation.py` | 同时定义 Conversation、Message；已有用户/删除/更新时间索引及会话/归档/position 索引，没有本需求的文本搜索索引 |
| `app/services/conversations/service.py` | `list_conversations` 只读会话列表；`get_conversation_detail` 读取一个会话全部可见消息；用户消息、编辑生成的新消息、助手物化均在此写入 |
| `app/tasks/llm_tasks.py` | 自动标题直接执行 `UPDATE Conversation`；新增派生标题时必须覆盖此路径，不能只改手动重命名 |
| `app/api/v1/conversations.py` | 新静态 `/search` 路由放在 `/{conversation_id}` 之前；复用认证、session 和 success envelope |
| `frontend/src/api/conversations.ts` | 增加独立 `search` 方法；保留现有 list/detail 契约 |
| `frontend/src/conversations/Sidebar.tsx` | 展开态、rail、移动抽屉增加同一个搜索动作，位于新建对话之后、最近对话之前 |
| `frontend/src/app/AppShell.tsx` | 装配弹窗、导航意图、详情就绪及滚动协调，不承载 SQL 或新的业务规则 |
| `frontend/src/conversations/useConversationLoader.ts` | 复用会话加载；同一会话的搜索定位也必须触发，不能只依赖 selectedId 变化 |
| `frontend/src/messages/Markdown.tsx` | 沿用现有 Markdown 管线与私有 renderer，增加定位所需的有限扩展，不复制一份搜索专用 Markdown renderer |
| `frontend/src/messages/replyQuoteSourceNavigation.ts` | 已有引用来源的滚动/标黄；它按语义节点标整段，搜索要求标精确文字，不能直接复用其目标选择语义 |

实施前再次阅读：

- [前端架构](../architecture/frontend.md)、[后端总览](../architecture/overview.md)、[模块边界](../architecture/module-boundaries.md)。
- [rail 与聊天操作](../handover/frontend/2026-08-14-sidebar-rail-and-chat-actions.md)、[移动分享交接](../handover/frontend/2026-09-05-mobile-quick-share-copy-failure.md)。
- [回复引用交接](../handover/2026-08-31-reply-quote.md)、[引用来源导航计划](2026-09-05-reply-quote-source-navigation.md)、[引用 UI 对齐](2026-09-04-reply-quote-ui-parity.md)。
- [流式几何约束](../handover/2026-08-31-thinking-header-geometry-shift.md)、[部署指南](../deployment.md)。

## 3. 接口与分页契约

### 3.1 请求

```text
GET /api/v1/conversations/search?q=数据库&limit=30&cursor=...
```

- `q` 缺省或空串为最近会话模式；输入上限为 200 个 Unicode 码点，匹配前折叠空白。空串模式只返回最近 10 条，不查询消息正文，无下一页。
- `limit` 默认 30，范围 1–50；查询模式每页同一 limit，游标绑定该值。
- owner 只取登录身份，不接收客户端 user_id。
- `%`、`_`、反斜杠均按字面匹配；参数化 SQL，并明确 `LIKE ... ESCAPE`，不插值 SQL。
- 响应使用 `Cache-Control: no-store`。检查 API、Nginx 及代理访问日志，搜索路径只记录无 query string 的路径，禁止记录 q、片段、游标全文或 SQL bound parameters。
- 空查询/非法参数/请求失败分开处理；非法查询和游标返回 400/422，数据库超时返回明确可重试错误，绝不返回伪造的空结果。复用当前 AppError envelope，由前端映射本需求中文文案。

### 3.2 响应

以下为 schema 形状，不是实际用户数据。ID 字段均为 public UUID。

```typescript
type ConversationSearchResponse = {
  items: Array<{
    conversation_id: string;
    title: string | null;
    updated_at: string;
    title_match: { start: number; end: number } | null;
    snippet: {
      text: string;
      match: { start: number; end: number };
      truncated_before: boolean;
      truncated_after: boolean;
    } | null;
    target: {
      message_id: string;
      field: "body" | "reply_quote";
      projection_version: 1;
      projection_hash: string;
      start: number;
      end: number;
    } | null;
  }>;
  next_cursor: string | null;
};
// HTTP response: { data: ConversationSearchResponse }
```

- 所有区间使用 UTF-16 半开区间；`title_match` 相对原始 title，`snippet.match` 相对 snippet.text，target 相对第 4 节定义的完整字段文本表示。不能混用偏移坐标。
- 标题单独命中：snippet/target 为 null。最近模式：三种匹配信息均为 null。
- 消息命中时返回最新命中消息 position 所对应的 target；正文优先于同条消息的引用；选定字段内取第一次匹配。
- 摘要包含完整命中短语及前后各最多 40 个 Unicode 码点，不截断 surrogate pair。200 码点查询也必须完整保留；省略号由 truncated 标志展示，不计入匹配区间。
- 不返回完整正文、内部 ID、数据库 position、Run、推理、附件或来源元数据；哈希仅用于一致性校验，不授予访问权限。

### 3.3 游标

使用 `(updated_at DESC, internal id DESC)` 的 keyset 顺序，取 `limit + 1` 个**去重后的会话**判断下一页。禁止对消息先 LIMIT 再去重，也禁止先取最近 30 段会话再搜索。

游标使用带签名的版本化载荷：查询指纹、登录账户绑定、limit、最后一条的更新时间与 conversation public ID。载荷不含正文、原始查询和内部 ID；使用当前服务端密钥体系生成带用途前缀的 HMAC，不把密钥传给前端。时间保留数据库精度，不经 JS 毫秒精度重写。

下一页先验签和校验账户/查询/limit，再把最后一个 public ID 解析为内部排序 ID；解析时允许同一账户的软删除会话作为游标边界，但它仍不得进入结果。若已物理删除、版本不兼容或验签失败，返回游标无效，前端保留输入并重新查询第一页。

数据不变时完整遍历；并发新消息、重命名、归档、删除允许查询视图变化，不承诺跨请求快照。前端按会话 ID 去重；新查询和重新验证从第一页开始。

## 4. 搜索文本与位置映射

### 4.1 派生字段

第一版在原业务表增加可空字段，避免再维护一张含重复 owner/删除状态的搜索表：

| 表 | 新字段 | 用途 |
| --- | --- | --- |
| conversations | `search_title TEXT`、`search_text_version SMALLINT` | 标题的空白折叠表示及版本 |
| messages | `search_text TEXT`、`search_quote_text TEXT`、`search_text_version SMALLINT`、`search_text_hash VARCHAR(64)`、`search_quote_hash VARCHAR(64)` | 正文和已发送引用分别投影并保存哈希，不能拼成一段 |

版本未完成时为 NULL；已处理但无文字时为 `''`，不能把空正文误认为尚未回填。正式查询在完整回填与校验完成后开启，不把缺失派生字段当作没有命中。

`search_text.py` 提供以下纯函数，不持有数据库或调用外部服务。原文不可变，派生字段可以按版本重建。

| 函数 | 职责 |
| --- | --- |
| `build_title_search_text` | 根据标题生成搜索文本 |
| `build_user_search_text` | 根据用户消息的可见文字生成搜索文本；已发送引用快照按同一文字规则单独处理 |
| `build_assistant_search_text` | 根据助手消息的 Markdown 可见内容生成搜索文本 |
| `normalize_query` | 规范化用户输入的搜索关键词 |

保留投影文字的大小写用于摘要；匹配表达式只把 ASCII A–Z 转 a–z。数据库通过固定 `translate(...)` 表达式与确定性 collation 匹配，Python/TypeScript 使用同一规则，不能用 Unicode lower/casefold 偷换 spec。索引必须建立在实际匹配使用的同一个表达式上。

### 4.2 投影一致性先于索引

新增共享 JSON fixture（建议 `tests/fixtures/conversation_search_text_v1.json`），后端与前端读取同一文件：原文、消息角色、必要的显示元数据、期望投影、查询、区间和目标 DOM 文字。

- 用户提示/引用按各自显示文字处理；连续空白折叠为单空格并 trim。
- 助手按现有 Markdown 可见文字生成投影：段落/列表项/表格单元等块边界采用明确的空格分隔；行内加粗、链接文字与代码保留。
- 去掉不可见链接地址、格式标记、代码语言标签、工具/来源控件及 renderer 辅助按钮文字。公式和图片等不参与的节点保留边界分隔，避免两边文字被误拼接命中。
- 引用中的源码文本是用户实际可见快照，不再当成 Markdown 解析。
- 固定 Unicode 空白集合与 UTF-16 转换，覆盖 emoji、组合字符、NBSP、中文、转义、HTML entity、表格、换行、代码、重复词和跨字重匹配。

后端先用 `markdown-it-py` 的 token 解析验证 CommonMark/GFM 所需子集，必要的 math/扩展适配必须与当前前端管线一致；不使用正则剥除 Markdown。前端在既有 sanitize/render 管线中生成同语义的投影与文字节点映射。不能因为两个 parser 都支持 Markdown 就视为等价。解析器包及配置在阶段 A 通过共享 fixture 后锁入 uv.lock，不在本计划编造已验证的兼容性。[解析器 token API](https://markdown-it-py.readthedocs.io/en/latest/using.html)

目标哈希为版本与完整字段投影的 SHA-256（规定 UTF-8 输入及版本前缀）。前端加载目标消息后校验哈希和区间，只在目标字段内恢复 DOM Range；不在全页面扫描同词。若不一致，刷新一次目标详情后重试；仍不一致则显示“该搜索结果已失效”，不标错误文字。

**阶段 A 完成门：共享 fixture 的投影与 UTF-16 区间完全一致，真实 DOM 可以恢复对应文字。未满足时先修投影契约，不能用“前端再猜一次”绕过。**

## 5. 写入、回填和索引

### 5.1 新数据同事务更新

在 conversations service 内增加小范围写入辅助函数，覆盖：

- 首条/后续用户消息，纯引用消息，以及编辑重新生成的新用户消息。
- `materialize_assistant_message` 的最终正文，不对 SSE delta 或 Run 草稿反复建立索引。
- 手动标题、创建时显式标题、自动标题。自动标题任务须复用同一投影函数，在当前条件 UPDATE 中同时写 title 和 search_title，保持现有并发守卫。
- 归档与软删除通过查询时联合检查业务事实立即排除；不依靠异步清理保证权限。恢复后直接使用已保留的派生文本。
- 物理删除随原行删除，不产生孤立搜索记录。搜索、回填及索引维护不得触发 `Conversation.updated_at` 的 ORM onupdate；派生标题 UPDATE 显式保留原 updated_at，验证前后相等。

正文投影只在持久化时计算一次；记录新增写入耗时。上线阶段必须确保 API、流式 Worker 与标题 Celery 均已运行新写入逻辑，再开放查询。

### 5.2 可恢复的存量回填

新增 `app/conversation_search_admin.py`，沿用项目 `python -m app...` CLI 风格。提供 `backfill`、`verify` 子命令，不启动独立任务队列。

- 每批默认 200 行，按主键 keyset 分批提交；支持 batch size、目标版本与起始 ID。
- 仅修复 NULL/旧版本，重复执行幂等；每批提交后输出进度与耗时，不打印原文/查询。
- 每批先使用行锁与在线写入串行化，再以锁内最新原文生成派生值；标题 UPDATE 显式保留 updated_at。失败不标完成，下次继续入选。
- 首次遍历后重新从头扫 NULL/旧版本直至为零；保留错误计数，不把失败行标记完成。
- 完整覆盖可恢复的软删除会话与归档消息，保证恢复行为；最终查询仍以当前可见性为准。
- `verify` 检查缺失版本、逐行投影与 hash 一致性、四个索引的有效性；不完整时以非零退出码阻止上线搜索入口。写入路径、并发与更新时间另由测试覆盖。

### 5.3 索引候选与短词处理

以 CI 使用的 PostgreSQL 16 为基线，先对派生标题、正文、引用的 ASCII 归一化表达式建立 `pg_trgm` GIN 索引候选；消息索引可限定 `archived_at IS NULL`，查询谓词必须一致。保留用户/可见性/排序 B-tree，并用执行计划判断是否补充包含 id 的可见会话复合索引。

`pg_trgm` 支持 LIKE/ILIKE，但无法提取三元组的模式会退化为全索引扫描；单字、双字中文、符号和 emoji 均必须单测/实测，不能仅以字符长度推断索引必然生效。[PostgreSQL 16 pg_trgm](https://www.postgresql.org/docs/16/pgtrgm.html#PGTRGM-INDEX)

执行路线：

1. 对比“按用户可见会话顺序查找命中”与“文本索引取候选再按会话排序”两种计划，使用第 7 节同一数据集。
2. 长查询优先验证 trigram；无可用三元组的短查询先验证账户范围内扫描。扫描仅发生在数据库，不把正文送入应用层；不得只搜索最近 N 条。
3. 若短查询不达标，在独立实验迁移中评估去重的 1/2 字符片段数组及 GIN `@>` 候选过滤：按 Unicode 码点切分，覆盖符号，候选仍经完整连续匹配复核，不改变排序。分别记录索引体积和消息写入成本；避免不经测量就为所有正文增加额外索引。[PostgreSQL GIN 与数组操作](https://www.postgresql.org/docs/16/indexes-types.html#INDEXES-TYPES-GIN)
4. 阶段 C 结束时把实测选中的索引、SQL 形态和短词路径写回本计划，删除未采用的实验迁移。若都不达标，保持搜索关闭并记录具体瓶颈，不能擅自把最短查询改为三个字或缩小历史范围。

这是一项有输入、候选和通过条件的实施任务，不是上线后再处理的优化项。

## 6. 服务端查询流程

新增 `app/services/conversations/search.py`，对外只暴露 `search_conversations`，内部 SQL 与摘要选择不进入路由。

1. 规范化查询、校验游标和 owner；空查询走最近列表分支。
2. 在 SQL 中过滤当前账户、`deleted_at IS NULL`、`activated_at IS NOT NULL`、可见消息分支和投影版本。
3. 标题命中会话与消息命中会话合并去重，再按更新时间/id 排序并应用游标，取 limit+1。标题与消息同时命中不加权。
4. 对这一页的会话，在同一 statement 或短只读一致性事务内批量选每会话最新匹配消息；同消息正文优先引用，避免 N+1 与两次查询之间归档导致错配。
5. 在数据库侧截取命中附近有界文本与位置，应用层仅处理这一页的摘要/区间。避免为生成 30 条摘要传出 30 条巨大正文。增加并测试数据库纯函数 `search_utf16_length(text)`：Unicode 码点数加补充平面码点数，计算匹配前缀的 UTF-16 长度，只返回计数，不传输前缀全文；其扫描成本计入阶段 C。不能把 PostgreSQL 的字符位置直接视作 UTF-16 偏移。
6. 标题原始匹配区间用标题投影映射恢复；正文 target 的版本/哈希读取持久化派生字段，禁止每次在 Python 拉全正文计算。
7. 返回最多 limit 条和 next_cursor；无命中返回空数组。所有 ID 转为 public UUID。

LIMIT 只限制输出，不保证扫描量；查询计划、排序/去重开销、无结果全范围扫描必须进入基准。服务端设置查询级超时（初始 2 秒，使用事务局部设置并确保连接归还后不残留）；超时按失败处理，不交付半页假结果。前端取消请求之外，数据库超时仍需独立生效。

## 7. 性能验证与发布门槛

新增 `tests/performance/conversation_search.py`，仅操作显式指定的测试数据库；拒绝未确认的非测试目标。生成数据、运行基准与输出报告分别提供 CLI 参数，不清空任意现有数据库。

| 数据集 | 用途 |
| --- | --- |
| 1 个目标账户：1,000 会话 / 20,000 消息 | spec 基线 |
| 另加多个账户，总量至少 200,000 消息 | 验证用户过滤与全局文本索引的组合成本 |
| 单账户 10,000 会话 / 200,000 消息 | 压力曲线，记录拐点，不冒称既定 SLA |
| 单会话 1,000 条消息及多条 50KB 正文 | 区分搜索摘要与目标详情加载成本 |

固定随机种子；消息主体以中文为主，混入英语、代码、Markdown、长引用，记录实际字节分布。查询至少包括单字、双字、长句、常见词、稀有词、无结果、`%`/`_`/反斜杠、emoji、标题单独命中、消息海量命中但会话很少、同更新时间，以及首/中/末页。

- 各查询类别独立统计 p50/p95/p99、错误率、响应字节；不把无结果慢查询藏进总体平均值。
- 基线数据集预热后每类至少 100 次；并发 1 和 10 均验证 API p95 ≤ 500ms（不含前端防抖和网络）。首次冷读另行记录，不声称通过冷缓存指标；冷读不得靠重启生产数据库制造。
- 用 `EXPLAIN (ANALYZE, BUFFERS)` 记录真实行数、扫描范围、排序落盘、索引与 buffer；记录硬件、PG 版本、配置、其他账户体量。
- 比较新增文本/索引占用、回填耗时，以及用户消息/助手物化写入延迟。不得只提高搜索速度却忽略主对话写入成本。
- 响应体只随页大小和摘要上限增长；搜索请求不触发任何 detail 请求，不把全部正文实例化到 Python/浏览器。
- 目标详情接口单独报告 payload、API 延迟和前端可交互时间；若超长会话达不到可用体验，记录独立的消息窗口加载任务及验收，不隐含扩展本次接口契约。

完成门：提交基准报告到 `docs/handover/`，写明选型结论和不通过项；未实测不得把计划中的目标描述为实际性能。

## 8. 分阶段执行清单

2026-09-05 已执行本计划，勾选状态按实际结果更新；详见[实施交接](../handover/2026-09-05-conversation-search.md)。

### A. 固定文本与导航契约

- [x] 建立共享 fixture；实现后端纯投影函数及前端投影/DOM 区间实验。
- [x] 确认代码、表格、引用、重复词、跨节点命中的精确落点；公式/隐藏内容不产生意外命中。
- [x] 固定 schema、UTF-16 编码、投影 hash、签名游标和错误码，编写契约测试。
- [x] 验证真实 renderer 的文字范围，使用 CSS Custom Highlight API 标记 DOM Range，不替换 React 管理的 DOM；React context 仅控制命中消息的临时展开。

完成门：同一 fixture 在 Python、TypeScript、真实 DOM 三处语义一致；此后再写正式迁移。

### B. 派生字段、写入与回填

- [x] 在 `alembic/versions/` 新增 expand revision，执行时读取实际 head 后创建，不假定编号。
- [x] 修改 model、三类消息写入与所有标题写入路径；写入与派生投影同事务。
- [x] 实现 backfill/verify CLI；验证并发标题更新、可恢复删除、回填中断和版本重跑。
- [x] 验证旧 API 可读新增可空字段；回填不会更新会话时间，也不会进入普通 DTO。

完成门：测试数据库现有数据与新数据投影完整；新消息/标题提交后下一次查询可见。

### C. 数据库查询与索引选型

- [x] 实现两种 SQL 计划候选及第 7 节基准，选定生产方案。
- [x] 专门测试中文短词；必要时执行第 5.3 节短片段索引实验。
- [x] 实现批量摘要与代表命中，不做 N+1、总数统计和全历史应用层扫描。
- [x] 写正式索引迁移，核对 pg_trgm 扩展权限、实际 PG 版本与 collation。

完成门：数据库与 service 基准通过，静态分页完整，索引/写入成本有报告；API 实际 p95 在阶段 D 接口存在后复测，并在阶段 F 作为发布门，不能用 service 耗时替代 API 耗时。

### D. API 与前端搜索状态

- [x] 增加 route/schema、前端 API 类型与 search 方法，传递 AbortSignal。
- [x] 增加 `frontend/src/search/ConversationSearch.tsx`，在独立组件中管理搜索状态与弹窗；状态包含 query、request generation、items、cursor、selectedId、scroll 与 error/loading，独立于普通侧栏索引。
- [x] 接入 250ms 防抖、IME、首屏/分页重试；切查询、关闭、登出、切账户取消请求并使迟到响应失效。
- [x] 重开时先保留原结果和位置，在后台从第一页逐页重新验证之前已加载的范围；按 ID 合并/移除失效条目，用可见首条 ID 与行内偏移恢复滚动。新查询/关闭可中断整个验证序列，不重置仍有效的选择。
- [x] Sidebar 三种形态共用搜索动作；只新增本需求入口，不复制原型侧栏。
- [x] 空状态居中、失败样式范围、20px 气泡、滚动条同色、无全局遮罩、卡片偏上布局及中文文案按 spec 实现，复用当前前端规范。

完成门：搜索过程只请求分页 search 接口；普通对话列表、草稿、Run 状态不受影响；键盘与焦点闭环通过。

### E. 结果导航与标黄

- [x] 增加独立的临时 search navigation intent，包含 target、query 和递增 intent ID，不持久化到 URL/localStorage。
- [x] 复用普通会话路由/详情/Run 恢复；同会话点击也生成新 intent；切换账户、手动导航或新搜索目标取消旧 intent。
- [x] 详情与目标 DOM 就绪后确认消息仍可见，校验投影版本/hash，再恢复精确文字区间；异步代码渲染、附件布局稳定前不提前标黄。
- [x] 命中引用快照时展开承载引用，定位该用户消息，不跳到引用来源；取消/切换时清理临时展开状态。
- [x] 程序化定位时协调现有置底逻辑，之后保持 unpinned；流式追加与终态详情刷新不能把用户拉回底部。
- [x] 滚动稳定后只标命中文字，保持 2 秒、淡出 1 秒；减少动态效果时去掉 smooth/fade。使用现有标注颜色规范，不能照搬原型色值覆盖项目规范。
- [x] 保留现有引用来源导航的段落标注语义；如抽取共用滚动/计时逻辑，保持小接口并补既有引用回归。
- [x] 目标失效使用项目失败 toast；网络错误可重试；不把错误位置标为成功。

完成门：spec 中的所有导航、失效、长引用及流式验收通过真实浏览器验证。

### F. 集成、发布与交接

- [x] 跑第 9 节质量门与真实 API smoke，不能以 mock 样稿替代生产路径验收。
- [x] 验证 migration、旧版本兼容、回填/重试、索引失败恢复及关闭搜索后的回滚路径。
- [x] 按第 10 节顺序发布；记录实际执行人、版本和基准证据，再更新 spec 实施状态。

## 9. 测试与执行命令

以下新增文件及 CLI 在对应阶段创建后执行；本次只写计划，不把不存在的命令描述为已运行。

后端新增：`tests/services/conversations/test_search_text.py`、`test_search.py`、`test_search_backfill.py`，以及 `tests/api/test_conversation_search.py`。覆盖所有过滤条件、两账户、参数字面匹配、同时间排序、游标篡改/跨账户/换查询、标题自动生成/重命名、归档/恢复、批量摘要、请求超时与日志脱敏。数据库用真实 PostgreSQL 16，不用 SQLite 替代索引验证。

```bash
uv run alembic upgrade head
uv run pytest -q tests/services/conversations tests/api/test_conversations.py tests/api/test_conversation_search.py
uv run ruff check .
uv run mypy app
uv run pytest
```

回填 CLI 的目标 interface（数据库从明确配置的测试环境读取；生产需按发布步骤执行）：

```bash
uv run python -m app.conversation_search_admin backfill --batch-size 200 --version 1
uv run python -m app.conversation_search_admin verify --version 1
```

前端新增 `useConversationSearch.test.tsx`、搜索组件测试与目标映射测试；扩展 Sidebar、AppShell、MessageThread 及引用导航回归。API 测试验证 query/cursor/signal/envelope。完整质量门在 `frontend/` 执行：

```bash
pnpm run lint
pnpm run typecheck
pnpm exec vitest run
pnpm run build
```

新增 `frontend/tests/visual/conversation-search.visual.ts`，使用真实组件 fixture；至少一轮另接真实 FastAPI/PostgreSQL 完成搜索→详情端到端 smoke。现有 Playwright 配置默认减少动画，标黄时序用例须显式切换为正常 motion，并另测 reduced motion。

```bash
pnpm exec playwright test tests/visual/conversation-search.visual.ts --project=desktop-chrome
pnpm exec playwright test tests/visual/conversation-search.visual.ts --project=mobile-chrome
pnpm exec playwright test tests/visual/thread-bottom.visual.ts
pnpm exec playwright test tests/visual/sidebar-scroll.visual.ts
```

真实浏览器采样：1440×900 桌面与 390×844 窄屏；卡片位置、无结果/失败居中、rail 图标、键盘、滚动条、无全局遮罩；目标 DOM rect、scrollTop、颜色、标黄时间线；代码迟到渲染、长引用展开和流式追加期间位置不漂移。移动软键盘还需真实手机验证。不得更新无关 golden 来掩盖回归。

## 10. 发布、日志与回滚

新增默认关闭的 `CONVERSATION_SEARCH_ENABLED` 配置，经 capabilities 暴露给前端；关闭时不显示入口，API 返回明确不可用。该开关只控制提供搜索，不关闭新版本的投影写入。前后端版本错开或能力字段缺失时保持旧界面。

发布顺序：

1. 校验当前 migration head、数据库版本、扩展权限及备份；先扩展可空字段。
2. 搜索保持关闭，发布所有写入进程的新版本（API、流式 Worker、标题 Celery）。核对旧实例退出，避免回填后又写入缺失投影的新行。
3. 分批回填并 verify；创建选定索引、ANALYZE，复跑查询计划与 smoke。
4. 大表索引用独立迁移的并发创建步骤，明确退出事务；失败后检查无效索引、清理并重试，不能把“同名索引存在”当作创建成功。CI 小数据库可跑相同流程。[PostgreSQL 并发建索引约束](https://www.postgresql.org/docs/16/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)
5. 确认搜索请求 query string 不进入访问日志；异常堆栈/ORM error 不携带正文与绑定参数。记录耗时、查询长度区间、页大小、返回数、超时率及投影错误数即可。
6. 部署前端，再开启能力；进行真实账户权限隔离、短词、分页、重命名/归档/恢复及精确定位 smoke。

失败时先关闭能力和入口；保留派生字段与索引，不在故障期间执行破坏性 downgrade。必要时回滚应用版本；恢复新版后重新补齐并验证缺失投影，再开启搜索。数据库 downgrade 往返只在隔离测试库验证，不删除生产原始消息或标题。

完成后新增 handover，链接本计划、spec、性能报告与浏览器证据。更新 `docs/README.md` 的导航与 spec 实施状态；未完成的超长详情、手机软键盘或性能项目必须明确记录，不标记为已验收。

## 11. 实施调整

- 选定可见会话顺序加相关 EXISTS；LIMIT 在匹配之后。GIN 候选索引保留，实测高频查询主要使用会话/消息 B-tree。查询、性能和存储证据见[交接](../handover/2026-09-05-conversation-search.md)。
- 搜索标记改用 CSS Custom Highlight API 绘制 Range，避免拆分或替换 React 管理的代码高亮 DOM；临时展开仍由 React context 管理。搜索列表只加粗关键词。
- `markdown-it-py>=4.2,<5` 开启单波浪删除线并配合任务列表插件。数学占位符在解析之后移除，保持强调边界。共享 fixture 和 947 条本地历史的真实渲染比对全部一致。
- 回填通过行锁与在线写入串行化，支持显式 `--rebuild`。verify 检查所有行的文本/hash 与索引有效性。并发建索引失败后的无效同名索引会先删除再重建。
- 搜索能力在本地已开启，现有数据已回填，未部署生产。实体手机软键盘仍是设备兼容性补充验证，不标记为已测；压力账户的无结果查询超过基线 500ms，未伪称该规模达到 SLA。
