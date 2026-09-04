# 回复引用来源跳转与标注可执行计划

日期：2026-09-05

状态：已实施（2026-09-05）

关联文档：

- [`docs/specs/2026-08-31-reply-quote.md`](../specs/2026-08-31-reply-quote.md)
- [`docs/plans/2026-08-31-reply-quote.md`](./2026-08-31-reply-quote.md)
- [`docs/plans/2026-09-04-reply-quote-ui-parity.md`](./2026-09-04-reply-quote-ui-parity.md)
- [`docs/handover/2026-08-31-reply-quote.md`](../handover/2026-08-31-reply-quote.md)
- [`docs/handover/2026-06-18-conversation-sharing.md`](../handover/2026-06-18-conversation-sharing.md)
- [`docs/adr/0011-grant-attachment-reads-to-public-shares.md`](../adr/0011-grant-attachment-reads-to-public-shares.md)

## 执行摘要

Piko 当前只保存回复引用的来源消息关系和不可变 excerpt。该数据足以展示引用，却不足以在同一
助手消息存在重复文字时恢复用户当初选择的准确位置。当前 `ReplyQuote` 的 message 模式也是无
交互语义的 `div`；Composer 只有“取消引用”可点击；公开分享快照又刻意只保留 excerpt。

本计划新增一个独立的“来源锚点”事实：选区创建时记录其起点所在 Markdown 语义节点的稳定范围，
发送后随回复引用持久化。点击引用时，前端用“来源消息 + 来源锚点”恢复目标节点，在消息滚动容器
中平滑定位，滚动完成后短暂标黄并淡出。live、pending、Composer 和 public share 复用同一个
导航模块；分享快照只保存数组内来源索引，不暴露内部或 public message id。

这项工作取代 2026-09-04 UI 对齐计划中“发送后引用不提供来源跳转”的范围限定，但不改写该计划
已经冻结的尺寸、排版、颜色、三行 clamp、Composer 背景和 SVG 结论。

## 执行结果

- 新增 `markdown-node-v1` source anchor，完成 selection → 草稿 → pending → API → PostgreSQL →
  response → edit inheritance 的完整闭环；模型输入与 Run transcript 仍只接收 excerpt。
- live 与 share 共用 `replyQuoteSourceNavigation`，支持 exact anchor、legacy 唯一文本降级、实际滚动
  root 定位、滚动稳定检测、2 秒标黄、1 秒淡出、reduced motion 和 cleanup。
- Composer 详情、sent/pending 与新 share 引用均可点击；公开快照只使用 array-local
  `source_message_index`，share API/DOM 不暴露来源 message id。
- `20260905_0022` 已在显式本地测试数据库完成 upgrade/downgrade/upgrade；额外回归发现并修正了
  PostgreSQL `CHECK` 的 `NULL` 三值逻辑问题，合法分支显式要求三列全部非空。
- 后端相关 schema/service/API 共 105 个测试通过；前端定向 211 个测试、全量 79 files/696 tests
  通过；Ruff、mypy、ESLint、typecheck 与 production build 通过。
- `thread-bottom` 与 `assistant-rendering` 在 desktop/mobile Chrome 共 4 个定向项目通过。独立
  agent-browser 实测 Composer 详情点击后命中 `P[data-start=3745][data-end=4156]`，按钮焦点和 URL
  均保持不变。

以下阶段清单保留为实施顺序与回归路由；完成状态以文末 Definition of Done 和上述真实命令结果为准。

## 可观察成功标准

1. Composer 中引用文字可点击，右侧取消引用仍是独立按钮。
2. live 会话中已发送及 optimistic pending 用户消息上方的引用可点击。
3. 新创建的公开分享中，具有可解析来源的引用可点击，行为与 live 一致。
4. 点击后 URL、路由、Composer 内容和消息状态均不变化；键盘焦点继续留在引用按钮。
5. 页面平滑滚动到原 Assistant 正文中的准确语义节点；重复 excerpt 不得跳到同消息中的第一次
   文本匹配。
6. 滚动稳定后目标节点使用 `rgba(255, 235, 140, 0.6)` 标黄约 2 秒，再用 1 秒淡出；
   `prefers-reduced-motion` 下取消平滑滚动和淡出，但仍提供立即可见的来源标注。
7. 局部选择普通段落时标黄整个段落；选择加粗等内联语义节点时标黄该节点；跨节点选择时标黄
   文档顺序中的起始语义节点。
8. 来源已不可用、锚点无效或旧分享无法解析时不得猜错来源；引用快照仍可阅读。
9. 分享响应不包含 message id、数据库 position、run id、用户身份或其他私有句柄。
10. 现有引用行和 Composer 几何不发生变化，live/share 保持同一视觉原语。

## 2026-09-05 ChatGPT Chrome 参考基线

以下结论来自登录会话页与对应公开分享页的真实 Chrome DOM、焦点、滚动位置和计算样式实测。
实现只复刻可观察行为，不依赖或复制 ChatGPT 私有 class、状态或接口。

### 可点击位置

| Surface | DOM/可访问性行为 | 点击效果 |
| --- | --- | --- |
| Composer 引用 | 引用文字是 `button`，可访问名称为“有关回复内容的详情”；移除是相邻的独立按钮 | 回到来源并标黄 |
| live 已发送用户消息 | 箭头与三行引用共同组成一个原生 `button`，按钮名称来自完整 excerpt | 回到来源并标黄 |
| public share 用户消息 | 与 live 使用相同的引用按钮语义 | 回到快照内来源并标黄 |
| 用户消息编辑态 | 引用块不显示 | 没有跳转入口 |

当前参考会话中共确认 4 个 live 已发送引用按钮；对应分享快照中有 3 个引用按钮，三者行为与 live
一致。ChatGPT 会虚拟化消息，因此验收应按消息结构和来源关系定位，不能把一次滚动状态下的固定
viewport 坐标写成产品 contract。

### 点击时间线

```text
click
  -> 引用按钮保留 focus
  -> 消息滚动容器平滑滚动，URL/hash 不变
  -> 滚动结束后来源节点出现 rgba(255, 235, 140, 0.6)
  -> 约 2 秒保持
  -> background-color 约 1 秒淡出
  -> 清理临时 inline style/timer
```

