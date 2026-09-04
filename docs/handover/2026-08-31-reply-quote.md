# 回复引用功能交接

日期：2026-08-31

状态：端到端数据闭环、UI/编辑修复、引用换行与来源跳转均已实施

需求与计划：

- `docs/specs/2026-08-31-reply-quote.md`
- `docs/plans/2026-08-31-reply-quote.md`
- `docs/plans/2026-09-04-reply-quote-ui-parity.md`
- `docs/plans/2026-09-05-reply-quote-source-navigation.md`

## 2026-09-05 引用来源跳转与标注

已按真实 Chrome 基线实现 Composer、live/pending 用户消息和新公开分享中的引用回源。创建引用时，
final assistant Markdown 将 parser 已有的 unist source offset 投影为安全 DOM attribute；Selection
保存 `Range.startContainer` 最近语义节点的 `{version: 1, start, end}`。该 anchor 随草稿、pending、
请求、消息响应和编辑继承持久化，但不会进入模型输入或 Run transcript。

点击可解析引用后，共享导航模块在实际消息滚动容器内按来源消息与 anchor 精确恢复节点；重复文本
不做 `indexOf` 猜测，同范围嵌套节点按 DOM 顺序优先外层。滚动稳定后使用
`rgba(255, 235, 140, 0.6)` 保持约 2 秒并以 1 秒淡出；reduced motion 下立即标注并取消平滑/淡出。
按钮保持焦点，URL/hash、Composer 和消息状态不变。旧 live 引用只有在已限定来源正文中 excerpt
唯一出现时才兼容标注，歧义时只滚到来源消息。

公开分享快照新增 `source_message_index` 与 anchor。index 只引用同一公开 `messages` 数组内更早的
assistant，不是数据库 position，也不暴露 live/public/internal message id；已有 immutable snapshot
不回填且保持静态。`ReplyQuote` 的 message 外观、三行 clamp、颜色、hover 和 SVG 未改变，Composer
来源按钮与移除按钮保持 sibling。

数据库迁移 `20260905_0022` 增加三列 nullable anchor tuple 和显式完整性约束。合法分支必须先要求
三列均非空，避免 PostgreSQL `CHECK` 的 `NULL` 三值逻辑让半 tuple 通过；来源外键 `SET NULL` 后
excerpt 与 anchor 继续保留。

本次验证结果：后端相关 schema/service/API 105 passed；前端定向 211 passed、全量 Vitest
79 files/696 tests passed；Ruff、mypy、ESLint、typecheck 与 production build 通过。migration 在
显式本地测试数据库完成 `0022 -> 0021 -> 0022` 往返。`thread-bottom` 与 `assistant-rendering` 的
desktop/mobile Chrome 共 4 个定向项目通过；独立 agent-browser 复测确认 Composer 来源按钮点击后
命中正确段落，焦点和 URL 不变。

## 2026-09-05 发送后引用换行策略修正

2026-09-04 的 UI 对齐把发送后引用设为 `white-space: pre-wrap`，会把选区中的每个 `LF` 当成
强制换行；连续两个 `LF` 还会占用三行 clamp 中的一整行。此前视觉 fixture 使用无换行的长字符串，
只证明了宽度和三行上限，没有覆盖这个差异。

真实 Chrome 对同一组《春望》引用重新测量后确认，ChatGPT 的引用文本节点仍完整保留原始
`LF`，但计算样式为 `white-space: normal`、`overflow-wrap: break-word` 和 `text-align: center`。
因此 `innerText` 会把连续空白折叠为空格，文本先填满当前行再自然换行；短引用即使跨越多个来源
段落也可以只占一个 20px 文本行，长引用仍在三行、60px 处截断。

修复只调整 `ReplyQuote` 的 message 模式；Composer 继续维持原有预览策略。live、pending/server
和 public share 因共用同一 message 原语而同步生效。Selection、DTO、数据库、Run transcript、复制
与分享快照继续保存完整 excerpt，没有执行字符串替换或数据迁移。

回归覆盖补充了带真实 `LF` 的 live/share fixture，并检查 DOM 原文、折叠后的 `innerText`、
`white-space`、`overflow-wrap`、`text-align` 和三行 clamp。验证结果：

