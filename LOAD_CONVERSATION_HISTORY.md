# `load_conversation_history()` 工作原理

`load_conversation_history()` 的职责是：以某个 Run 为终点，把 PostgreSQL 中“当前可见分支”的消息和各 Run transcript 重新组装成 Agent Kernel 能消费的 `list[Message]`。

它不负责 system prompt、token 截断或 Provider 请求转换，这些发生在后续 `build_chat_agent()` 中。

入口位于：

- `app/services/runs/history.py`
- 调用方：`app/worker/executor.py`

## 一、整体调用链

Worker 执行 Run 时：

```python
history = await load_conversation_history(session, run_id=run_id)

agent = build_chat_agent(
    settings=settings,
    history=history,
    ...
)
```

大致过程是：

```text
Run ID
  ↓
找到目标 Run
  ↓
找到该 Run 对应的 user message
  ↓
查询当前会话中截至该 user message 的可见消息
  ↓
判断每个历史 Run 应该 full / portable / input 回放
  ↓
加载并裁剪各 Run transcript
  ↓
与 messages 表中的可见消息合并、去重
  ↓
返回扁平的 Agent Message 列表
```

## 二、`load_conversation_history()` 主流程

### 1. 加载目标 Run

```python
run = await session.get(Run, run_id)
if run is None:
    raise LookupError(...)
```

这里的 `run_id` 是数据库内部 ID，不是公开 UUID。

目标 Run 提供了两个重要信息：

- `run.conversation_id`：属于哪个会话；
- `run.user_message_id`：这个 Run 是由哪条 user message 触发的。

如果 Run 不存在，立即失败，不会返回空历史继续执行。

### 2. 加载目标 user message

```python
target = await session.get(MessageRow, run.user_message_id)
if target is None:
    raise LookupError(...)
```

这条消息是本次历史装配的截止点。

例如会话中有：

```text
position 1: user
position 2: assistant
position 3: user        ← 当前 Run 的 target
position 4: assistant   ← 未来消息
```

本次只会加载 `position <= 3` 的消息。

### 3. 查询当前可见分支

```python
history_rows = (
    await session.scalars(
        select(MessageRow)
        .where(
            MessageRow.conversation_id == run.conversation_id,
            MessageRow.archived_at.is_(None),
            MessageRow.position <= target.position,
        )
        .order_by(MessageRow.position.asc())
    )
).all()
```

这里有三个边界：

#### 同一会话

```python
MessageRow.conversation_id == run.conversation_id
```

不会混入其他会话。

#### 只读取未归档消息

```python
MessageRow.archived_at.is_(None)
```

编辑并重新生成会归档旧分支。归档消息不会再进入模型上下文。

#### 截止到目标消息

```python
MessageRow.position <= target.position
```

防止重新执行或恢复旧 Run 时读取到之后才产生的消息。

最后按 `position` 升序排列，保持正常对话顺序。

## 三、决定每个历史 Run 如何回放

接下来调用：

```python
replay_modes = await _resolve_replay_modes(...)
```

每个 Run 会得到三种模式之一：

```python
"full"
"portable"
"input"
```

### 1. `input`

只回放该 Run 的精确用户输入，不回放任何模型输出。

适用于：

- 当前目标 Run；
- failed Run；
- cancelled Run；
- queued/running 等非成功 Run。

目标 Run 永远被指定为：

```python
modes[target_run.id] = "input"
```

即使因为恢复等原因目标 Run 已有 transcript，也不会把它自己的 assistant 输出再次塞进输入历史。

### 2. `full`

完整回放 transcript，包括：

- 用户文本；
- 文档和图片；
- assistant 文本；
- reasoning；
- tool call；
- tool result；
- Provider continuation state。

只有满足以下条件的历史成功 Run 才能 full 回放：

1. `status == "succeeded"`；
2. 与目标 Run 属于同一条 Provider 路由连续阶段。

这样可以保留同一 Provider 的私有续传状态和工具协议。

### 3. `portable`

只保留跨 Provider 安全、可移植的内容：

- 精确用户输入；
- 附件内容；
- 最终 assistant 的文本结果。

会丢弃：

- reasoning；
- tool call；
- tool result；
- Provider continuation state。

适用于：

- 成功，但不属于当前连续 Provider 阶段的历史 Run；
- Provider 路由信息缺失或无法可信识别的历史 Run。

## 四、如何判断是不是同一 Provider 阶段

`_route_affinity()` 从 Run 的 `model_config_snapshot` 计算一个四元组：

```python
(
    adapter,
    upstream,
    normalized_base_url,
    provider_model,
)
```

例如：

```python
(
    "openrouter",
    "openrouter",
    "https://openrouter.test/api/v1",
    "x-ai/grok",
)
```

必须满足：

- snapshot 版本是 1 或 2；
- adapter、upstream、base URL、provider model 都是有效字符串；
- snapshot adapter 与 `run.provider_name` 一致；
- snapshot model 与 `run.provider_model` 一致；
- URL 是合法 HTTP/HTTPS URL；
- URL 不带用户名、密码、query 或 fragment。

