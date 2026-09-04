# iChat

AI 聊天服务：用户通过可配置的聊天模型进行流式对话。单一限界上下文，认证与账户生命周期、会话与运行（Run）编排共处一个领域。

## Language

### 账户与认证

**认证令牌（Auth Token）**:
一次性的、绑定单一用途（purpose）的凭证，通过邮件送达以证明用户对其邮箱的所有权，用于授权某个敏感动作。用途包括：邮箱验证、密码重置、注销确认。
_Avoid_: 验证码、临时密码

**邮箱验证（Email Verification）**:
用户对其当前邮箱所有权的证明。任何在有效期内成功消费的、发往用户当前邮箱的认证令牌都构成一次验证——不限于「验证邮件」这一种用途。
_Avoid_: 邮箱激活

**密码重置（Password Reset）**:
匿名用户凭邮箱所有权（认证令牌）为账户设置新密码的流程，是忘记密码时的自救通道。
_Avoid_: 找回密码（密码不可找回，只能重置）

**改密（Password Change）**:
已登录用户凭当前密码设置新密码的动作。与密码重置是两个不同的动作：改密证明的是「知道旧密码」，重置证明的是「拥有邮箱」。
_Avoid_: 修改密码时与「重置」混用

**注销（Account Deletion）**:
用户主动终止自己账户的动作，需当前密码与邮箱双重确认。生效后账户立即停用；会话、消息和私有消息附件等业务数据的物理清除是后续独立阶段，但公开头像因可被 CDN URL 继续访问而在确认时立即删除并 purge。
_Avoid_: 删号、销户

**停用（Deactivated）**:
账户不可登录、不可访问任何接口的状态。停用不等于数据删除。
_Avoid_: 封禁（封禁是运营处罚，停用是账户生命周期状态）

### 会话与运行

**用户消息（User Message）**:
用户提交的一次对话输入，由提示文字、一个或多个消息附件、回复引用中的一种或多种构成。没有文字时，至少一个附件必须是模型可消费附件，或消息必须包含回复引用；系统不得为了满足该要求而把应用默认行为伪造成用户可见文字。
_Avoid_: 必含文字的消息、任意纯附件消息、由系统补写的用户提示

**回复引用（Reply Quote）**:
用户从当前会话先前已物化的助手消息正文中选择、作为后续用户消息输入的不可变结构化事实。它包含低信任文本快照、来源消息关系和可选来源锚点；来源关系约束会话、角色与顺序，锚点只恢复 UI 位置，不证明文本可信。来源归档后已发送快照保持不变，来源物理删除后关系可以为空。
_Avoid_: Markdown 引用块、网页搜索引用、跨会话引用、可信指令

**回复引用来源锚点（Reply Quote Source Anchor）**:
用户建立回复引用时保存的版本化 Markdown 语义节点范围，使用 final assistant 规范化 Markdown 的 UTF-16 source offset，供 live 与公开分享点击引用时恢复、滚动并标注来源。它不是文本真实性证明，不进入模型输入或 Run transcript。
_Avoid_: DOM 路径、可见文本索引、来源消息标识、可信出处

**删除会话（Conversation Deletion）**:
用户把会话移出正常可见范围并开始三十天恢复期的动作。恢复期结束后，会话、消息、Run 和消息附件不可逆地物理清除并释放附件配额；它不等同于账户注销。
_Avoid_: 无限期软删除、账户注销、立即物理删除

**Run（运行）**:
一次由用户消息触发的后台生成任务：worker 认领（claim）后调用 LLM provider 流式产出回复，全生命周期为 queued → started → streaming → succeeded/failed/cancelled（含 cancelling 过渡态）。Run 行本身也是 PG 任务队列中的状态行。
_Avoid_: 任务、请求（与 HTTP 请求混淆）

**转写（Transcript）**:
一次 run 中业务与 LLM 之间完整通信记录的事实源，持久化在 `run_provider_messages` 表（表名不改）。它按模型调用顺序保存正文、原始推理、推理摘要、工具调用/结果和仅供适配器续传的不透明状态；代码域一律使用 transcript 词根（如 `load_transcript`、`append_transcript_message`）。
_Avoid_: provider message（代码词汇层已废弃）、聊天记录（那是面向用户的 messages）