- `pnpm exec vitest run`：77 files、673 tests 全部通过。
- `pnpm run lint`、`pnpm run typecheck`、`pnpm run build`：通过；build 只有既有大 chunk 警告。
- `assistant-rendering.visual.ts` 与 `thread-bottom.visual.ts` 的 desktop/mobile Chrome：4 passed。
- live Piko 实页复测：引用行 752px、文本区 726px、长引用 60px；DOM 保留 `LF`，可见三行不再含由原文换行制造的空行。

## 2026-09-04 编辑并重发 500 修复

已持久化的带引用用户消息通过 `edit-and-regenerate` 重新发送时，服务端曾在继承
`target.reply_quote_source` 时触发 SQLAlchemy 隐式异步查询。目标消息查询没有显式加载这条
自引用关系，普通属性访问因此抛出 `MissingGreenlet` 并返回 500；无引用消息因来源外键为空而
不会触发该路径。

修复在归档旧分支前按 `reply_quote_source_message_id` 显式 `await session.get()` 来源消息，并把
已经加载的对象赋给新用户消息。这样新消息构造和随后 `MessageResponse` 序列化均不再产生隐式
数据库 I/O，同时继续继承不可变 excerpt 和可空来源关系。

新增 HTTP 回归测试先在独立 Session 中持久化一轮带引用的完整对话，再调用公开
`edit-and-regenerate` 路由；测试验证返回 201、新提示文字生效、原来源公开 ID 与 excerpt 完整
继承且新 Run 进入 queued。该测试在修复前稳定以同一 `MissingGreenlet` 失败，修复后通过。

验证结果：

- `tests/services/conversations/test_regenerate.py` 与发送/普通编辑/引用编辑 API 聚焦回归：15 passed。
- `uv run ruff check app/services/conversations/service.py tests/api/test_conversations.py`：通过。
- `uv run mypy app`：140 个源文件通过。
- 本地 Compose API 已重新构建并单独重启，启动检查通过；数据库与 Worker 未重启。

## 2026-09-04 UI 验收修正

数据、API、Run transcript、编辑继承和公开分享契约保持有效。真实 Chrome 复核发现原实现仍有四项 UI 偏差：选择过程中会提前出现浮层且浮层过大；发送后引用受用户气泡 70% 宽度约束并缺少三行限制和 hover；Composer 引用区与输入主体没有背景分层；回复引用箭头不是参考的 20px 填充 SVG。

修正工作已按 `docs/plans/2026-09-04-reply-quote-ui-parity.md` 完成。该计划取代本文下方关于“立即展示”“44px 以上可见动作高度”“发送后完整展开”和“Composer 无额外背景”的旧 UI 验收结论；下方记录继续作为 2026-08-31 实施时的历史证据，不代表修正后的最终视觉状态。

实施结果：

- Selection 动作在 pointer 选择期间隐藏，最后一次有效变化或 release 后稳定 100ms 再发布；scroll、resize、Escape 和外部 pointer 会取消 timer，旧选区不会复活。多行选区改用整个 Range 外接矩形定位。
- “询问Piko”可见表面为 36px 高、14/20、12px 圆角和参考阴影；4px 锚点定位，44px 命中高度由伪元素提供。
- 发送后引用使用正文列减 16px 的独立宽度、14/20、三行 clamp、`#8f8f8f` 默认色和 `#0d0d0d` hover；用户气泡宽度不变。
- Composer 拆为 `#f9f9f9` 引用前导区和 `#ffffff` 输入主体。前导背景自身匹配顶部圆角，没有裁剪 Composer 外层，因此现有模型菜单仍可向外展开。
- 回复箭头和 Composer 关闭按钮均改为 20×20 填充 SVG；live、pending/server 和 public share 继续复用同一 `ReplyQuote` message 原语。
- `thread-bottom` 现在使用真实 mouse drag 验证选择期间隐藏和 release 后展示时延，并保存 selection、Composer、sent quote 截图；`assistant-rendering` 使用同一长 excerpt 对比 live 与生产 SharePage 的几何和计算样式。

验证结果：