参考样本中标注通常在点击后约 700–800ms、即平滑滚动结束时出现，约 4 秒内完全清理。实现不应
把 700ms 写成固定 sleep；应等待真实滚动稳定，并以最大超时兜底。

### 来源锚点粒度证据

- `good enough to trust` 在来源消息内出现多次；点击引用命中用户实际选择的第二处
  `<strong data-start="112" data-end="136">`，没有命中第一处相同文字。
- 只选择普通段落中的“自然地”后，Composer 显示精确 excerpt“自然地”，点击却标黄完整
  `<p data-start="157" data-end="166">更自然地翻译就是：</p>`。
- 选择完整加粗段落时，`p` 与 `strong` 可能具有相同 `data-start/data-end`；点击标黄 DOM 顺序中
  更外层的 `p`。
- 跨段引用只标黄选区起点所在的第一个语义节点，不把完整多段 excerpt 全部染黄。
- 参考 DOM 的范围包含 Markdown delimiter；例如 20 个可见字符的 `**good enough to trust**`
  范围长度为 24。因此该位置最接近规范化 Markdown AST 的 source offset，而不是可见文本的
  `indexOf` 结果。

ChatGPT 的私有持久化格式不可见；本计划只冻结上述等价行为。

## 范围

### 本次包含

- final Assistant Markdown 语义节点的位置标注。
- 选择时捕获来源锚点。
- 草稿、pending、请求、数据库、响应、编辑继承和分享快照中的锚点闭环。
- Composer、live/pending message 和 public share 的引用点击语义。
- live/share 共用的滚动、目标恢复、标黄、淡出、清理和兼容降级模块。
- 旧 live 消息、旧消息创建的新分享和既有不可解析分享的兼容策略。
- 单元、服务、接口、组件和真实 Chrome 验收。
- 领域、架构、规格、计划和交接文档同步。

### 本次不包含

- 不允许引用 streaming、thinking、附件、来源卡片、消息操作或跨消息选区。
- 不增加跨会话引用、多引用、引用编辑、引用展开或用户自行改变来源。
- 不把来源锚点或分享数组索引加入 LLM 输入或 Run transcript。
- 不用 excerpt 全局模糊搜索作为新数据的主路径。
- 不向 public share 暴露 live/public/internal message id 或数据库 `position`。
- 不回填或改写已经创建的 immutable share snapshot。
- 不在点击引用时修改浏览器 URL/hash、打开弹窗、切换会话或聚焦来源节点。
- 不改变现有引用行尺寸、三行限制、文字颜色、hover、Composer 背景、用户气泡宽度或回复箭头。
- 不在本次顺带改变 Piko 编辑态仍展示不可移除引用的既有产品语义；编辑态引用保持静态、不可点击。
- 不增加第三方依赖。

## 冻结设计

### 1. 领域事实：回复引用来源锚点

回复引用继续由三个相互独立的事实组成：

1. `source_message_id`：来源 Assistant 消息关系，用于会话、角色和顺序约束。
2. `excerpt`：用户选择文本的不可变、低信任快照，继续参与展示和模型输入投影。
3. `source_anchor`：只用于 UI 恢复来源位置的不可变语义节点坐标，不改变 excerpt 的信任级别。

wire contract 使用版本化对象：

```ts
type ReplyQuoteSourceAnchor = {
  version: 1;
  start: number;
  end: number;
};
```

坐标语义冻结为：

- 基于 final Assistant 实际送入 `react-markdown` 的规范化 Markdown 字符串。
- `start/end` 对应选区文档顺序起点所在的最近可引用 Markdown 语义节点的 unist source offset。
- offset 使用 JavaScript/DOM 字符串坐标，即 UTF-16 code unit；`end` 为 exclusive。
- Markdown delimiter 属于范围，例如 `**text**` 的范围包含两侧四个 `*`。
- `version=1` 表示 `markdown-node-v1`，后续坐标含义变化必须新增版本，不得静默重解释旧值。
- 锚点可以在来源物理删除后继续保留，但 `source_message_id=null` 时前端不得提供跳转。

来源锚点是用户可控制的低信任数据。后端只验证形状、整数边界、`start < end` 和现有来源消息关系，
不尝试用另一套 Markdown renderer 证明它一定对应 excerpt。伪造锚点最多改变当前用户可见消息内的
滚动位置，不得获得额外读取或授权能力。

### 2. 数据库表示

新增 migration `alembic/versions/20260905_0022_add_reply_quote_source_anchor.py`，在 `messages` 增加：

- `reply_quote_source_anchor_version SMALLINT NULL`
- `reply_quote_source_anchor_start INTEGER NULL`
- `reply_quote_source_anchor_end INTEGER NULL`

增加一个 tuple check constraint：

```text
三列全部为 NULL
OR
version = 1
AND start >= 0
AND end > start
AND role = 'user'
AND reply_quote_excerpt IS NOT NULL
```

不得要求 `reply_quote_source_message_id IS NOT NULL`：现有自引用外键使用 `ON DELETE SET NULL`，来源
删除时必须继续保留 excerpt 和锚点快照，不能让外键动作被 check constraint 阻断。

三个字段都必须 nullable，以支持已有数据、先部署后端再部署前端和安全回滚。ORM 继续把来源关系
和三列定义在 `Message`；不得把业务校验放进 model 方法。

### 3. API 表示

后端新增 `ReplyQuoteSourceAnchor` Pydantic schema：

- `version: Literal[1]`
- `start/end: int`，范围 `0..2_147_483_647`
- model validator 强制 `end > start`
- `extra="forbid"`

`ReplyQuoteRequest` 和 `ReplyQuoteResponse` 增加：

```json
{
  "source_message_id": "...",
  "excerpt": "...",
  "source_anchor": {"version": 1, "start": 112, "end": 136}
}
```

部署兼容规则：

- request 中 `source_anchor` 暂时可选；旧前端仍可发送引用。
- 新前端由受支持 Markdown 选区创建的 quote 必须发送非空 anchor。
- response 对已有行返回 `source_anchor: null`。
- `MessageEditAndRegenerateRequest` 仍不接受客户端提供 reply quote；编辑服务从目标 user message
  继承来源、excerpt 和三列锚点，维持不可变性。
