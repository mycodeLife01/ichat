# 切换全局文字基线并清除遗留覆盖

Type: refactor

Status: ready-for-agent

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

- [ ] html/body 使用 --font-ui、16px 根字号和 PRD 锁定的基础行高。
- [ ] --font-sans 不再是普通 UI 根字体，只被品牌范围消费。
- [ ] 业务 JSX 不再出现 text-[10px] 至 text-[17px] 任意像素字号或任意 leading。
- [ ] 不存在 10.5px、11.5px、12.5px、13.5px 半像素功能字号。
- [ ] 所有响应式字号差异都有 reference matrix 证据；无证据的覆盖已移除。
- [ ] @theme 中受 root font-size 影响的 spacing/type utility 仍输出预期 CSS px，不产生布局漂移。
- [ ] 助手、Sidebar、聊天核心、次级页面和全部品牌基线通过。
- [ ] git diff 只包含文字系统所需变更，没有无关 refactor 或格式化。
- [ ] 全量 Vitest、pnpm run lint、pnpm run typecheck、pnpm run build、pnpm run test:visual 和 git diff --check 通过。

## Comments

- 2026-08-16：创建 ticket。根字号切换是最后的迁移步骤，不得提前合入。
