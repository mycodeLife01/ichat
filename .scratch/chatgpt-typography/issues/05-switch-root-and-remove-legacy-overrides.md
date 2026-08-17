# 切换全局文字基线并清除遗留覆盖

Type: refactor

Status: completed

Blocked by: 03, 04

## What to build

在所有生产表面均已显式迁移后，把 html/body 切换到 --font-ui 和 16px 基线，并移除只为旧 Inter/15px 系统服务的上下文覆盖。

完成机械审计：

- frontend/src 中的 text-[…px]；
- leading-[…]；
- font-sans、font-family 和 inline font style；
- max-[…]:text-[…] 响应式字号覆盖；
- #1a1a19、#6b6a66、#95938e、#b8b6b0 等遗留文字色直接消费者；
- 因根字号变化而漂移的 rem utility。

允许的例外必须集中列在注释和测试中：

- Wordmark 与 AuthScreen 品牌标题；
- 等宽代码和 KaTeX；
- reference matrix 明确记录的第三方内容字体。

不得通过全局替换或格式化重写无关代码；按消费者逐项迁移并验证。

## Acceptance criteria

- [x] html/body 使用 --font-ui、16px 根字号和 PRD 锁定的基础行高。
- [x] --font-sans 不再是普通 UI 根字体，只被品牌范围消费。
- [x] 业务 JSX 不再出现 text-[10px] 至 text-[17px] 任意像素字号或任意 leading。
- [x] 不存在 10.5px、11.5px、12.5px、13.5px 半像素功能字号。
- [x] 所有响应式字号差异都有 reference matrix 证据；无证据的覆盖已移除。
- [x] @theme 中受 root font-size 影响的 spacing/type utility 仍输出预期 CSS px，不产生布局漂移。
- [x] 助手、Sidebar、聊天核心、次级页面和全部品牌基线通过。
- [x] git diff 只包含文字系统所需变更，没有无关 refactor 或格式化。
- [x] 全量 Vitest、pnpm run lint、pnpm run typecheck、pnpm run build、pnpm run test:visual 和 git diff --check 通过。

## Comments

- 2026-08-16：创建 ticket。根字号切换是最后的迁移步骤，不得提前合入。
- 2026-08-16：完成根基线切换。`html/body` 现为 `var(--font-ui)`、16px、1.5（computed 24px）与 type primary；Wordmark、Sidebar desktop Wordmark 和 AuthScreen 22px 标题通过窄作用域品牌规则继续保持原 family、28.8/32/24/35.2px 行高、字距、transform、颜色与边界。
- 2026-08-16：机械审计清零生产 `frontend/src` 的任意 px 字号、任意 leading、10.5–13.5px 半像素字号、响应式字号覆盖和 `font-[…]`；唯一 inline font metric 是 Wordmark 的品牌尺寸 prop。品牌、代码与 KaTeX 是集中注释并由 Playwright computed-style 断言保护的仅有非 UI 字体例外。
- 2026-08-16：根字号漂移审计把仍被消费的 `text-lg` 固定为切换前 16.875/26.25px、`rounded-xl` 固定为 11.25px，并把 Composer 的 `max(30svh, 5rem)` 改为等价 `max(30svh, 75px)`；生产构建不再输出被消费的 1.125rem/.75rem 值。UserMenu 10px 头像首字母改用矩阵允许的 12/16 Meta 角色，触摸目标不变。
- 2026-08-16：320、375、390、414、768、1280px 生产夹具与 desktop/mobile 全表面通过；1280 聊天核心、Account 和完整品牌/角色诊断截图与切换前哈希一致，窄屏唯一预期变化是头像首字母 10→12px。全量 Vitest 74 files / 634 tests、lint、typecheck、production build、Playwright 28 passed / 20 expected skips 及 `git diff --check` 通过。
