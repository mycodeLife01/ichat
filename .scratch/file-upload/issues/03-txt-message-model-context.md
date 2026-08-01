Type: feat
Status: completed
Blocked by: 02

# TXT 附件进入消息与模型上下文

## 目标

让 ready TXT 成为真正的消息附件：在一次事务中绑定 Message 与 Run，把完整派生文本以
中立 `DocumentBlock` 送入模型，并把实际读取快照保存到 transcript。

## 交付范围

1. 消息发送契约接受有序 `attachment_ids`。后端验证所有权、purpose、ready、待绑定期限、
   每条最多五个、原件总计最多 50 MiB，并在同一事务创建 Message、全部
   MessageAttachment、待绑定保护和 Run；任一失败时全部不创建。
2. `messages.content` 只保存用户文字且允许为空；消息必须包含非空文字或至少一个模型
   可消费文档。派生正文不得拼进 content。
3. 在 agent kernel 中增加 provider-neutral `DocumentBlock`，包含稳定文件身份、安全
   文件名/类型、完整派生文本、摘要元数据、SHA-256、extractor version 和 warning。
   DeepSeek adapter 只投影 blocks，不调用 provider Files API，也不上传原件。
4. 校准实际 `context_budget_tokens=256000`。目标用户 turn 最多 128,000 estimated tokens
   且不超过总预算 50%；超限在创建 Run 前拒绝，不截断、不摘要、不做 RAG。历史只按完整
   turn 裁剪，目标 turn 的文字与附件不可拆开。
5. Run transcript 保存模型实际读取的完整 DocumentBlock；历史回放只读 transcript，
   不访问 R2 或重新解析文件，并保持现有 blocks round-trip 兼容。
6. 前端仅在全部附件 ready 后允许发送；消息气泡展示稳定附件卡片、warning 与五分钟
   下载入口。后端鉴权后签发 private canonical GET，API 不代理字节。

## 验收

- 文本+TXT 和纯 TXT 消息均能完成对话；模型上下文包含完整文档，数据库 message content
  不包含文档文本。
- 一组附件中任一不合法时，无 Message、MessageAttachment 或 Run 残留；并发绑定同一
  待绑定资产不能突破领域约束。
- 128k 目标 turn 边界、总预算 50%、整 turn 裁剪和永不裁剪目标 turn 均有测试；环境默认、
  `.env.example`、capabilities 与测试口径一致为 256k/128k。
- transcript round-trip 断言 file identity、hash、version、warning 和全文不丢失；删除或
  模拟 R2 不可用后，历史继续追问仍成功。
- 下载授权覆盖待绑定所有者、绑定消息可见性、五分钟过期、停用账户与软删除会话拒绝。
- 后端及前端全套检查通过，并完成一条使用 fake provider 的端到端聊天测试。