- `project_reply_quote_model_input()` 继续只投影 excerpt 和 prompt，绝不投影 anchor。

前端 `ReplyQuote` / `ReplyQuoteDraft` / pending submission 使用同一 `source_anchor` 结构；
`replyQuoteDraftStore` 保持现有 storage key，读取时同时接受缺失 anchor 的旧草稿，新写入保留 anchor。

### 4. 公开分享表示

`SharedReplyQuote` 扩展为：

```ts
type SharedReplyQuote = {
  excerpt: string;
  source_message_index?: number | null;
  source_anchor?: ReplyQuoteSourceAnchor | null;
};
```

创建分享时，`_build_snapshot` 先为当前 snapshot 中的消息建立 `message.id -> array index` 内存映射，
再生成每个 user message 的 reply quote：

- 只有来源消息也在同一快照内、role 为 Assistant 且 index 小于当前 user message index 时，才写
  `source_message_index`。
- `source_message_index` 是公开 `messages` 数组本身已有的局部坐标，不是数据库 `position`，也不
  暴露任何 message id。
- 来源不可用时写 `null`；excerpt 仍保留。
- anchor 只在三列构成合法 version 1 tuple 时写入。
- 已有 snapshot 缺少新增字段，Pydantic 和前端必须按 `null` 读取；不得迁移或回填。

该设计扩展了 2026-06-18 分享 handover 中“快照仅包含展示字段”的旧说明，但不改变 ADR 0011 的
核心隐私决定：所有引用都只指向同一已公开快照中的内容，不增加附件授权，也不暴露内部句柄。
实施时更新 handover 与架构文档即可，不需要新 ADR；若实施中改为暴露任意 message id，则必须
停止并重新评审隐私决定。

### 5. Markdown 来源锚点

新增 `frontend/src/messages/markdown/rehypeReplyQuoteAnchors.ts`。该模块在 sanitize、KaTeX 和
citation 转换之后运行，只给仍有合法 `node.position.start.offset/end.offset` 的允许列表语义节点
写入：

```text
data-reply-quote-start
data-reply-quote-end
```

第一版允许列表：

```text
p, h1..h6, li, blockquote, pre, code, strong, em, del, a, table, th, td
```

规则：

- 不为按钮、citation 控件、复制控件、HTML preview iframe、KaTeX 生成且无原 source position
  的内部节点伪造坐标。
- 同一范围可出现在嵌套节点上；恢复时按 DOM 顺序选择第一个匹配元素，使仅含一个 `strong` 的
  `p` 与 ChatGPT 一样优先标黄外层 `p`。
- `Markdown` 增加显式 `replyQuoteAnchors?: boolean`，只有 final live 和 public share 开启；
  streaming 不开启，避免把临时位置误当成稳定锚点。
- plugin 必须放在 pipeline 最后，避免 `rehype-sanitize` 删除属性，也避免后续 transform 使位置
  指向已被替换的 DOM。
- `MarkdownLink`、`CodeBlock`、`TableBlock` 等自定义 renderer 必须显式把 anchor 属性投影到
  实际可选择的外层 DOM；不能把 react-markdown 的 `node` prop spread 到 DOM。
- Citation 本身是 button 且保持 `user-select:none`；选择其相邻正文时由父语义节点提供锚点。

live 来源正文继续使用已有 `data-reply-quote-message-id`。share Assistant 正文新增
`data-reply-quote-share-index`，值为公开数组索引；不能复用或序列化 live message id。

### 6. 深导航模块

新增 `frontend/src/messages/replyQuoteSourceNavigation.ts`，把 DOM 位置恢复、兼容搜索、滚动等待、
标黄动画、timer 和 cleanup 收进一个深模块。调用方只使用两个 Interface：

```ts
captureReplyQuoteSourceAnchor(
  range: Range,
  sourceRoot: HTMLElement,
): ReplyQuoteSourceAnchor | null;

revealReplyQuoteSource({
  scrollRoot,
  sourceRoot,
  sourceAnchor,
  excerpt,
}: RevealReplyQuoteSourceInput): ReplyQuoteRevealHandle;
```

`ReplyQuoteRevealHandle` 只暴露 `revealed: boolean` 和 `cancel(): void`。React caller 在路由切换、
unmount 或新的 reveal 取代同一目标时调用 `cancel`；timer、`scrollend`/RAF fallback、旧 inline
style 和 animation 细节均不泄漏给 `AppShell`、`Message` 或 `SharePage`。

#### 捕获算法

1. 继续由 `useReplyQuoteSelection` 验证 Selection 非折叠、两端在同一个 final Assistant root、
   未进入排除区且拥有非零几何。
2. 使用 `selection.getRangeAt(0).startContainer`，而不是拖动方向相关的 `selection.anchorNode`，
   确保反向选择仍以文档顺序中的第一段为来源锚点。
3. 从 start container 向上找最近的合法 anchor 节点，并验证它仍在同一个 source root 内。
4. 解析 data 属性为安全整数；无效或 `end <= start` 时返回 null。
5. candidate 同时保存 `{sourceMessageId, excerpt, sourceAnchor, rect}`；100ms 稳定期结束重新读取时，
   anchor 也是候选一致性比较的一部分。
6. 极少数无锚点但仍符合现有选择规则的内容允许继续创建 excerpt-only quote，以保持数据功能可用；
   新增测试保证第一版允许列表覆盖现有普通 Markdown、链接、代码、表格和数学正文入口。

#### 恢复与滚动算法

1. 新数据先在 `sourceRoot` 内查找 start/end 完全相同的 anchor；存在多个时取 DOM 顺序第一项。
2. 目标坐标相对实际 scroll root 计算，不使用页面 `window.scrollY`：

```text
contextOffset = clamp(70px, scrollRoot.clientHeight * 0.20, 200px)
targetScrollTop = currentScrollTop
                + targetRect.top
                - scrollRootRect.top
                - contextOffset
```

