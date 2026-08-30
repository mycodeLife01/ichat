# 思考状态标签的流式几何稳定(防再犯记录)

日期:2026-08-31
分支:`fix/reasoning-summary-preview`
主题:`frontend/src/messages/ThinkingBlock.tsx`、`frontend/src/messages/StreamingMessage.tsx`

## TL;DR(给赶时间的 agent)

「正在思考 / 已思考 / 正在搜索…」所在的思考 header 行,**垂直几何(height / padding / margin-top)必须是无条件类**,不得由任何流式状态布尔(如 `hasContent`)翻转。条件类只允许出现在锚定行**下方**(根节点的 `mb-3.5`)或内容 body 上。改动 `ThinkingBlock`、`StreamingMessage` 的接线或新增 `streamPhase` 后,必须用真实 Chrome 沿 phase 时间线采样 `.thinking-label` 的 top 值确认恒定——**jsdom/vitest 单测测不出这类像素位移**。

## 现象

流式回答期间,「正在思考」标签在**第一条 reasoning/summary delta 到达的瞬间**整体下移约 2.8px,之后不再动。不是持续移动,是一次性跳变。

## 根因机制

修复前,`ThinkingBlock` 有两套由 `hasContent` 切换的垂直几何:

| 状态 | 根节点 class | 块高 | 标签 top(相对块顶) |
|---|---|---|---|
| `hasContent=false`(空态) | `thinking collapsed h-7`,行 `h-full` | 28px | 1.2px(`items-center` 垂直居中 25.6px 行盒) |
| `hasContent=true`(有内容) | `thinking collapsed mb-3.5 py-0.5`,行 `py-0.5` | 33.6px | 4.0px(根 2px + 行 2px 内边距) |

(标签高 25.6px = 16px 字号 × 1.6 行高。)

第一条 delta 让 `content` 从 `""` 变非空 → `hasContent` 翻转 → 双几何切换 → 标签下移 4.0 − 1.2 = 2.8px,块高同时 28 → 33.6。

## 回归时间线:为什么恰好在 `fix/reasoning-summary-preview` 分支暴露

1. **main(基线)**:`StreamingMessage` 只把 `run.draftReasoning`(raw)灌给 `ThinkingBlock`。OpenAI 式模型只流 `draftReasoningSummary`、raw 恒空 → 整个思考期 `content === ""` → 恒为 `h-7` → 标签纹丝不动。**组件的稳定当时依赖一个隐式约定:调用方只会在 raw reasoning 场景灌 content。**(DeepSeek raw 路径的跳动此时已存在,属存量问题。)
2. **cf92fc2(model-catalog)**:`content` 改为 `displayedReasoning`(summary 优先、回退 raw)。第一条 summary delta 即翻转 `hasContent`,summary 模型开始跳——此时标签「文字和位置同时变」(文字换成滚动 preview),跳动混在文字替换里,不易察觉。
3. **0a272f2(follow reasoning stream phases)**:无标题 summary 不再把正文提升进 header,标签文字保持「正在思考」不变 → **同样的文字原地向下跳 2.8px**,肉眼变得非常明显。

教训:隐式不变量(「这个组件只会被这样调用」)在上游接线变化时会**静默破坏**;几何稳定必须由组件自身无条件保证,而不是依赖调用方的使用模式。另外,让一个表面变得更静态(修文字抖动)会把潜藏的几何问题暴露出来——改完流式 UI 后应重测几何,而不是认为「只改了文字」。

## 修复

`ThinkingBlock.tsx`:root 与 header 行的 `py-0.5` 改为**无条件**;只有 `mb-3.5` 保留 `hasContent` 条件(它只影响标签下方的空间,不移动标签)。空态块从 28px 变 33.6px,静态差异不可感知;同时顺带修掉了 DeepSeek raw 路径的存量跳动。最终 Message 历史渲染(恒为内容态)几何完全不变。

## 防再犯规则

