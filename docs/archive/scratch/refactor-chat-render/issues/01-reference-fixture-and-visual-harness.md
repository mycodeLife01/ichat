# 固定 ChatGPT 参考与建立视觉验收 fixture

Type: test

Status: completed

Blocked by: None

## What to build

把当前已登录 Chrome 中的 ChatGPT 示例对话固定为本 feature 的点时参考，并在前端建立不依赖认证、后端或生产路由的助手回复视觉 fixture。fixture 必须能单独展示所有本期 surface，并能被 Playwright 在固定桌面/移动 viewport 截图和检查几何属性。

建议使用 Vite 可直接加载但不会进入默认生产入口的 `frontend/tests/visual/assistant-rendering.html` + React entry；不要给正式 Router 增加 `/debug` 或 `/fixture` 路由。

## Reference matrix

- Chrome：记录具体版本，100% zoom，浅色主题，`deviceScaleFactor=1`。
- 已测桌面样本：viewport `2560 × 1249`，助手正文宽度 768px。
- 自动视觉场景：至少 `1440 × 900` 和 `390 × 844`。
- fixture 内容：H1–H6、段落、强调、删除线、嵌套列表、任务列表、引用、分隔线、普通/长/相对链接、行内代码、无语言及多语言 fenced code、宽表格、KaTeX、citation、长 URL、中英文与 emoji。
- fixture 状态：完整正文、流式未闭合 Markdown、复制成功/失败、ThinkingBlock 折叠与展开的回归场景。

## Implementation constraints

- 使用 `pnpm` 增加 `@playwright/test`，同步唯一的 `pnpm-lock.yaml`。
- 增加独立 `playwright.config.ts` 和 `test:visual` script；配置应启动本地 Vite、固定 viewport/颜色方案/动画和截图目录。
- 在线 ChatGPT 页面只作为一次性参考，不作为自动测试依赖，不把私有会话 URL、登录态或 Cookie 写入仓库。
- 参考截图若包含私有信息，只保留在临时目录；仓库记录经过脱敏的 metrics 和本地 fixture。
- 本 ticket 不改生产 Markdown 样式，不提前生成“看起来正确”的最终 golden screenshot；最终批准后的 baseline 在 ticket 06 固化。

## Acceptance criteria

- [x] 记录参考 Chrome 版本、zoom、主题、viewport、实际字体和本 PRD 列出的桌面 computed-style 数值。
- [x] 补测参考页移动 viewport，记录正文、标题、代码和表格关键尺寸；无法可靠测量的项目明确标注，不用桌面值猜测。
- [x] 独立 fixture 无需登录和 API 即可由 Vite/Playwright 打开，且不会进入 `pnpm run build` 的正式应用入口。
- [x] fixture 覆盖 reference matrix 中所有内容与状态，数据不包含真实会话内容或凭证。
- [x] Playwright smoke 能检查 fixture 已加载、目标 surface 全部存在，并产出桌面/移动诊断截图 artifact。
- [x] `test:visual`、现有 Vitest、typecheck、lint 和 build 全部通过。
- [x] `pnpm-lock.yaml` 是唯一新增/更新的包管理器锁文件。

## Verification

```bash
cd frontend
pnpm run test:visual
pnpm exec vitest run src/messages/Markdown.test.tsx src/messages/ThinkingBlock.test.tsx
pnpm run typecheck
pnpm run lint
pnpm run build
```

## Comments

- 2026-08-15：视觉工具先提供可重复场景和诊断资产，批准后的 golden 延后到 ticket 06，避免把改造前画面误设为长期基线。
- 2026-08-15：完成 Chrome `151.0.7922.138` 点时参考与 `390 × 844` 移动补测，脱敏指标记录在 `frontend/tests/visual/assistant-rendering-reference.md`。新增独立 Vite fixture、`@playwright/test` 配置和 `test:visual`；桌面/移动各 1 个 smoke 通过并生成 gitignored 诊断截图。生产 build 仍仅输出根 `index.html`，未包含 fixture。验证结果：Playwright 2 passed、Vitest 67 files / 531 tests passed、typecheck、lint、build 均通过。