3. 对 `targetScrollTop` 做 `0..maxScrollTop` clamp；普通模式使用 `scrollTo({behavior:"smooth"})`，
   reduced motion 使用 `auto`。
4. 用原生 `scrollend`（可用时）或连续三帧 `scrollTop` 不变的 RAF fallback 判定完成，并设置
   900ms 最大超时；不得使用固定 700ms sleep。
5. 不调用来源元素的 `.focus()`，不写 history/hash；引用按钮因未卸载自然保留 focus。
6. live 的程序化向上滚动允许现有 `useStickToBottom` 进入 unpinned 阅读状态，后续 streaming delta
   不得把用户重新拉回底部。

#### 标注算法

滚动完成后直接对恢复出的语义元素临时设置：

```text
transition: none
background-color: rgba(255, 235, 140, 0.6)
```

2 秒后改为 `transition: background-color 1s` 并移除临时 background，使其淡回原背景；1 秒后恢复
元素点击前的原始 inline `transition` 与 `background-color`。实现必须：

- 保存并恢复原值，不能覆盖 KaTeX、code 或未来 renderer 的既有 inline style。
- 同一节点再次点击时取消并重启旧 timer；不同节点的标注可以各自完成淡出。
- target 被卸载时静默清理，不抛错、不产生 React state update after unmount。
- reduced motion 下立即显示、保持 2 秒后直接恢复，不执行 smooth scroll 或 fade transition。

#### 旧数据兼容

对 `source_anchor=null` 但来源 root 可解析的旧 live 消息或新建 share：

1. 只在已由 source id/index 限定的单个 Assistant root 内搜索。
2. 对 excerpt 和可选择正文构造折叠连续空白的映射，保留从规范化字符位置回到语义节点的关系。
3. 若规范化 excerpt 在该 root 中恰好出现一次，使用命中起点所在语义节点执行标注。
4. 若出现零次或多次，只滚动到来源 Assistant 消息，不标黄任意猜测节点。
5. 来源 id/index 为空时引用保持静态，不进行跨消息 excerpt 搜索。

已创建的历史 share snapshot 只有 excerpt，既无来源 id 也无数组索引，必须保持静态。该限制是
immutable snapshot 的预期兼容行为，不视为运行时错误。

### 7. UI 交互语义

`ReplyQuote` 新增可选 `onReveal`：

- `variant="message"` 且存在 `onReveal` 时，根节点改为原生 `button type="button"`；箭头
  `aria-hidden`，完整 excerpt 作为按钮可访问名称和 DOM text content。
- `variant="message"` 无 `onReveal` 时继续使用非交互元素，并移除只在 clickable 状态才有意义的
  cursor、hover 与 focus 样式。
- `variant="composer"` 外层仍是布局容器；excerpt 从 `blockquote` 改为内部按钮，
  `aria-label="有关回复内容的详情"`；“取消引用”继续是相邻按钮，禁止嵌套 button。
- 点击不得清除 Composer draft、附件或当前引用。
- message/composer 的宽度、margin、gap、line clamp、文本和 SVG 几何沿用当前实现。

live 装配：

- `AppShell` 基于现有 `threadRef` 建立唯一 `revealLiveReplyQuote(quote)` 回调。
- MessageThread 的 `onReplyQuote` 改为接收完整 `ReplyQuoteDraft`，避免在多个调用点继续平行扩展
  `sourceMessageId/excerpt/anchor` 参数。
- `MessageThread -> Message -> ReplyQuote` 只下传一个 `onRevealReplyQuote(quote)` callback。
- Composer 使用同一个 live callback；pending user message 也使用它。
- 编辑态不传 callback，引用保持静态。
- 移动端不得再让引用 wrapper 启动用户气泡长按 timer；长按操作只属于实际用户气泡，引用按钮
  的 tap/keyboard activation 专门用于来源跳转。
- source root 找不到时显示现有英文提示 `The quoted reply is no longer available.`，并保持页面状态。

share 装配：

- 为 SharePage 的实际 `overflow-y-auto` 容器增加 ref 和稳定语义 marker。
- SharedThread 把当前消息 array index 传给 SharedMessageView。
- Assistant Markdown root 用 `data-reply-quote-share-index` 注册；user reply quote 只按 snapshot-local
  `source_message_index` 查找。
- SharePage 使用相同导航模块，不新增登录依赖、私有接口、Composer 或 mutation action。

## 主要改动文件

| 文件 | 职责 |
| --- | --- |
| `alembic/versions/20260905_0022_add_reply_quote_source_anchor.py` | 新增三列 nullable anchor tuple 与 check constraint |
| `app/models/conversation.py` | Message 锚点列 |
| `app/schemas/conversations.py` | live request/response 的版本化 anchor schema |
| `app/schemas/shares.py` | share-local source index 和 anchor |
| `app/services/conversations/service.py` | 解析、持久化、响应和编辑继承；模型输入继续忽略 anchor |
| `app/services/shares/service.py` | snapshot-local message index 映射，禁止 ID 外泄 |
| `frontend/src/api/types.ts` | ReplyQuoteSourceAnchor 与 live/share DTO |
| `frontend/src/conversations/replyQuoteDraftStore.ts` | 兼容读取旧草稿并持久化 anchor |
| `frontend/src/messages/markdown/rehypeReplyQuoteAnchors.ts` | 将 AST source position 投影成安全 DOM anchor |
| `frontend/src/messages/Markdown.tsx` | final/share opt-in anchor plugin |
| `frontend/src/messages/markdown/MarkdownLink.tsx` | 在自定义 link renderer 上保留 anchor |
| `frontend/src/messages/markdown/CodeBlock.tsx` | 把 pre/code anchor 投影到实际代码 surface |
| `frontend/src/messages/markdown/TableBlock.tsx` | 把 table anchor 投影到实际表格 surface |
| `frontend/src/messages/replyQuoteSourceNavigation.ts` | 捕获、恢复、兼容、滚动、标注和 cleanup 深模块 |
| `frontend/src/messages/useReplyQuoteSelection.ts` | candidate 增加 sourceAnchor |
| `frontend/src/messages/ReplyQuote.tsx` | composer/message clickable 与 static 两种语义 |
| `frontend/src/messages/Message.tsx` | sent/pending reveal 接线，编辑态保持静态，移动触摸隔离 |
| `frontend/src/messages/MessageThread.tsx` | 完整 quote callback 与 sent/pending 接线 |
| `frontend/src/messages/SharePage.tsx` | share scroll root、来源 index marker 与 reveal 接线 |
| `frontend/src/ui/Composer.tsx` | Composer 引用详情点击回调 |
| `frontend/src/app/AppShell.tsx` | live 来源解析、threadRef 装配与错误反馈 |
| `frontend/src/styles/global.css` | clickable focus、来源标注 token；不得改变既有几何 token |
| `CONTEXT.md`、`docs/architecture/*`、reply quote spec/plan/handover | 同步新领域事实、分享隐私和最终验证结果 |