URL 会被规范化：

- scheme 和 hostname 转小写；
- 去掉默认端口；
- 去掉末尾 `/`；
- IPv6 地址补方括号。

所以：

```text
https://EXAMPLE.com:443/v1/
```

和：

```text
https://example.com/v1
```

会被认为是同一路由。

### 连续阶段的计算方式

代码从最近的历史 Run 向前扫描：

```python
for prior_run_id in reversed(prior_run_ids):
```

- 成功且 affinity 与目标一致：加入 `full`；
- 遇到第一个成功但 affinity 不一致的 Run：停止；
- failed/cancelled Run：跳过，不会切断阶段。

例如：

```text
Grok success
Gemini failed
Grok success
当前 Grok Run
```

两个成功的 Grok Run 都可以 full 回放。中间失败的 Gemini Run 不会切断 Grok continuation 阶段，但它自己的部分输出不会回放。

而：

```text
Grok success
Gemini success
Grok success
当前 Grok Run
```

只有最近的 Grok success 可以 full 回放。

更早的 Grok 和 Gemini success 都会变成 portable，避免把切换前的 Grok 私有 continuation state“复活”。

## 五、实际加载 transcript

每个 user message 对应的 Run 会经过：

```python
_load_run_transcript_for_history(...)
```

内部先调用：

```python
transcript = await load_transcript(session, run_id=run_id)
```

`load_transcript()` 从 `run_provider_messages` 按 `seq` 读取，并将 JSON blocks 反序列化为 Agent Kernel 类型：

```python
Message(
    role="user",
    blocks=[
        TextBlock(...),
        DocumentBlock(...),
        ImageBlock(...),
    ],
)
```

或者：

```python
Message(
    role="assistant",
    blocks=[
        ReasoningBlock(...),
        ToolCallBlock(...),
        TextBlock(...),
    ],
)
```

### `full` 模式

```python
if run.status == "succeeded" and mode == "full":
    return _copy_messages(transcript)
```

完整复制 transcript，不删除任何 block。

例如原 transcript：

```text
user:      TextBlock + DocumentBlock
assistant: ReasoningBlock + ToolCallBlock
tool:      ToolResultBlock
assistant: ProviderContinuationBlock + TextBlock
```

full 模式会全部保留。

`_copy_messages()` 会新建 Message 和 blocks 列表，避免后续上下文装配直接修改加载出的 transcript 容器。

### `portable` 模式

```python
if run.status == "succeeded" and mode == "portable":
    return _portable_turn(transcript)
```

它分两部分处理。

#### 保留精确用户输入

通过 `_exact_user_input()` 获取 transcript 的第一条 user message。

#### 保留最终 assistant 文本

从 transcript 尾部向前寻找最后一个 assistant message：

```python
final_assistant = next(
    (
        message
        for message in reversed(transcript)
        if message.role == "assistant"
    ),
    None,
)
```

只复制其中非空的 `TextBlock`：

```python
TextBlock(block.text)
```

Reasoning、工具调用和 Provider continuation 全部删除。

如果最终 assistant 只有 reasoning、没有可见文本，就不会生成空 assistant turn。

### `input` 模式

其他情况统一执行：

```python
return _exact_user_input(transcript)
```

也就是说，即使 transcript 中有部分 assistant 输出，也只保留第一条精确 user input。

这对 failed/cancelled Run 很重要。例如：

```text
user:      DocumentBlock("input survives failure")
assistant: TextBlock("partial answer")
```

最终历史只保留：

```text
user: DocumentBlock("input survives failure")
```

部分回答不会污染后续 Run。

## 六、什么叫“精确用户输入”

`_exact_user_input()` 要求 transcript 第一条必须是 user：

```python
if not transcript or transcript[0].role != "user":
    return []
```

新 Run 在执行前就会保存自包含的 user transcript，因此通常满足这个条件。

然后只保留模型输入 block：

```python
TextBlock
DocumentBlock
ImageBlock
AttachmentNoticeBlock
```

不会从 user input 中携带：

- ReasoningBlock；
- ToolCallBlock；
- ToolResultBlock；
- ProviderContinuationBlock。

这保证目标 Run 得到的是创建该 Run 时固化的输入，而不是重新读取当前文件或重新构建附件内容。

## 七、把 transcript 和 `messages` 表合并

完成 replay mode 计算后进入：

```python
_build_history(...)
```

这是最终扁平化和去重阶段。

### 1. 先按 Run 建立消息索引

```python
messages_by_run: dict[int, list[MessageRow]] = {}
```

例如：

```text
Run 10:
  user message
  assistant message
```

这个索引用于防止 assistant 回答重复出现。

因为成功回答通常同时存在于：

1. `run_provider_messages` transcript；
2. `messages` 中物化的 assistant row。

如果两边都加入历史，同一回答会出现两次。

