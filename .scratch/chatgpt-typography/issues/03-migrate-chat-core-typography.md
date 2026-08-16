# 迁移聊天核心文字系统

Type: refactor

Status: ready-for-agent

Blocked by: 02

## What to build

把高频聊天路径迁移到 ticket 02 的语义文字角色：

- frontend/src/ui/Composer.tsx；
- frontend/src/messages/Message.tsx；
- frontend/src/messages/StreamingMessage.tsx；
- frontend/src/messages/ThinkingBlock.tsx；
- MessageAction、Citation、Sources、MessageAttachments、AttachmentCard 及相关 Run/工具状态；
- frontend/src/ui/classes.ts 中的 messageBubble 和聊天专用共享原语。

目标行为：

- Composer 输入和 placeholder 使用 16/26；移动端不再放大为 17px；
- Composer 当前模式/思考等级使用 16/26，菜单条目使用 14/20；
- 用户消息和编辑器使用系统字体 16/24、#0c274a；
- 助手正文维持 16/26 及现有 golden；
- 思考标签使用 16/24 tertiary，展开正文使用 16/24 primary；
- 消息操作、引用、来源、附件和 Run 状态分别映射到 ui、label 或 meta 角色；
- 不再使用缩小文字解决溢出。模式名称过长时，按 ChatGPT 的当前值层级显示简短当前值，完整模型/模式名称保留在菜单和可访问名称中。

保持发送、停止、IME、编辑并重发、重新生成、引用、来源、上传和 Run 生命周期不变。

## Acceptance criteria

- [ ] Composer textarea、placeholder、模式 trigger 和菜单 computed style 与 reference matrix 一致。
- [ ] Composer、ThinkingBlock 和 Sidebar/消息动作中不存在未经参考支持的移动端字号放大。
- [ ] 用户消息只读态、展开态和编辑态均为 16/24、系统字体和 #0c274a。
- [ ] ThinkingBlock 折叠标签与展开正文分别使用 tertiary 和 primary，字号均为 16/24。
- [ ] 助手 Markdown 的 desktop/mobile golden 无未经确认的 diff。
- [ ] 引用、来源、工具、附件、Run failed/cancelled 和消息操作均使用语义文字角色，不保留半像素字号。
- [ ] 文本变更只影响排印和自然 reflow，不改变圆角、背景、图标、API 或业务行为。
- [ ] 320、375、390/414、768 和 1280px 下无文字裁切、菜单溢出或意外横向滚动。
- [ ] 相关 Vitest、pnpm run lint、pnpm run typecheck、pnpm run build、聊天 visual subset 和 git diff --check 通过。

## Comments

- 2026-08-16：创建 ticket。助手正文属于保护区；主要视觉变化应集中在 Composer、用户消息和思考展开正文。