测试文件在对应阶段列出；不得创建只供测试使用的生产接口。

---

## 阶段 0：冻结 contract 与失败测试清单

### 0.1 文档冲突修订

- [ ] 在 `docs/specs/2026-08-31-reply-quote.md` 增加来源锚点、点击行为和 share-local index。
- [ ] 在 `docs/plans/2026-09-04-reply-quote-ui-parity.md` 顶部链接本计划，并把“无跳转”标为由本计划
      取代；保留其余 UI 基线。
- [ ] 更新 `CONTEXT.md` 的“回复引用”，明确 excerpt 与 source anchor 都是不可变快照，anchor 只
      服务 UI，不提升信任等级。
- [ ] 更新 frontend/overview 架构文档中的草稿形状、Markdown pipeline、share snapshot 和点击行为。
- [ ] 不修改 ADR 0011；在 share handover 说明 array index 不是内部句柄。

### 0.2 测试 fixture 先升级

- [ ] 为前后端 reply quote fixture 增加合法 anchor 常量。
- [ ] 同时保留一组 anchor 缺失的 legacy fixture。
- [ ] 分享 fixture 必须只使用 `source_message_index`，不得为方便测试塞入 message id。
- [ ] 新增重复 phrase、普通段落局部选择、嵌套 `p > strong` 同范围和跨段选择样本。

### 完成门

- 新 contract、legacy contract 和不可解析 contract 在测试命名中明确区分。
- 新增测试在生产实现前因缺失字段、无按钮或无滚动/标注而失败，不因 fixture 初始化错误失败。

---

## 阶段 1：Markdown 锚点与导航深模块（纯前端内核）

### 1.1 锚点 plugin 测试

新增 `frontend/src/messages/markdown/rehypeReplyQuoteAnchors.test.tsx` 或通过现有
`Markdown.test.tsx` 的生产 Interface 覆盖：

- [ ] 普通段落得到准确 start/end。
- [ ] `**good enough to trust**` 的范围包含四个 Markdown delimiter。
- [ ] 同范围 `p > strong` 两个节点均存在 marker，DOM 顺序为 p 在前。
- [ ] 同一段内两个相同 strong 文本拥有不同 start/end。
- [ ] 链接、代码、表格和 math 至少有一个可恢复语义祖先。
- [ ] citation/button、复制按钮、HTML iframe 和 `aria-hidden` 生成文本没有独立可选 anchor。
- [ ] streaming Markdown 不输出稳定 anchor，final 与 share 输出一致。
- [ ] plugin 不改变 textContent、HTML 可见内容或 Markdown 快照。

### 1.2 导航模块测试

新增 `frontend/src/messages/replyQuoteSourceNavigation.test.ts`：

- [ ] capture 使用 Range 文档起点，反向 selection 结果相同。
- [ ] 无效数字、跨 root 和无 marker 返回 null。
- [ ] start/end 唯一时恢复正确节点。
- [ ] p/strong 同范围时恢复 DOM 顺序第一项 p。
- [ ] 重复 excerpt 不参与新锚点主路径，命中第二个 strong。
- [ ] scrollTop 计算使用 scroll root rect 和 70/20svh/200 clamp，并限制在合法范围。
- [ ] 原生 `scrollend` 与 RAF fallback 都只触发一次标注；900ms timeout 可结束卡住的滚动。
- [ ] fake timers 验证 2 秒保持、1 秒淡出、样式恢复和 cancel cleanup。
- [ ] reduced motion 使用 auto scroll、无 fade，并仍恢复样式。
- [ ] 相同节点重复点击重启；不同节点 timer 互不覆盖。
- [ ] legacy whitespace-normalized 唯一命中可恢复；零次/多次不猜测节点。
- [ ] reveal 不改变 `location.href`、activeElement 或 Selection。

### 1.3 实现

- [ ] 实现 anchor plugin 并接入 final/share Markdown。
- [ ] 更新三个 custom Markdown renderer 保留 anchor。
- [ ] 实现导航深模块，测试只经过其两个公开 Interface。
- [ ] 不导出 selector、timer 常量、RAF 状态或内部 normalization helper。

### 完成门

- 阶段 1 全部单元测试通过。
- 现有 Markdown rendering、citation、KaTeX、代码和表格测试无回归。
- 生产模块删除测试后，复杂性会重新散落到 live/share 两处，证明该模块具有实际 Depth 和 Locality。

---

## 阶段 2：后端持久化与 live contract

### 2.1 先写失败测试

更新：

- `tests/schemas/test_conversation_schemas.py`
- `tests/services/conversations/test_service.py`
- `tests/services/conversations/test_regenerate.py`
- `tests/api/test_conversations.py`
- `frontend/src/api/conversations.test.ts`

覆盖：

- [ ] 合法 anchor request 接受并完整响应。
- [ ] start/end 边界、未知 version、额外字段和 `end <= start` 返回 422。
- [ ] request 缺失 anchor 继续接受，兼容旧客户端。
- [ ] submit 持久化三列，但 Run model input/transcript 只包含 excerpt，不包含 anchor 数值或字段名。
- [ ] response 对 legacy 行返回 null。
- [ ] 编辑并重新生成继承原 anchor，不允许客户端替换。
- [ ] regenerate existing user message 继续使用原 quote，anchor 不参与模型输入。
- [ ] 来源 `SET NULL` 后 response 保留 excerpt/anchor，但 source message id 为 null。
- [ ] 新 DB constraint 接受三列全空或完整合法 tuple，拒绝半 tuple。