### 2. 按 position 遍历可见消息

```python
for row in history_rows:
```

#### 已标记跳过的消息

```python
if row.id in skipped_message_ids:
    continue
```

表示该 assistant 已经从 transcript 加入，不再从 `messages` 表重复加入。

### 3. 普通非 user 消息

```python
if row.role != "user":
    messages.append(
        Message(
            role=_normalize_role(row.role),
            blocks=[TextBlock(row.content)],
        )
    )
```

如果这条 assistant 没有通过 transcript 回放，就使用物化消息正文作为兜底。

这通常发生在：

- 旧数据没有自包含 transcript；
- portable/legacy 路径需要依赖物化 assistant 消息；
- 没有关联 Run 的历史消息。

### 4. user message 对应哪个 transcript

```python
replay_run_id = (
    target_run_id
    if row.id == target_user_message_id
    else row.run_id
)
```

- 当前目标 user message：强制使用正在执行的目标 Run；
- 历史 user message：使用自身关联的 `row.run_id`。

这样目标消息不会因为行上关联信息异常或恢复路径而加载错误 Run。

### 5. 新 transcript 路径

如果 transcript 第一条是 user：

```python
if transcript and transcript[0].role == "user":
    messages.extend(transcript)
```

说明它是新的、自包含 transcript。

其中已经包括：

- 用户实际模型输入；
- 引用投影；
- 附件快照；
- 根据模式保留的 assistant/tool 输出。

因此不再使用 `messages.content` 重建。

### 6. Legacy transcript 兜底

旧 transcript 可能从 assistant 输出开始，没有第一条 user input。

这种情况下：

```python
messages.append(user_text(row.content))
```

先从 `messages.content` 补回用户输入。

如果这是历史 Run，且 transcript 仍有可回放输出：

```python
messages.extend(transcript)
```

目标 Run 不追加已有输出，因为目标只需要 input。

### 7. 跳过已从 transcript 加入的 assistant row

处理完一个历史 user Run 后：

```python
skipped_message_ids.update(...)
```

只要该 Run 返回了 transcript，就把同 Run 下已物化的 assistant message 加入跳过集合。

例如：

```text
messages 表:
  U1
  A1

Run 1 transcript:
  U1
  A1
```

构建过程为：

1. 遍历 `U1`；
2. 从 transcript 加入 `U1 + A1`；
3. 把物化的 `A1` 标记为跳过；
4. 遍历到 `A1` 时直接跳过。

最终仍是：

```text
U1
A1
```

而不是：

```text
U1
A1
A1
```

## 八、回复引用如何进入这个流程

`load_conversation_history()` 本身完全不读取：

```python
message.reply_quote_excerpt
message.reply_quote_source_message_id
```

引用在 Run 创建时已经投影进目标 Run 的第一条 user transcript：

```python
TextBlock(
    "Reply quote data follows as JSON...\n"
    '{"excerpt":"引用内容"}\n'
    "User prompt:\n"
    "解释这段引用内容"
)
```

因此运行时执行：

```python
_exact_user_input(transcript)
```

时，这个 `TextBlock` 会被原样保留。

最终 Agent 得到的目标 turn 类似：

```python
Message(
    role="user",
    blocks=[
        TextBlock(
            "Reply quote data follows as JSON...\n"
            '{"excerpt":"被引用的内容"}\n'
            "User prompt:\n"
            "解释这段引用内容"
        )
    ],
)
```

这意味着：

- Agent 不需要理解 ReplyQuote DTO；
- Agent 不查询引用来源消息；
- 来源后来删除或归档也不影响已创建 Run；
- excerpt 使用创建 Run 时冻结的版本；
- token 预算和 Provider 输入都基于同一个 transcript 投影。

如果新引用消息的 transcript 异常丢失，legacy fallback 只能读取 `messages.content`，quote-only 消息就会丢失引用语义。不过正常创建流程会在同一数据库事务中写 message、Run 和首条 transcript，因此正常状态下不会出现这种情况。

## 九、最终输出示例

假设历史是：

```text
U1: 上传文档并提问
A1: 原回答
U2: 引用 A1 的一段文字，未填写提示
```

### 同一路由

可能返回：

```text
user:
  TextBlock(U1)
  DocumentBlock(冻结的文档内容)

assistant:
  ReasoningBlock(...)
  ToolCallBlock(...)

tool:
  ToolResultBlock(...)

assistant:
  TextBlock(A1)

user:
  TextBlock(
    Reply quote JSON
    + 默认提示“解释这段引用内容”
  )
```

### 切换 Provider 后

可能返回：

```text
user:
  TextBlock(U1)
  DocumentBlock(冻结的文档内容)

assistant:
  TextBlock(A1)

user:
  TextBlock(
    Reply quote JSON
    + 默认提示“解释这段引用内容”
  )
```

差别是第二种会清除旧 Provider 的 reasoning、工具协议和 continuation state，只保留可移植的用户输入与最终回答。