- `pnpm lint`、`pnpm typecheck`、`pnpm build`：通过；build 只有既有大 chunk 警告。
- `pnpm exec vitest run`：77 files、672 tests 全部通过。
- 回复引用定向 Playwright：desktop/mobile 的 `thread-bottom.visual.ts` 和 `assistant-rendering.visual.ts` 均通过。
- 全量 Playwright：5 passed、2 skipped、1 failed；唯一失败仍是未修改的 `sidebar-scroll.visual.ts` 在当前 macOS Chromium overlay scrollbar 下量得 `scrollbarWidth=0`，与本文原有记录一致。
- `uv run pytest -q tests/schemas/test_conversation_schemas.py tests/api/test_shares.py tests/services/shares/test_share_service.py`：46 passed、3 个既有 HTTP 422 deprecation warnings。
- `git diff --check`：通过。

## 实现结论

回复引用已形成从 final assistant 正文选区到 Composer、消息/Run、编辑并重新生成、公开分享与来源标注的端到端闭环。实现只在既有 Markdown pipeline 末端投影 parser source position，没有改变 parser/sanitize 规则、SSE event、agent Content Block、Provider Adapter 或附件授权协议。

### 数据库与 API

迁移 `20260831_0021_add_reply_quotes.py` 为 `messages` 增加：

- `reply_quote_source_message_id`：自引用来源，删除来源时 `SET NULL`；
- `reply_quote_excerpt`：1–4,000 Unicode 字符的不可变快照；
- `reply_quote_source_anchor_version/start/end`：可选、版本化的 UI 来源语义节点范围；
- 来源必须带 excerpt、只有 user message 可带 excerpt、excerpt 不得全为空白的数据库约束。

已有会话发送请求接受 `{source_message_id, excerpt, source_anchor?}`。新会话首条消息和编辑请求不接受该字段；编辑服务从目标 user message 继承原关系、excerpt 与 anchor。消息响应允许来源标识为空但继续返回 excerpt/anchor。公开分享冻结 `{excerpt, source_message_index, source_anchor}`，其中 index 只属于快照数组，不披露来源 public/internal id。

来源验证在 conversation 行锁和 next position 已确定后进行；不存在、越权、跨会话、错误角色、归档或顺序错误统一为 `REPLY_QUOTE_SOURCE_INVALID` / `The quoted reply is unavailable`，避免存在性探测。

### 模型输入与 transcript

`messages.content` 始终只保存用户实际提示文字。会话服务把 excerpt 作为 JSON 编码的低信任用户数据投影到现有 `TextBlock`；投影明确声明其中的命令不能覆盖 system/developer 指令。提示为空时只在模型投影中附加固定意图“解释这段引用内容”。

该模型文本进入 `prepare_attachment_plan()`，因此完整 excerpt 参与目标 turn token 预算，并与 Document/Image/Notice blocks 一起固化进 Run transcript。普通无引用消息仍把原 `content` 原样交给既有路径；网页搜索抑制继续只读取用户实际 `content`。

### 前端状态与交互

- `ReplyQuote` DTO 在已发送消息、pending submission 和草稿中保持同一形状并携带可选 source anchor；发送草稿把来源标识收窄为非空。
- Composer reducer 持有当前回复引用；`replyQuoteDraftStore` 按用户和已有 conversation 隔离 localStorage。新会话不保存，登出/认证失效/身份切换/会话删除会清理。
- final assistant 的 Markdown 外壳提供唯一 selection marker。`useReplyQuoteSelection` 要求选区两端在同一 marker 内，读取 `Selection.toString()`，保存最后一个非零 Range rect，并在外部 pointer、Escape、scroll、resize 或路由变化时销毁候选。
- “询问Piko”通过 body portal fixed 定位，优先在选区上方并进行 viewport clamp；空间不足时翻到下方。点击保留原选区到 pointerdown 后，写入/替换 Composer 草稿、清空 Selection 并聚焦 textarea。
- Composer 引用位于附件之前，只有箭头、三行视觉预览和“取消引用”；完整 excerpt 不截断。引用-only 可发送。
- user turn 固定为附件 → 回复引用 → 用户气泡；content 为空时不渲染气泡。复制优先 content，否则 excerpt。编辑面板展示不可移除的引用并允许空提示保存。
- live、pending/server 接管和 public share 使用同一个 `ReplyQuote` message 原语；可解析状态渲染为来源按钮。Composer 的引用详情按钮和取消引用按钮相互独立。
- `replyQuoteSourceNavigation` 统一 exact anchor、legacy 唯一文本降级、滚动稳定检测、标黄时间线和 cleanup；live 按 message id 限定来源 root，share 只按 snapshot-local index 限定。