### 2.2 migration 与实现

- [ ] 创建 `20260905_0022` migration，`down_revision="20260831_0021"`。
- [ ] 更新 ORM 和 check constraint 名称，遵守既有命名 convention。
- [ ] 增加 Pydantic anchor schema 与 request/response 字段。
- [ ] `_resolve_reply_quote` 返回规范化 excerpt、合法来源和 anchor；不要在 API route 复制逻辑。
- [ ] submit 建立 Message 时写入三列。
- [ ] `message_response()` 只在 tuple 完整合法时组装 anchor，否则按 null 防御性降级。
- [ ] edit-and-regenerate 在归档旧分支前复制三列 scalar；继续按 source id 显式 `session.get()`，不得
      重新引入已修复的 async lazy-load 500。

### 2.3 migration 往返

在显式测试数据库执行：

```bash
uv run alembic upgrade head
uv run alembic downgrade 20260831_0021
uv run alembic upgrade head
```

### 完成门

- migration upgrade/downgrade/upgrade 成功。
- schema、service、API 和前端 wire 测试全部通过。
- 普通消息与 legacy reply quote payload 字节形状保持兼容。

---

## 阶段 3：选择、草稿、pending 与发送闭环

### 3.1 Selection candidate

更新 `MessageThread.test.tsx`：

- [ ] 选择普通段落局部文字时 callback 的 excerpt 仍是局部文字，anchor 是完整 p 范围。
- [ ] 选择 strong 时保存 strong 范围；p/strong 同范围允许恢复端选择外层 p。
- [ ] 跨段选择保存完整 excerpt，但 anchor 来自 Range 文档起点的第一个段落。
- [ ] 从后向前拖动得到相同 anchor。
- [ ] 100ms settle 期间 Selection 节点或 anchor 改变会取消旧候选。
- [ ] 无 anchor 的支持外内容仍可创建 excerpt-only legacy-compatible quote。

实现：

- [ ] `ReplyQuoteSelectionCandidate` 增加 `sourceAnchor`。
- [ ] `evaluate()` 调用导航模块 capture Interface。
- [ ] `onReplyQuote` 改为接收完整 `ReplyQuoteDraft`，不扩展第三个平行 scalar 参数。
- [ ] 4,000 Unicode 字符限制继续只约束 excerpt，不按 Markdown node 范围长度误拒绝。

### 3.2 草稿与 pending

更新 `replyQuoteDraftStore.test.ts`、`store.test.ts`、`useSendMessage.test.tsx` 和 AppShell 测试：

- [ ] localStorage round-trip 保留 anchor。
- [ ] 旧 `{source_message_id, excerpt}` 草稿仍可读取并得到 null anchor。
- [ ] invalid anchor 不应删除整个可读 excerpt 草稿；按 null anchor 降级并重写时使用合法形状。
- [ ] logout、auth expiry、身份切换、会话删除的既有清理路径继续删除完整草稿。
- [ ] pending、HTTP 请求、server materialized 接管和失败恢复不丢 anchor。
- [ ] quote-only send 继续可用。

### 完成门

- 从原生选区到请求 body 的 anchor 不丢失、不重新计算。
- pending 和服务端接管使用同一个 render key 时引用按钮不闪退或失去 focus 语义。

---

## 阶段 4：Composer、sent/pending 与 live 来源导航

### 4.1 ReplyQuote 组件测试

更新 `ReplyQuote.tsx` 对应的 Message/Composer 测试：

- [ ] message 有 `onReveal` 时根节点为 button，完整 excerpt 未截断且三行 clamp 仍在文本节点上。
- [ ] message 无 `onReveal` 时没有 button、tab stop 或误导 hover。
- [ ] Composer 引用文字和取消引用是两个 sibling button，不存在嵌套 button。
- [ ] Composer 详情按钮可访问名称为“有关回复内容的详情”。
- [ ] 点击详情只调用 reveal，不调用 remove、不修改 prompt/attachment。
- [ ] Enter/Space 激活；focus-visible 存在。
- [ ] 编辑态引用保持静态。

### 4.2 AppShell 装配

- [ ] 基于 `threadRef` 实现唯一 live reveal callback。
- [ ] 通过 `CSS.escape(source_message_id)` 或严格 UUID selector 找到唯一 source root；不得拼接未校验
      任意 selector。
- [ ] Composer、server message 和 pending message 共用 callback。
- [ ] source root 缺失时显示现有英文 toast，不能把 excerpt 当成跨消息搜索键。
- [ ] 会话切换、logout 和 AppShell unmount 清理尚未结束的 scroll/highlight handle。
- [ ] 程序化向上导航后 `useStickToBottom` 保持 unpinned；新增回归证明 streaming delta 不拉回底部。
- [ ] quote button 的触摸事件不启动 mobile user action sheet；用户气泡长按继续工作。

### 完成门

- Composer、sent 和 pending 三个入口都能命中同一 source root/anchor。
- URL、Composer draft、附件、引用本身和消息顺序不变。
- 既有引用几何测试无需修改期望值，除 DOM tag/交互语义断言外不更新截图。

---

## 阶段 5：公开分享来源映射与交互

### 5.1 后端分享测试

更新 `tests/services/shares/test_share_service.py` 与 `tests/api/test_shares.py`：

- [ ] snapshot 将来源映射为正确的先前 Assistant array index。
- [ ] response 包含 excerpt、source index 和 anchor。
- [ ] snapshot/public response 递归断言不含 `source_message_id`、任意 message id、run id、数据库
      position 或 user id。
- [ ] 来源不在快照、不是 Assistant、位于 user message 之后或关系为空时 index 为 null。
- [ ] legacy anchor 为空时 index 仍可写，供消息级跳转/唯一文本兼容。
- [ ] 旧 snapshot 只有 excerpt 时仍能通过 schema 读取。
- [ ] 后续 live 编辑不改变已经生成的 source index/anchor snapshot。
- [ ] 附件 `ref` 和匿名读取授权测试保持不变；quote source index 不得被附件 read endpoint 接受。