**草稿检查点（Draft Checkpoint）**:
`run_drafts` 中每个活跃 Run 至多一行的累计正文、原始推理和推理摘要快照。它是 Redis Stream 故障时的粗粒度恢复面，不是完整事件历史；由时间窗、待写字符上限或工具边界触发 upsert，终态后删除。
_Avoid_: draft event（它是覆盖式快照）、assistant message（成功终态才物化）

**Run Stream**:
Redis key `run:{internal_run_id}:events` 上按 Run 隔离的短期事件流，承载逐 chunk delta 和语义事件的低延迟 SSE 传输；entry 与 PG 事件共享整数 seq。Redis 不是事实源，读取失败时退回 PG 语义事件 + 草稿检查点。
_Avoid_: 任务队列（claim 仍在 PG）、永久事件日志

**唤醒信号（Wakeup Hint）**:
业务事务 commit 成功后向 Redis `runs_queued` 发布的可丢失提示，只用于让 Worker 提前执行下一次 PG claim。重复、乱序或丢失都不影响所有权与最终执行，`worker_poll_interval_seconds` 负责兜底。
_Avoid_: 入队消息、claim token、所有权信号

**取消信号（Cancel Hint）**:
取消请求 commit（run 置 `cancelling`）成功后向 Redis `run_cancel` 发布的可丢失提示，让正在执行该 run 的 Worker 立即中断，无需等待心跳轮询。Worker 按 run_id 路由到对应执行的 cancel event；未注册或丢失的信号由 PG `cancelling` 状态 + 心跳轮询兜底。
_Avoid_: 终止命令（PG 状态才是事实源）、所有权信号

**agent 内核（Agent Kernel）**:
`app/agent/` 包——provider 中立、不读数据库、不碰传输层、不含业务组装的 agent building blocks：Message/内容块词汇、Provider 协议与适配器、Tool 协议与注册表、单次模型调用与工具执行原语、AgentEvent 事件词汇。agent 循环与业务装配归编排层（`app/services/agents`），工程化（seq、发布、持久化、重试执行、取消）归 worker。
_Avoid_: agent 框架（明确不做图编排/chain/多 agent）、编排核心（编排在内核之外）

**模型调用（Model Call）**:
agent 循环内对 LLM provider 的一次流式请求-响应。一个 run 可含多次模型调用（工具循环）。与「轮（Turn）」区分：turn 专指用户↔助手的一轮对话交换（历史裁剪的计量单位），不用于指代单次 provider 调用。
_Avoid_: turn（指 provider 调用时）、请求（与 HTTP 请求混淆）

**聊天模型（Chat Model）**:
用户可选择的稳定逻辑模型，拥有展示名称与思考、图像输入等模型级能力；它不等同于任一第三方接口中的 model id，同一聊天模型可以通过多个模型路由执行。
_Avoid_: provider model、上游 model id、供应商

**模型上游（Model Upstream）**:
一个可调用的第三方入口，由稳定名称、endpoint、加密凭据与 provider 适配器类型共同标识；同一模型上游可以承载多个聊天模型。
_Avoid_: 聊天模型、provider 适配器、API key

**模型路由（Model Route）**:
聊天模型到模型上游的一条可启停执行路径，记录该上游使用的 model id、优先级与可见推理输出能力；Run 创建时只选择一条路由并固化非敏感配置快照。
_Avoid_: 自动重试、模型上游、负载均衡

**Provider 适配器（Provider Adapter）**:
把中立内容块和调用选项投影为某类上游协议、再结合网关类型与底层格式语义把响应还原为内核事件的代码适配器；DeepSeek 官方、OpenAI 官方与 OpenRouter 的行为差异由各自适配器收编，而不是从聊天模型名称或文本样式推测。
_Avoid_: 模型上游、聊天模型、通用 OpenAI-compatible 开关

**原始推理（Raw Reasoning）**:
上游对外提供且未被其定义为摘要的可见推理文本，在内核中表示为 `ReasoningBlock(kind="raw")`。一次 Run 可有多次模型调用，成功消息的 `messages.reasoning` 是全部 raw block 的有序聚合，但完整分段与工具交错顺序仍以 transcript 为准。
_Avoid_: 隐藏思维链（系统只保存上游实际返回的内容）、推理摘要、最后一段推理

