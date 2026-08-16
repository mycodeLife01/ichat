# 迁移次级页面与状态文字系统

Type: refactor

Status: ready-for-agent

Blocked by: 02

## What to build

把聊天核心以外的所有用户可见文字迁移到 reference matrix 和共享文字角色。

范围包括：

- Sidebar、UserMenu、Dropdown、BottomSheet；
- Toast、VerifyEmailBanner、ConfirmDialog、ModalDialog、ShareDialog；
- AccountCard、MySharesCard、AvatarCropper；
- AuthScreen 中除品牌标题外的表单文字；
- ResetPasswordPage、VerifyEmailPage、ConfirmAccountDeletionPage；
- SharePage、附件卡片、上传/解析状态和空状态。

迁移原则：

- 普通 UI、按钮、菜单为 14/20；
- 分组/字段强调为 14/20、500；
- Meta、帮助、时间和次级说明为 12/16；
- 页面/Dialog 标题使用 ticket 01 锁定的 ChatGPT 标题角色；
- error、warning、success 保留现有 tone，只统一字体度量；
- 文案内容和动作名称不变；
- Wordmark 与 AuthScreen 22px 品牌标题完全不变。

## Acceptance criteria

- [ ] 范围内每个文本节点都能追溯到 reference matrix 中的语义角色。
- [ ] 10.5px、11.5px、12.5px、13.5px 等半像素功能字号已全部移除。
- [ ] Sidebar、UserMenu、Dropdown 和 BottomSheet 对应角色在桌面/移动端具有相同字号、行高和字重。
- [ ] Dialog、表单、账户、分享、认证和附件状态在中文/英文长文本下无裁切或重叠。
- [ ] placeholder、disabled、error、warning、success 的文字颜色符合各自语义；状态不只通过颜色表达。
- [ ] Wordmark 所有使用点与 AuthScreen 品牌标题通过 ticket 01 的 computed-style 和 screenshot 基线。
- [ ] 未改变产品文案、表面颜色、圆角、图标、触摸目标、焦点管理或业务行为。
- [ ] 相关 Vitest、pnpm run lint、pnpm run typecheck、pnpm run build、次级页面 visual subset 和 git diff --check 通过。

## Comments

- 2026-08-16：创建 ticket。此 ticket 与 03 可在令牌层稳定后并行，但不得同时修改同一共享 class。