### 5.2 SharePage 测试与实现

- [ ] public scroll root 有 ref 和稳定测试 marker。
- [ ] Assistant root 使用 array index marker，不出现 live message id。
- [ ] 有 index 的引用是 button；无 index 的历史分享保持静态。
- [ ] exact anchor 路径调用共享导航模块。
- [ ] anchor 缺失但 excerpt 在来源中唯一时使用 legacy fallback。
- [ ] 重复/找不到 excerpt 时只滚动消息，不错误标黄。
- [ ] live/share 相同 fixture 的按钮、scroll offset、颜色、时序和 cleanup 一致。

### 完成门

- 匿名 share 不依赖 auth、AppShell 或私有 conversation API。
- 公开 payload 与 DOM 都不包含内部来源标识。
- 撤销、过期和无效 share 的现有 404 行为无变化。

---

## 阶段 6：真实 Chrome 交互验收

扩展 `frontend/tests/visual/thread-bottom.visual.ts` 和
`frontend/tests/visual/assistant-rendering.visual.ts`，优先使用生产 AppShell/SharePage fixture。

### 6.1 live 三个锚点样本

- [ ] 普通段落包含“更自然地翻译就是：”，只选择“自然地”并创建 quote。
- [ ] 点击 Composer 详情，断言滚动后整个 p 标黄、excerpt 仍只有“自然地”。
- [ ] 发送该 quote，点击用户消息引用，断言同一 p 再次标黄。
- [ ] 单个来源消息包含至少两处 `good enough to trust`；选择第二处 strong，发送后点击必须标黄
      第二处，第一处计算背景保持透明。
- [ ] 跨两个段落选择，点击后只标黄文档顺序起点段落。

### 6.2 行为与时序

- [ ] mouse click 与键盘 Enter 都可触发。
- [ ] 点击前后记录 `location.href`、activeElement、Composer value、attachment ids 和 quote，全部不变。
- [ ] 目标落在 scrollport 顶部 70–200px context offset 范围内，且完整可见。
- [ ] 标注不会在滚动仍移动时提前出现。
- [ ] 出现后计算背景为 `rgba(255, 235, 140, 0.6)`；2 秒内保持；随后约 1 秒淡出。
- [ ] reduced motion 无 smooth/fade，但立即定位并保留 2 秒可见标注。
- [ ] 点击后向上导航期间新 streaming delta 不把 scrollport 拉回底部。
- [ ] route change/unmount 后无残留 inline style、timer 或 console error。

### 6.3 share parity

- [ ] 用同一个快照 fixture 在 live/share 点击相同 anchor，比较目标 tag、start/end、scroll offset、
      highlight color 和时序。
- [ ] 分享页不出现 Composer、编辑、重新生成、私有消息 ID 或 owner-only请求。
- [ ] 历史 share fixture 的 excerpt 保持静态且可读。

### 6.4 几何回归

- [ ] 引用按钮改 tag 后宽度、高度、margin、gap、line-height、三行 clamp 和 SVG rect 与现有 golden
      一致。
- [ ] Composer 有/无引用的总高度与已有基线误差不超过 1px。
- [ ] desktop 1440×900、mobile 390×844 均无横向 overflow。
- [ ] 只为来源标黄状态保存独立截图 artifact，不覆盖无关 assistant rendering golden。

### 完成门

- desktop-chrome 与 mobile-chrome 定向项目通过。
- 测试 artifact 包含 source/target start-end、scroll timeline、highlight timeline、focus/URL 和
  live/share 对照 JSON。
- 人工检查局部段落、重复文本和跨段三个截图。

---

## 阶段 7：完整验证

### 后端定向测试

```bash
uv run pytest -q \
  tests/schemas/test_conversation_schemas.py \
  tests/api/test_conversations.py \
  tests/api/test_shares.py \
  tests/services/conversations/test_service.py \
  tests/services/conversations/test_regenerate.py \
  tests/services/shares/test_share_service.py
```

### 前端定向测试

```bash
cd frontend
pnpm exec vitest run \
  src/api/conversations.test.ts \
  src/conversations/replyQuoteDraftStore.test.ts \
  src/conversations/useSendMessage.test.tsx \
  src/messages/Markdown.test.tsx \
  src/messages/replyQuoteSourceNavigation.test.ts \
  src/messages/MessageThread.test.tsx \
  src/messages/Message.test.tsx \
  src/messages/SharePage.test.tsx \
  src/ui/Composer.test.tsx \
  src/app/AppShell.test.tsx
```

### 真实浏览器定向测试

```bash
cd frontend
pnpm exec playwright test tests/visual/thread-bottom.visual.ts --project=desktop-chrome
pnpm exec playwright test tests/visual/thread-bottom.visual.ts --project=mobile-chrome
pnpm exec playwright test tests/visual/assistant-rendering.visual.ts --project=desktop-chrome
pnpm exec playwright test tests/visual/assistant-rendering.visual.ts --project=mobile-chrome
```

### 全量质量门

```bash
uv run ruff check .
uv run mypy app
uv run pytest

cd frontend
pnpm run lint
pnpm run typecheck
pnpm exec vitest run
pnpm run build
pnpm exec playwright test
```

### 工作区检查

```bash
git diff --check
git status --short
```

### 完成门

- 所有定向测试、lint、typecheck、build 和 migration 往返通过。
- 全量测试通过；若存在与本次无关且可由基线稳定复现的失败，交接中记录完整命令、错误、基线证据
  和剩余风险，不能只写“环境问题”。
- 工作区没有 Playwright 临时输出、意外截图、第二个 lockfile 或未说明的生成物。
- 不修改 `pnpm-lock.yaml`，本计划不需要新增依赖。

## 验收追踪矩阵