## 真实 Chrome 证据

现有 `thread-bottom` AppShell fixture 增加了真实 final assistant 文本和可回显回复引用的 fake API。Playwright 通过 `document.createRange()` 完成：

1. 原生选区与单个“询问Piko”；
2. 点击后的 Composer 引用和 textarea focus；
3. 发送后的灰色引用行与右对齐用户气泡。

桌面 `1440×900` 和移动 `390×844`、DPR 1、浅色 Chromium 均检查并附加 JSON/PNG artifact：selection/action、Composer、quote/bubble、viewport 与 document overflow。还验证 Escape、resize、thread scroll dismiss、Selection collapse、44px 以上动作高度、viewport clamp、引用在气泡上方、右边界关系和无页面水平 overflow。原有 sticky Composer、底部 fade、136px 阈值、blur 与 reduced-motion 断言继续运行。

三张视觉事实源仍位于 `docs/specs/assets/reply-quote/`；本实现只把“询问 ChatGPT”替换为单段“询问Piko”，未修改宿主 canvas。

## 验证

定向验证已通过：

```bash
uv run pytest -q tests/schemas/test_conversation_schemas.py tests/api/test_conversations.py tests/api/test_shares.py tests/services/conversations/test_service.py tests/services/conversations/test_regenerate.py
# 75 passed

cd frontend
pnpm exec vitest run src/app/store.test.ts src/conversations/replyQuoteDraftStore.test.ts \
  src/conversations/useSendMessage.test.tsx src/conversations/useRegenerate.test.tsx \
  src/ui/Composer.test.tsx src/messages/Message.test.tsx \
  src/messages/SharePage.test.tsx src/messages/MessageThread.test.tsx src/app/AppShell.test.tsx
pnpm exec playwright test tests/visual/thread-bottom.visual.ts
# Playwright: desktop/mobile 2 passed
```

最终验证结果：

- `uv run ruff check .`：通过；`uv run mypy app`：通过。
- migration 在显式本地数据库 URL 上完成 `0021 -> 0020 -> head` 往返。
- 回复引用后端聚焦测试：13 passed；Run/worker 回归：78 passed；此前会话/schema/API 聚合回归：75 passed。
- `pnpm exec vitest run`：77 files、669 tests 全部通过；最后改动后的 10 个相关文件重跑为 161 passed。
- `pnpm run lint`、`pnpm run typecheck`、`pnpm run build`：通过；Vite 只有既有大 chunk 警告。
- `thread-bottom.visual.ts` 最终桌面/移动重跑：2 passed。
- 全量 `pytest` 两次分别在 1,200 秒超时前到 28% 和约 35%；后一次已执行部分无失败，因此没有取得全量通过结论。
- 全量 Playwright 为 5 passed、2 skipped、1 failed；唯一失败是未改动的 `sidebar-scroll.visual.ts` 在当前 macOS Chromium overlay scrollbar 下量得 `scrollbarWidth=0`，其独立重跑稳定复现。回复引用所在的桌面/移动项目均通过。

## 上线顺序

1. 备份 PostgreSQL，先部署 migration + 兼容 API/Worker；所有新增字段均可选。
2. smoke 普通消息、引用+提示、引用-only、非法跨会话来源、编辑继承和公开分享。
3. 再部署前端选择入口与历史读取展示。
4. 在真实桌面/移动 Chrome 执行选择、替换、关闭、直接发送、带提示发送、复制和分享。
5. 观察 422/409、Run 创建失败、share snapshot 和 quote-only 空白 turn。

## 回滚

优先关闭前端选择/发送入口，但保留 Message 与 SharePage 的读取展示。一旦生产出现 `content=""` 的 quote-only user message，不得回滚到完全不认识回复引用的旧前端。

API 回滚版本必须继续返回已有 `reply_quote`，只停止接受新引用。不要把 excerpt 写进 `messages.content` 伪装成用户提示。只有确认生产无引用数据或已完成数据处置后，才能 downgrade `20260831_0021` 删除列。
