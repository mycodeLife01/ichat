# iChat

AI 聊天服务：用户与 DeepSeek 模型进行流式对话。单一限界上下文，认证与账户生命周期、会话与运行（Run）编排共处一个领域。

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
用户主动终止自己账户的动作，需当前密码与邮箱双重确认。生效后账户立即停用；会话、消息等业务数据的物理清除是后续独立阶段，但公开头像因可被 CDN URL 继续访问而在确认时立即删除并 purge。
_Avoid_: 删号、销户

**停用（Deactivated）**:
账户不可登录、不可访问任何接口的状态。停用不等于数据删除。
_Avoid_: 封禁（封禁是运营处罚，停用是账户生命周期状态）

### 会话与运行

**Run（运行）**:
一次由用户消息触发的后台生成任务：worker 认领（claim）后调用 LLM provider 流式产出回复，全生命周期为 queued → started → streaming → succeeded/failed/cancelled（含 cancelling 过渡态）。Run 行本身也是 PG 任务队列中的状态行。
_Avoid_: 任务、请求（与 HTTP 请求混淆）

**转写（Transcript）**:
一次 run 中业务与 LLM 之间完整通信记录的事实源，持久化在 `run_provider_messages` 表（表名不改）。代码域一律使用 transcript 词根（如 `load_transcript`、`RunResult.transcript`）。
_Avoid_: provider message（代码词汇层已废弃）、聊天记录（那是面向用户的 messages）

**agent 内核（Agent Kernel）**:
`app/agent/` 包——provider 中立、不读数据库、不碰传输层、不含业务组装的 agent building blocks：Message/内容块词汇、Provider 协议与适配器、Tool 协议与注册表、单次模型调用与工具执行原语、AgentEvent 事件词汇。agent 循环与业务装配归编排层（`app/services/agents`），工程化（seq、发布、持久化、重试执行、取消）归 worker。
_Avoid_: agent 框架（明确不做图编排/chain/多 agent）、编排核心（编排在内核之外）

**模型调用（Model Call）**:
agent 循环内对 LLM provider 的一次流式请求-响应。一个 run 可含多次模型调用（工具循环）。与「轮（Turn）」区分：turn 专指用户↔助手的一轮对话交换（历史裁剪的计量单位），不用于指代单次 provider 调用。
_Avoid_: turn（指 provider 调用时）、请求（与 HTTP 请求混淆）

**内容块（Content Block）**:
中立消息模型的组成单元：`Message(role, blocks)`，块类型为 TextBlock / ReasoningBlock / ToolCallBlock / ToolResultBlock；工具结果作为 user 消息内的 ToolResultBlock（Anthropic 式）。任何 provider 的 wire format 都是它的有损/无损投影，转换发生在 provider 适配器内。
_Avoid_: 直接以 DeepSeek/OpenAI wire 字段（如 `reasoning_content`、`tool_calls` 数组）描述业务内部消息