**推理摘要（Reasoning Summary）**:
上游定义为其内部推理之用户可读摘要的文本，在内核中表示为 `ReasoningBlock(kind="summary")`；网关即使以通用 text 类型承载，也以其明确的底层格式语义为准。不得根据文字长短、文风或 Markdown 猜测；成功消息的 `messages.reasoning_summary` 是全部 summary block 的有序聚合。
_Avoid_: 原始推理、前端截断、由应用自行总结的 reasoning

**Provider 续传块（Provider Continuation Block）**:
`run_provider_messages.blocks` 中由某个适配器拥有的不透明 JSON 状态，用于在工具调用后按上游协议继续同一推理过程。只有 `owner` 对应的适配器可以解释，且只能在所属 Provider 续传阶段内回放；它不进入消息 API、SSE、公开分享、模型管理响应或日志。
_Avoid_: 新的数据库保存机制、用户可见推理、通用 provider 参数

**Provider 续传阶段（Provider Continuation Stage）**:
同一 Provider 适配器、模型上游入口和上游模型连续成功生成的一段对话历史，只有该段历史可以复用不透明续传状态。成功切换到不兼容执行路径会结束旧阶段；之后即使切回原路径，也会开始一个新阶段。
_Avoid_: 同一会话、同一网关、仅按 continuation owner 推断兼容

**模型管理访问密钥（Model Management Access Key）**:
部署时固定配置、只授权模型管理 Web/API 的高熵秘密。它不代表用户身份或管理员角色，不进入 PostgreSQL，也不能替代模型上游 API key；普通用户 JWT 同样不能替代它。
_Avoid_: 管理员账号、管理员 JWT、模型上游 API key

**内容块（Content Block）**:
中立消息模型的组成单元：`Message(role, blocks)`，块类型为 TextBlock / DocumentBlock / ImageBlock / AttachmentNoticeBlock / ReasoningBlock / ProviderContinuationBlock / ToolCallBlock / ToolResultBlock；工具结果作为 user 消息内的 ToolResultBlock（Anthropic 式）。任何 provider 的 wire format 都是它的有损/无损投影，转换发生在 provider 适配器内。
_Avoid_: 直接以 DeepSeek/OpenAI wire 字段（如 `reasoning_content`、`tool_calls` 数组）描述业务内部消息

### 文件

**文件上传（File Upload）**:
用户把一个候选文件交给系统验证和处理的一次有期限过程，可能成功产生文件资产，也可能过期、被拒绝或失败。其过程记录服务于重试和短期排障，不是聊天历史或永久审计事实。
_Avoid_: 文件资产、消息附件、永久上传记录

**取消上传（Upload Cancellation）**:
后端已接受的、阻止文件上传继续产生或保留待绑定文件资产的显式用户意图。关闭页面、断网或中止浏览器 PUT 本身不构成可靠取消，只能由上传和待绑定期限兜底回收。
_Avoid_: 关闭页面、客户端中止、删除已绑定附件

**文件资产（File Asset）**:
用户上传并经系统验证、处理后，可被一个明确业务用途引用的不可变内容。第一版不提供独立文件库；文件资产必须最终成为当前头像或消息附件，否则在短暂的待绑定期结束后回收。
_Avoid_: 文件库文件、可被用户任意复用的文件

**文件对象（File Object）**:
文件资产在对象存储中的一种物理表示，包括原件和文件派生物。文件对象没有独立业务所有权，其访问与删除生命周期由所属文件资产决定。
_Avoid_: 文件资产、文件上传

**文件删除补偿（File Object Deletion）**:
对正式文件对象的删除承诺，是独立于业务关系持续存在的 PostgreSQL 事实行。私有附件对象须完成 R2 delete；公开头像对象还须完成 R2 delete 与 CDN purge，任一步失败只重试未完成步骤。
_Avoid_: best-effort 删除、只删数据库引用、对象存储扫描任务

**附件配额（File Quota）**:
每用户消息附件原件的事务性 `used_bytes` 与 `reserved_bytes` 状态。创建上传先预留，成功转为已用，失败/取消/过期释放；待绑定、已绑定和会话删除恢复期内资产都计入，头像与派生物不计入。
_Avoid_: bucket 使用量、预览大小、非事务性计数器

