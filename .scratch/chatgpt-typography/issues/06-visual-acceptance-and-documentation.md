# 完成视觉验收、可访问性检查与文档收口

Type: test

Status: ready-for-agent

Blocked by: 05

## What to build

用真实 Chrome 证明迁移结果符合冻结参考，并把维护规则写入前端架构文档。

扩展或新增 frontend/tests/visual/typography-system visual fixture，覆盖：

- uiText、uiLabel、metaText、controlText；
- Composer、用户消息、助手正文、ThinkingBlock；
- 标题、段落、列表、表格、引用、链接、行内代码、代码块；
- Sidebar、菜单、Dialog、表单、Toast、状态提示、附件；
- 全部 Wordmark 和 AuthScreen 品牌标题变体；
- 中文、英文、数字、标点、emoji、长单词、长 URL 和混排。

逐角色用 getComputedStyle 对照 reference matrix，并在桌面、窄屏、移动与 200% zoom 下截图。更新 docs/architecture/frontend.md，说明令牌来源、角色选择、品牌冻结边界、例外和新增文字的评审规则。

## Acceptance criteria

- [ ] 每个 reference matrix 角色至少有一项真实浏览器 computed-style 断言。
- [ ] 1280×800、768、320、375、390/414px 截图通过，无裁切、遮挡、异常换行或横向滚动。
- [ ] 200% zoom 下所有文本可读，交互控件可达，焦点和错误信息不丢失。
- [ ] 主文字对比度至少 4.5:1；状态文字继续有图标、role 或文案等非颜色通道。
- [ ] 助手 Markdown golden 通过，差异仅包含 reference matrix 明确要求的变化。
- [ ] Wordmark 和 AuthScreen 品牌标题的 family、size、line-height、weight、spacing、transform、color 和 bounding box 与迁移前一致。
- [ ] rg 审计无未记录的任意字号、任意行高、普通 UI font-sans 或组件级 font-family。
- [ ] docs/architecture/frontend.md 已记录文字系统；如新增文档，docs/README.md 路由同步更新。
- [ ] pnpm exec vitest run、pnpm run lint、pnpm run typecheck、pnpm run build、pnpm run test:visual 和 git diff --check 全部通过。
- [ ] 把最终测试数量、浏览器矩阵、截图结果和允许例外追加到本 ticket Comments，并把本 ticket 和 PRD 状态更新为 completed。

## Comments

- 2026-08-16：创建 ticket。最终验收以冻结 reference matrix 为准，不追随 ChatGPT 后续线上变化。
