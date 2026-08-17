# 完成视觉验收、可访问性检查与文档收口

Type: test

Status: completed

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

- [x] 每个 reference matrix 角色至少有一项真实浏览器 computed-style 断言。
- [x] 1280×800、768、320、375、390/414px 截图通过，无裁切、遮挡、异常换行或横向滚动。
- [x] 200% zoom 下所有文本可读，交互控件可达，焦点和错误信息不丢失。
- [x] 主文字对比度至少 4.5:1；状态文字继续有图标、role 或文案等非颜色通道。
- [x] 助手 Markdown golden 通过，差异仅包含 reference matrix 明确要求的变化。
- [x] Wordmark 和 AuthScreen 品牌标题的 family、size、line-height、weight、spacing、transform、color 和 bounding box 与迁移前一致。
- [x] rg 审计无未记录的任意字号、任意行高、普通 UI font-sans 或组件级 font-family。
- [x] docs/architecture/frontend.md 已记录文字系统；如新增文档，docs/README.md 路由同步更新。
- [x] pnpm exec vitest run、pnpm run lint、pnpm run typecheck、pnpm run build、pnpm run test:visual 和 git diff --check 全部通过。
- [x] 把最终测试数量、浏览器矩阵、截图结果和允许例外追加到本 ticket Comments，并把本 ticket 和 PRD 状态更新为 completed。

## Comments

- 2026-08-16：创建 ticket。最终验收以冻结 reference matrix 为准，不追随 ChatGPT 后续线上变化。
- 2026-08-16：最终验收完成。`typography-system.visual.ts` 明确列出 reference matrix 的 34 个
  角色，每个角色至少有一项生产渲染节点的 `getComputedStyle` 断言；同时覆盖中文、英文、数字、
  标点、emoji、长单词、长 URL 与混排。Composer、用户消息、助手正文、Thinking、全部 Markdown
  元素、Sidebar、菜单、BottomSheet、Dialog、表单、Toast、状态、附件、来源、所有 Wordmark 与
  AuthScreen 品牌变体均通过。
- 2026-08-16：浏览器矩阵使用 Chromium、DPR 1、浅色和 reduced motion。desktop 项目逐档执行
  320×844、375×844、390×844、414×844、768×900、1280×800；mobile 项目固定 390×844。
  `chat-core-*`、`secondary-navigation-*`、`secondary-states-*`、desktop/mobile
  `typography-system.png` 均写入 gitignored Playwright 结果目录并人工复核，无裁切、遮挡或页面级
  横向滚动。助手 desktop/mobile approved golden 无 diff。
- 2026-08-16：200% 使用真实 Chromium device-metrics override：1280×800 物理画布、640×400 CSS
  viewport、`scale=2`，并以 1280×800 PNG 证明输出尺度。注册表单的键盘 focus ring 为 2px，所有
  可见控件逐一滚入视口后保持可达；字段错误继续由 `aria-describedby` 关联，error/warning/success
  文案和图标完整；Auth 与状态页均无水平 overflow。截图为 `typography-zoom-200-auth.png` 与
  `typography-zoom-200-states.png`。
- 2026-08-16：代表性 primary 实际前景/祖先背景按 WCAG 公式计算均 >= 4.5:1；本矩阵最低样本为
  用户消息 `#0c274a` / `#f4f3f0` 的 13.47:1。error 使用 `role="alert"`，warning/success 使用
  `role="status"`，三者及 warning Toast 均保留 tone 对应图标和明确文案；上传失败还保留显式
  “上传失败”文本，不依赖颜色传达状态。
- 2026-08-16：机械审计结果为 arbitrary pixel text 0、arbitrary leading 0、半像素功能字号 0、
  响应式任意字号 0、组件级 `font-sans` 0、组件级 `fontFamily` 0、非集中 CSS `font-family` 0。
  允许例外只有：`Wordmark.tsx` 的动态品牌 `fontSize`；`global.css` 集中的 Wordmark/Auth 品牌栈、
  Sidebar desktop 字标继承、UI 根/Sidebar/Markdown 栈、代码栈；KaTeX 第三方数学字体；
  `codeHighlight.test.ts` 中不会进入生产 CSS 的 `48rem` 输入样本。
- 2026-08-16：最终命令全部通过：Vitest 74 files / 634 tests；Playwright 30 passed / 22 expected
  skips；lint 0 errors（仅既有 `authFields.tsx` Fast Refresh warning）；typecheck、production build、
  无更新参数的 assistant golden 和 `git diff --check` 通过。build 仅保留既有 large chunk warning。