| 验收项 | 数据/单元证据 | 组件/浏览器证据 |
| --- | --- | --- |
| Composer 引用可点击 | draft 保留 anchor | 详情与移除为 sibling button；点击定位并标黄 |
| sent/pending 可点击 | pending/request/response anchor 一致 | 同一 ReplyQuote 原语与 live callback |
| 重复文字准确定位 | anchor 不依赖 excerpt search | 第二处 strong 标黄，第一处透明 |
| 局部文字标注语义节点 | excerpt 与 node range 分开保存 | “自然地”引用标黄完整 p |
| 跨段只标注起点 | Range.startContainer anchor | 第一段标黄，后续段不标黄 |
| 滚动后再标注 | scrollend/RAF 单测 | timeline 证明移动中无黄色 |
| 2 秒保持 + 1 秒淡出 | fake timers 与 style restore | computed background timeline |
| focus/URL 不变 | navigation Interface 单测 | keyboard/mouse E2E |
| share 与 live 一致 | snapshot index + anchor | 相同 fixture 的滚动/标注对照 |
| share 不泄露 ID | recursive payload assertion | DOM/network 无私有句柄 |
| legacy 安全降级 | null anchor/old snapshot tests | 唯一命中才标黄，歧义不猜测 |
| UI 几何不变 | class/DOM structure tests | desktop/mobile rect 与 golden |

## 风险与防护

### Markdown renderer 改动使锚点漂移

风险：parser/plugin 顺序或 math normalization 改变后，同一 offset 不再对应原语义节点。

防护：anchor 带显式 version；恢复失败进入 legacy/消息级降级，不全局搜索；Markdown pipeline 测试
冻结普通、strong、code、table、math 和 citation 的 position；未来改变坐标语义时新增 version。

### excerpt 重复导致误标注

风险：只用 `indexOf(excerpt)` 会命中同一回复中的错误出现位置。

防护：新数据只走 anchor；legacy 搜索限定在已解析来源消息且必须唯一，多次出现时只做消息级滚动。

### inline style 污染 Markdown

风险：临时 background/transition 覆盖 renderer 原样式，或 route change 后残留。

防护：导航模块保存并恢复两个属性原值，所有 timer/RAF/listener 收敛在 reveal handle；同目标重启、
unmount 和 route change 均有测试。

### programmatic scroll 与 sticky bottom 冲突

风险：来源跳转后 streaming delta 或 force key 把用户拉回最新消息。

防护：导航直接操作现有 scroll root，让向上 scroll 进入 `useStickToBottom` 的 unpinned 状态；单独回归
active stream delta。来源点击本身不得改变 force key。

### 移动端长按冲突

风险：全宽引用 button 的 touch 冒泡同时启动用户消息 action sheet。

防护：引用不再挂 user-bubble long-press handlers；仅实际气泡拥有该手势，并在 mobile Chrome 同时
验证 tap、long-press 和 contextmenu。

### 分享隐私扩张

风险：为了找来源直接把 live message id 塞进公开快照，破坏既有分享 contract。

防护：只保存 snapshot-local array index；service 和 API 测试递归拒绝任何消息 ID/position；既有
snapshot 不回填。若 array-local 引用不足，停止实施并重新评审，不能退回暴露 ID。

### 部署期间新旧客户端交叉

风险：旧 API 不认识新字段，或新前端读取 legacy null 时崩溃。

防护：先部署 nullable migration + 接受 optional anchor 的后端，再部署前端；新前端对缺失/null 完整
降级。回滚前端时后端继续接受无 anchor 请求。

## 部署顺序

1. 备份 PostgreSQL，在 staging 执行 `0022` upgrade/downgrade/upgrade。
2. 部署 migration + 兼容 API/Worker；request anchor 仍 optional。
3. smoke 普通消息、legacy 引用、带 anchor 引用、quote-only、编辑继承、来源删除和新分享。
4. 部署前端 Markdown anchors、导航模块和 clickable UI。
5. 在真实 desktop/mobile Chrome 执行 Composer、重复 phrase、跨段、pending、恢复草稿和 share。
6. 观察 422、500、share snapshot parse、前端 source unavailable toast 和浏览器 console error。
7. 验证稳定后再把 handover 状态更新为已实施；不要在完成测试前勾选本计划 Definition of Done。

## 回滚策略

1. UI 紧急回滚：移除 `onReveal` 接线，`ReplyQuote` 回到静态渲染；保留 anchor 数据读取和展示兼容。
2. 前端完整回滚：旧前端会忽略 response 中新增字段；后端继续接受缺失 anchor。
3. 后端回滚版本必须继续容忍数据库三列；不要先 downgrade migration。
4. 分享回滚只停止在新 snapshot 写 index/anchor；已经生成的 snapshot 新字段由旧 schema 忽略，
   excerpt 和附件读取保持可用。
5. 只有确认生产不存在非空 anchor 数据且已备份/处置后，才能 downgrade `0022` 删除三列。
6. 任何回滚都不得删除 excerpt、把 excerpt 写进 message content，或回到不认识 quote-only user turn
   的版本。

## Definition of Done

- [x] ChatGPT 参考行为、锚点粒度和点击时间线已由真实 Chrome 测试固化。
- [x] final/share Markdown 输出稳定、版本化 source anchor，streaming 不输出伪稳定锚点。
- [x] 来源 anchor 完成 selection → draft → pending → request → DB → response → edit inheritance 闭环。
- [x] anchor 不进入模型输入、Run transcript、搜索 query 或授权逻辑。
- [x] Composer 详情与移除均可独立键盘操作。
- [x] live sent/pending 点击准确恢复来源；重复 excerpt 不误命中。
- [x] 普通局部选择标黄完整语义节点，跨段只标黄起点节点。
- [x] 滚动结束后标黄约 2 秒并用 1 秒淡出；reduced motion 行为可用。
- [x] 点击不改变 URL、focus、Composer、附件、消息或当前引用状态。
- [x] public share 使用 array-local source index，行为与 live 一致且不暴露任何 message id/position。
- [x] legacy live、新建 legacy share 和既有 immutable share 按冻结规则安全降级。
- [x] 现有引用 UI 几何、三行 clamp、颜色、hover、Composer 背景和 SVG 没有回归。
- [x] migration 往返、后端定向、前端定向、desktop/mobile Chrome、lint、typecheck 和 build 全部通过。
- [x] specs、CONTEXT、architecture、原 UI 计划和 handover 已同步，最终交接记录真实命令与结果。
