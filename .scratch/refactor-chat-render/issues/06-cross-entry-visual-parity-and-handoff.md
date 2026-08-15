# 完成三入口视觉验收与文档交接

Type: test

Status: completed

Blocked by: 05

## What to build

以 ticket 01 固定的 ChatGPT 参考和 fixture 为准，完成最终 CSS 微调、三个入口的真实浏览器验收、golden screenshot 固化和项目文档交接。本 ticket 不再引入新渲染能力；发现功能缺口时回到所属 ticket 修复并重跑全矩阵。

## Browser matrix

- Windows Chrome、100% zoom、浅色主题。
- 桌面：参考 viewport 与 `1440 × 900`。
- 移动：`390 × 844`，并使用 ticket 01 的 ChatGPT 移动实测值。
- 入口：历史最终消息、进行中流式消息、失败/取消 partial、刷新恢复、公开分享。
- 状态：普通、hover、focus-visible、复制成功/失败、代码/表格横向滚动、ThinkingBlock 折叠/展开。

## Visual acceptance method

1. 在相同字体、viewport、主题和 zoom 下分别截取参考与本地助手正文 crop。
2. 对内容列、段落、标题、inline code、code header/body、table header/cell、blockquote 和 action alignment 比较 bounding box 与 computed style。
3. 修复任何超过 1px 的几何偏差和未确认的颜色/边框/圆角差异。
4. 动态内容、光标和字体抗锯齿可以 mask，但不能用宽泛 mask 隐藏布局差异。
5. 人工批准后生成桌面/移动 Playwright golden screenshots；之后 `test:visual` 不带 `--update-snapshots` 运行必须通过。

## Documentation

- 更新 `docs/handover/frontend/2026-08-15-chatgpt-ai-response-rendering.md`，注明本 feature 的最终确认范围：reasoning 不改、未引入 AssistantRenderModel/Display Part。
- 更新 `docs/architecture/frontend.md` 的 Markdown 模块、助手内容列、视觉测试和安全不变量。
- 新增 `docs/handover/frontend/2026-08-15-chatgpt-response-rendering.md`，记录实际文件、依赖、构建体积、性能结果、视觉证据、已知偏差、验证命令和回滚方法。
- 更新 `docs/README.md` 的对应 handover 索引；该索引保持英文。

## Acceptance criteria

- [x] 当前支持的助手正文 surface 已在固定参考环境中逐项验收，所有未消除偏差都有明确、经用户接受的记录。
- [x] 内容列和主要 surface 的几何差异不超过 1px，computed style 与固定参考一致。
- [x] 最终、流式和公开分享的同一正文在入口特有动作之外视觉一致。
- [x] 390px 页面无水平 overflow，代码和表格只在自身滚动。
- [x] reasoning 折叠、展开、preview、DeepSeek 自动展开、正文 handoff、恢复和最终隐藏逻辑与改造前一致。
- [x] Playwright desktop/mobile golden screenshots 已获批准并在无 update 参数下稳定通过。
- [x] 全量 Vitest、typecheck、lint、build、visual test 和 `git diff --check` 通过。
- [x] 报告、前端架构、handover 与 docs index 已同步，且没有声称实现范围外的 Mermaid/chart/code execution。
- [x] PRD 与全部 issue 状态更新为 `completed`，PRD frontier 更新为全部完成。

## Verification

```bash
cd frontend
pnpm run lint
pnpm run typecheck
pnpm exec vitest run
pnpm run build
pnpm run test:visual

cd ..
git diff --check
```

## Comments

- 2026-08-15：golden baseline 只在最终人工核对后固化；在线 ChatGPT 页面不是 CI 依赖。
- 2026-08-15：真实 Windows Chrome 核对覆盖 final、streaming、share、failed/cancelled/recovered partial、ThinkingBlock、复制、focus-visible 和局部 overflow。发现 share 的 `4rem` 在 15px 根字号下只有 60px，导致正文比另外两个入口窄 4px；已改为明确的 64px gutter，三个入口误差收敛到 1px 内。
- 2026-08-15：用户批准 desktop/mobile 全页候选；已固化 `assistant-rendering-golden-desktop-chrome-win32.png`（507,343 bytes）和 `assistant-rendering-golden-mobile-chrome-win32.png`（451,285 bytes），无更新参数复验通过。性能压力页未进入 golden。
- 2026-08-15：接受两项明确偏差：保留 iChat `#fbfbfa` host canvas（助手 surface 透明），以及在线接口未稳定提取的 390px toolbar 精确坐标改由已批准的本地 mobile golden 固定；未用宽泛 mask 隐藏差异。
- 2026-08-15：最终验证通过：Vitest `72 files / 613 tests`，lint、typecheck、production build、Playwright `3 passed / 1 skipped` 和 `git diff --check`。最终 handover 为 `docs/handover/frontend/2026-08-15-chatgpt-response-rendering.md`。