**待绑定文件（Unbound File）**:
已经处理成功、但尚未成为消息附件的临时文件资产，仅在用户编辑和发送消息所需的短时间内保留。读取或继续编辑不会延长其期限；只有绑定到明确用途后才停止回收。
_Avoid_: 草稿文件、用户文件

**脱离附件（Detached Attachment）**:
曾经绑定消息、但已不再被任何当前消息修订引用的文件资产。它保留三十天后回收原件和派生物并释放配额；归档消息仍保留附件元数据，旧 Run transcript 仍保留模型当时读取的文档块。
_Avoid_: 待绑定文件、当前消息附件、永久归档文件

**文件用途（File Purpose）**:
文件资产创建时确定且不可变的唯一业务用途，第一版为当前头像或消息附件。跨用途操作必须创建新的逻辑文件资产；即使底层字节被去重，不同用途的隐私、处理和生命周期语义也不得合并。
_Avoid_: 可变文件类型、跨用途复用

**附件上传开关（File Upload Feature Flag）**:
只控制新消息附件上传会话是否可创建的部署开关。关闭后前端隐藏入口、API 拒绝新建；既有附件读取、已排队处理、维护和删除补偿仍继续，以便安全回滚和排空事实行。
_Avoid_: 停止 file-worker、撤销删除补偿、隐藏历史附件

**原件（Original File）**:
用户上传的原始字节，是消息附件可下载内容的事实版本，始终保持私有且不可变。系统验证或提取内容时不得用规范化结果覆盖原件。
_Avoid_: 处理后文件、预览文件

**文件派生物（File Derivative）**:
从原件生成、服务于预览或模型消费的安全表示，例如缩略图、去元数据图片或规范化文本。文件派生物不取代原件，并与所属文件资产共享删除生命周期。
_Avoid_: 原件、独立文件资产

**模型输入表示（Model Input Representation）**:
文件资产为模型准备的受支持内容形态，种类为文档或图像；它的存在只说明文件已具备对应安全表示，是否可进入某次 Run 仍取决于所选模型能力。
_Avoid_: `model_consumable` 文件布尔值、模型能力、文件可用状态

**安全图像派生物（Safe Image Derivative）**:
图像原件经过完整解码和重新编码后产生的不可变表示，不含原件元数据，动画只保留首帧。视觉输入模型只接收该派生物，图像原件不进入 LLM provider。
_Avoid_: 图片原件、带元数据的模型输入、视觉描述

**文档派生文本（Document Extract）**:
从 PDF 或 Office 原件中按页、幻灯片、工作表、段落或表格结构提取的模型可消费文本。本期它只表达可提取的语义内容，不代表 OCR、页面视觉布局、图表或嵌入图片已被模型理解。
_Avoid_: 文档原件、完整视觉表示、OCR 结果

**文档块（Document Block）**:
Run 中承载一个模型可消费附件完整派生文本及其文件身份、摘要和提取版本的内容块。它随 transcript 固化模型当时实际读取的内容，并始终保留附件内容的低信任级别。
_Avoid_: R2 引用、文档摘要、系统提示

**图像块（Image Block）**:
Run 中承载一个模型可消费图像附件稳定身份及模型所见安全派生物快照的内容块，与同一用户 turn 的文字共同参与上下文裁剪。快照记录派生物类型、哈希、尺寸、处理版本和警告，但不保存存储地址、临时 URL 或图片字节；只要该 turn 仍在视觉模型的上下文中，后续模型调用就会重新获得对应图像内容。
_Avoid_: 附件提示块、首轮一次性图片、助手生成的图片描述

**历史仅展示图片（Legacy Display-Only Image）**:
视觉功能上线前已经进入当前消息分支、但其既有 Run transcript 只记录附件提示块的图片。它不是图像块，不得被后续视觉模型静默追溯理解；用户从当前分支最早的此类图片开始明确编辑或重新生成时，新 Run 才可产生图像块。
_Avoid_: 图像块、可追溯升级的旧图片、重写后的历史输入

**模型图像读取许可（Model Image Read Grant）**:
系统在一次模型调用前为图像块对应的安全图像派生物签发的短期读取能力。它不是 transcript 或文件资产状态，过期后由后续模型调用重新签发。
_Avoid_: 永久图片 URL、图像块、用户下载许可