1. **锚定行几何无条件**:任何由流式 delta 翻转的布尔(`hasContent` / `hasVisibleText` / `toolState !== null` / `open` …)不得切换已渲染锚定元素(header / label / 行盒)自身的 `height` / `padding` / `margin-top`。条件类只允许作用于锚定行**下方**(`margin-bottom`)或内容 body。
2. **接线变更后必测几何**:改 `StreamingMessage → ThinkingBlock` 的任何 props(`content` / `label` / `autoExpandWhileStreaming` / `showStreamingPreview`)、新增 `streamPhase`、或改 `reasoningPreview` 返回非空的时机后,跑下文「真实 Chrome 几何测量」,确认全 phase 标签 top 恒定。
3. **不要用测试固化偶然布局**:修复前 `ThinkingBlock.test.tsx` 有一条断言空态含 `h-7` 的测试——它把有 bug 的双几何**编码成了预期行为**。断言应面向不变量(「跨状态切换几何不变」),而不是某个状态下的偶然 class。现在的测试 `"keeps the streaming header geometry stable across the first reasoning delta"` 就是这个写法(rerender 前后 header 行 className 逐字不变、根节点无 `h-7` 含 `py-0.5`)。
4. **同类风险点**(改这些时同样要测):`open`/`autoExpand` 的展开收起(已有注释说明 `mb-3.5` 不影响 label)、`StreamingMessage` 中 thinking 块的挂载/卸载(已有 leading-whitespace handoff 注释)、`streamPhase` 新增取值。

## 验证方法

### 1. 单元测试(CI)

```bash
cd frontend && pnpm exec vitest run
```

只能守住类名层面(见防再犯规则 3),守不住真实像素。

### 2. 真实 Chrome 几何测量(必做,jsdom 测不出)

在 `frontend/tests/visual/` 下建临时 `.html` + `.tsx` fixture(run 状态构造参考 `assistant-rendering.tsx` 的 `runState`),沿 phase 时间线逐相位 rerender,每步在 `requestAnimationFrame` 后采样:

```js
const block = host.querySelector(".thinking");
const label = host.querySelector(".thinking-label");
label.getBoundingClientRect().top - block.getBoundingClientRect().top; // 必须恒定
```

用 `pnpm exec vite --host 127.0.0.1 --port 4176 --strictPort` 起服务、playwright `chromium.launch()` 驱动页面采样,**结束后删除临时文件**。场景矩阵要覆盖完整 phase 流转:waiting → 首条 summary delta → 工具调用(正在搜索)→ 恢复推理 → 正式回答;summary 与 raw 两条路径都测。

### 3. 判定「回归」还是「存量」

把 `git archive main` 提取的 `frontend/src` 放到 /tmp、软链 `node_modules`、补 `package.json` / `tsconfig*.json`,另起一个端口跑同样的测量,与分支对比。本例正是靠这一步确认「summary 路径是分支新回归、raw 路径是 main 存量」,避免误判修复范围。

### 4. CI 同款检查

```bash
cd frontend
pnpm run typecheck
pnpm run lint
pnpm run build
```

## 修复前后实测数据(desktop-chromium 1440×900)

| 场景 | 修复前标签 top | 修复后标签 top |
|---|---|---|
| summary 路径:waiting → 首条 summary delta | 1.2px → **4.0px(跳变)** | 全程恒定 4.0px |
| raw 路径:waiting → 首条 raw delta(main 上同样存在) | 1.2px → **4.0px(存量跳变)** | 全程恒定 4.0px |

两个场景合计 11 个测量点(含工具调用、恢复推理、正式回答各相位),修复后零位移。

## 相关文件速查

- 几何所在组件:`frontend/src/messages/ThinkingBlock.tsx`(root / header 行 className)
- 流式接线:`frontend/src/messages/StreamingMessage.tsx`(`displayedReasoning`、`label`、`streamPhase` 门控)
- phase 状态机:`frontend/src/runs/state.ts`(`RunStreamPhase`、`run/restored` 推导)
- 标签 shimmer 样式:`frontend/src/styles/global.css`(`.thinking-label`,只有颜色/动画,无几何)
- 同域前案:`docs/handover/2026-07-31-reasoning-preview-not-showing.md`(header 标签优先级与滚动 preview)
