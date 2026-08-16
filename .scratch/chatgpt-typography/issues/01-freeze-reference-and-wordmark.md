# 锁定 ChatGPT 参考矩阵与 iChat 品牌字标基线

Type: test

Status: ready-for-agent

Blocked by: None

## What to build

在修改生产文字样式前，把 2026-08-16 Chrome 中的 ChatGPT 文字系统和当前 iChat 品牌字标转化为可复现的基线。

建立 .scratch/chatgpt-typography/reference-matrix.md，逐项记录：

- iChat 语义角色与 ChatGPT 对应表面；
- URL/界面状态、视口、DPR、zoom 和采样日期；
- font-family、font-size、line-height、font-weight、letter-spacing、color；
- placeholder、disabled、selected、error 等状态文字；
- white-space、text-wrap、overflow-wrap、text-overflow 和截断规则；
- 无直接对应表面时采用的最近 ChatGPT 角色及理由。

参考范围至少覆盖：

- ChatGPT 普通会话、富 Markdown 回复、用户消息、Composer、模式/思考等级菜单、思考展开态；
- Sidebar、Popover、Dialog、表单、按钮、Meta、状态提示和附件/来源类信息；
- iChat 的聊天、账户、分享、认证和上传状态页面。

同时扩展本地 visual fixture，展示并锁定全部品牌变体：

- Wordmark 18px、20px；
- Sidebar 展开/收起；
- SharePage 桌面/移动；
- VerifyEmailPage、ResetPasswordPage、ConfirmAccountDeletionPage；
- AuthScreen 22px 独立品牌标题。

本 ticket 只建立参考、fixture 和断言，不迁移生产文字样式。

## Acceptance criteria

- [ ] reference-matrix.md 中每个目标文字角色都有 ChatGPT 对应、精确 computed value 和采样上下文，不存在 TBD。
- [ ] PRD 中的已确认值与重新采样一致；若不一致，以同一日期/环境的证据更新 PRD，并在 Comments 记录原因。
- [ ] 品牌基线覆盖 font-family、size、line-height、weight、letter-spacing、transform、color 和 bounding box。
- [ ] Playwright fixture 同时包含中文、英文、数字、标点、emoji、长单词和长 URL。
- [ ] 助手 Markdown 与桌面 Sidebar 的当前已对齐状态有截图或 computed-style 基线。
- [ ] 参考截图与数据只用于内部验收，不接入生产路由或用户页面。
- [ ] 未修改 frontend/src 中的生产样式或组件行为。
- [ ] pnpm run test:visual 和 git diff --check 通过。

## Comments

- 2026-08-16：创建 ticket。此前实测已确认 PRD 主角色表；本 ticket 负责把剩余页面状态和品牌变体固化为可复现证据。
