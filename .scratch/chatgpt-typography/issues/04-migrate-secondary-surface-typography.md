# 迁移次级页面与状态文字系统

Type: refactor

Status: completed

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

- [x] 范围内每个文本节点都能追溯到 reference matrix 中的语义角色。
- [x] 10.5px、11.5px、12.5px、13.5px 等半像素功能字号已全部移除。
- [x] Sidebar、UserMenu、Dropdown 和 BottomSheet 对应角色在桌面/移动端具有相同字号、行高和字重。
- [x] Dialog、表单、账户、分享、认证和附件状态在中文/英文长文本下无裁切或重叠。
- [x] placeholder、disabled、error、warning、success 的文字颜色符合各自语义；状态不只通过颜色表达。
- [x] Wordmark 所有使用点与 AuthScreen 品牌标题通过 ticket 01 的 computed-style 和 screenshot 基线。
- [x] 未改变产品文案、表面颜色、圆角、图标、触摸目标、焦点管理或业务行为。
- [x] 相关 Vitest、pnpm run lint、pnpm run typecheck、pnpm run build、次级页面 visual subset 和 git diff --check 通过。

## Comments

- 2026-08-16：创建 ticket。此 ticket 与 03 可在令牌层稳定后并行，但不得同时修改同一共享 class。
- 2026-08-16：完成次级表面迁移。Sidebar、UserMenu、通用菜单/BottomSheet、Dialog、账户/分享卡片、头像裁剪、认证表单与生命周期页、公开分享页、Toast/InlineStatus/VerifyEmailBanner 和空状态均消费 ticket 02 的 `ui*`、`form*`、`surfaceTitle`、`controlText` 或 `semanticStatus*` 角色；目标范围的半像素功能字号和移动端字号放大已移除。
- 2026-08-16：长中文、连续英文、邮箱和状态说明通过自然 reflow 或矩阵指定的单行 ellipsis 处理；长 Toast 限制在 `100vw - 32px` 并允许正文断行，InlineStatus 和帮助/标题角色允许正常断词。表面色、圆角、图标、触摸目标、焦点和业务 handler 未改变。
- 2026-08-16：生产组件 visual fixture 在 320、375、390、414、768、1280px 逐档验证 Sidebar/UserMenu/BottomSheet、placeholder/disabled 与 error/warning/success；桌面和移动项目另验证 AuthScreen、AccountCard、MySharesCard、ShareDialog、ConfirmDialog、AvatarCropper、ResetPasswordPage 与 SharePage。全量 Vitest 74 files / 634 tests，lint、typecheck、build、Playwright（28 passed / 20 expected skips）及 `git diff --check` 通过。
- 2026-08-16：Wordmark、AuthScreen 22px 品牌标题、助手 Markdown、ticket 03 聊天角色/夹具和 `html/body` 15/24 旧根基线继续通过保护断言；未重新调整 Composer、Message、Thinking、Citation、SourcesPanel 或聊天附件。