**部分可读附件（Partially Readable Attachment）**:
已经产生非空文档派生文本、但原件仍含本期无法提取的扫描页、图表、嵌入图片或其他视觉内容的模型可消费附件。它可以进入上下文，但必须向用户明确提示模型只读取了可提取部分。
_Avoid_: 完整可读附件、提取失败附件

**消息附件（Message Attachment）**:
文件资产作为一条用户消息输入的业务用途。同一语义消息的后续修订版本可以继承其附件，但用户不能把历史附件任意复用到无关的新消息。
_Avoid_: 用户文件、文件库引用

**附件内容（Attachment Content）**:
从消息附件原件生成并交给模型的用户控制数据。无论其中出现何种命令式文字，它都不获得系统提示或开发者指令的优先级；文本、数据和源代码也不因语法无效而失去附件资格。
_Avoid_: 系统指令、可信配置、可执行代码

**可用文件（Ready File）**:
原件已经通过真实性与安全性验证，并已成功生成当前文件用途所要求派生物的文件资产。可用只表示它能够成为消息附件，不保证当前 provider 能把它加入模型上下文。
_Avoid_: 已上传文件、模型可消费文件

**模型可消费附件（Model-Consumable Attachment）**:
具有受支持内容表示、且当前所选 provider 明确具备相应输入能力的消息附件。系统只把模型可消费附件加入上下文；不支持的附件不得以文件名、隐式模型切换或其他伪装方式冒充已被模型理解。
_Avoid_: 可用文件、已上传文件

**视觉输入模型（Vision-Capable Model）**:
模型目录中明确声明可以消费图像内容块的模型。该能力属于具体模型而不是 provider 品牌，未声明能力的模型一律按不支持视觉输入处理。
_Avoid_: GPT 模型、OpenAI provider、通过模型名称猜测视觉能力

**视觉依赖会话（Vision-Dependent Conversation）**:
当前未归档用户消息的有效输入中包含图像块、因而后续 Run 必须使用视觉输入模型的会话。历史仅展示图片不构成图像块；归档消息和脱离附件不维持该约束，当前消息修订移除全部图像块后，会话不再具有视觉依赖。
_Avoid_: GPT 会话、图片会话、按首个模型永久锁定的会话

**图片上下文状态（Image Context State）**:
从当前消息分支及其有效 Run transcript 派生的模型选择约束投影，取值表达无约束、必须使用视觉模型，或必须先从最早的历史仅展示图片开始升级。它供交互层呈现限制，不是持久化会话状态。
_Avoid_: 会话模型字段、永久视觉标记、前端推测状态

**完整附件输入（Complete Attachment Input）**:
一次 Run 将某个模型可消费附件纳入上下文时，使用其全部文档派生文本，不进行静默截断或抽样。本期不提供检索式附件；超过完整输入预算的附件必须在提交 Run 前明确拒绝。
_Avoid_: 截断附件、检索式附件、附件摘要

**附件输入预算（Attachment Input Budget）**:
提交用户消息时，结合所选 provider/model、系统提示、会话历史及全部附件估算的可用上下文容量。它是某次 Run 的接纳条件，不是文件资产的状态；文件模块只提供完整派生内容及其估算量。
_Avoid_: 上传大小限制、文件状态

**仅展示附件（Display-Only Attachment）**:
可以随消息保存和展示、但原件及派生内容不会加入当前 Run 模型上下文的消息附件。模型只收到说明附件存在且当前不可读取的附件提示块；该提示不能单独满足用户消息的模型输入要求。
_Avoid_: 模型可消费附件、已被模型读取的附件

**附件提示块（Attachment Notice Block）**:
系统为仅展示附件生成的最小内容块，只告知模型附件的安全文件名、类型及当前无法读取的事实。它不包含附件字节、URL、OCR 或视觉描述，也不属于用户实际输入的文字。
_Avoid_: 文档块、图片内容、伪造的用户提示

**分享附件占位（Shared Attachment Placeholder）**:
公开会话快照中用于说明原消息曾包含附件的非敏感元数据。它不包含原件、派生物、预览或下载能力，也不意味着私有消息附件已经公开。
_Avoid_: 公开附件、附件分享链接
