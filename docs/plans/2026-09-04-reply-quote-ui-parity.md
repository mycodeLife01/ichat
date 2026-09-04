# 回复引用 UI 对齐与选区交互修正可执行计划

日期：2026-09-04

状态：已实施（2026-09-04；2026-09-05 补充发送后引用换行策略修正；来源跳转范围已由后续计划取代）

后续来源跳转计划：[`docs/plans/2026-09-05-reply-quote-source-navigation.md`](./2026-09-05-reply-quote-source-navigation.md)

原始需求规格：[`docs/specs/2026-08-31-reply-quote.md`](../specs/2026-08-31-reply-quote.md)

原始实施计划：[`docs/plans/2026-08-31-reply-quote.md`](./2026-08-31-reply-quote.md)

当前交接：[`docs/handover/2026-08-31-reply-quote.md`](../handover/2026-08-31-reply-quote.md)

## 执行结果

本计划已完成。最终实现遵守本文冻结的用户可观察行为，并有四项保持既有架构 seam 的等价调整：

1. Selection 时序测试写在生产 `MessageThread` seam，没有为私有 hook 新增测试接口；覆盖稳定 100ms、pointer 选择期间隐藏、scroll 取消和外部 pointer/普通 keyup 后不复活。
2. Composer 外层没有增加 `overflow-clip`，因为现有模型与思考强度菜单是向外展开的 inline absolute surface。引用前导背景改为自身匹配顶部圆角，视觉结果一致且不会裁掉菜单。
3. live/share 长引用对照直接加入既有 `entry-parity` 生产入口，并生成独立截图；进入原有 Windows assistant-rendering golden 前移除 fixture-only user turn，避免改写无关的 Markdown raster 基线。
4. 2026-09-05 使用包含真实 `LF` 的 ChatGPT 引用重新测量后，message 模式从保留强制换行修正为只在布局层折叠空白；原始 excerpt 仍完整保留在 DOM、复制和数据链路中。Composer 不在本次补充修正范围内。

验证结果：

- `pnpm lint`、`pnpm typecheck`、`pnpm build`：通过。
- `pnpm exec vitest run`：77 files、672 tests 通过。
- desktop/mobile 的 `thread-bottom.visual.ts` 和 `assistant-rendering.visual.ts`：全部通过。
- 全量 Playwright：5 passed、2 skipped、1 failed；失败为已知且未修改的 macOS overlay scrollbar 断言。
- 分享 schema/API/service 定向 pytest：46 passed、3 warnings。
- 人工检查 desktop/mobile 的 selection、Composer、sent message 和 live/share parity 截图：通过。

2026-09-05 换行策略补充修正验证：

- 带真实 `LF` 的 message 单元回归和全量 Vitest：77 files、673 tests 通过。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`：通过。
- desktop/mobile 的 `assistant-rendering.visual.ts` 与 `thread-bottom.visual.ts`：4 passed。
- live Piko 实页计算样式与 ChatGPT 对齐为 `white-space: normal`、`overflow-wrap: break-word`、`text-align: center`；完整 `textContent` 仍保留原始 `LF`。

## 背景

回复引用的数据、API、Run 转写、编辑继承和公开分享闭环已经完成，但 UI 验收仍存在四类偏差：

1. 选区浮层在选择仍进行时就出现，且可见尺寸、排版、阴影和定位均大于当前 ChatGPT。
2. 发送后的引用沿用了用户气泡的宽度上限，颜色、hover、字号、图标和最大行数不符合参考。
3. Composer 引用区与输入主体共用白色背景，没有形成 ChatGPT 的顶部次级表面。
4. 回复引用箭头使用了 24px 描边图标，而参考是 20px 填充图标。

本计划是对已完成回复引用功能的增量修正。它取代原始规格和原始计划中与本次验收直接冲突的 UI 决策，但不改变已经上线的数据语义。

## 目标

1. 用户拖动或通过键盘调整选区期间不显示“询问Piko”；选区稳定后约 100ms 展示，且从停止选择到可见不超过 1 秒。
2. 选区浮层的可见几何、排版、颜色、阴影、hover 和选区相对位置与当前 ChatGPT 一致，同时保留至少 44×44 CSS px 的有效命中范围。
3. 发送后的回复引用独立铺满正文列，在桌面 768px 正文列下占 752px，最多显示三行，并使用参考颜色和 hover。
4. Composer 顶部引用区使用次级背景，下方输入主体保持白色；无引用时 Composer 的现有几何不得变化。
5. Composer、live message、pending/server message 和 public share 使用同一 20×20 回复引用图标以及同一 message 视觉原语。
6. 完整 excerpt 继续保存在草稿、请求、消息、Run 和分享快照中；三行限制只发生在 CSS 展示层。
7. 单元测试验证状态和数据，真实 Chrome 测量验证布局、颜色、时序和分享页一致性。

## 不在本次范围内

- 不修改数据库、ORM、API schema、会话服务、Run transcript、SSE 或分享快照结构。
- 本计划当时不增加点击跳转；该范围限定已由 2026-09-05 来源跳转计划取代，其余视觉基线继续有效。
- 不向公开分享响应暴露来源消息 ID，也不在公开分享页增加 Composer、选区动作或私有会话入口。
- 不增加多引用、跨消息引用、跨会话引用、引用展开或引用编辑。
- 不改变用户消息气泡的 `70%` 桌面宽度和 `92%` 移动宽度。
- 不改变附件顺序、引用-only 发送、复制、编辑并重新生成和失败恢复语义。
- 不复制 ChatGPT 的私有 DOM 或 class 名；只复刻浏览器可观察到的交互和计算样式。

## 冻结的参考基线

以下数值来自 2026-09-04 Chrome、浅色模式下对当前 ChatGPT 会话页和分享页的实测。实施时以计算样式和真实布局为事实源，不以旧截图的缩放尺寸为事实源。

### 选区动作

| 属性 | 目标值 |
| --- | --- |
| 展示时机 | 最后一次有效 Selection 变化或 pointer release 后 100ms；选择进行中不可见 |
| 可见高度 | 36px |
| 宽度 | 由“询问Piko”文本和左右各 12px padding 自适应，不使用固定 116px 宽度 |
| 字体 | 14px / 20px，500 |
| 背景 | `#ffffff` |
| 文字 | `#0d0d0d` |
| hover 背景 | `#f9f9f9` |
| 圆角 | 12px |
| 阴影 | `0 8px 12px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.62)` |
| 选区间距 | 4px；优先在选区上方，空间不足翻转到下方 |
| 水平锚点 | 选区外接矩形起始边缘减 4px，并夹在 viewport 内 |
| 可点击范围 | 至少 44×44 CSS px；通过伪元素扩大，不增大可见按钮 |

ChatGPT 实测在四次鼠标选择中于 pointer release 后约 67–102ms 可见。实现常量统一冻结为 `SELECTION_SETTLE_MS = 100`，单元测试验证精确计时，浏览器测试只要求大于等于 80ms 且小于 1,000ms，避免把渲染调度误差写成脆弱断言。

### 发送后引用

| 属性 | 目标值 |
| --- | --- |
| 宿主正文列 | 最大 768px，沿用 `--assistant-content-width` |
| 引用行宽度 | 宿主宽度减 16px；768px 宿主下为 752px |
| 外边距 | 上、下、左、右均为 4px/8px，即 `mt-1 mb-1 mx-2` |
| 布局 | 内容右对齐，箭头在文本左侧，gap 6px |
| 字体 | 14px / 20px，400 |
| 默认颜色 | `#8f8f8f` |
| hover 颜色 | `#0d0d0d`，只改变箭头和文本颜色，不增加背景 |
| 图标 | 20×20，填充 `currentColor` |
| 空白处理 | `white-space: normal`；DOM 保留原始 `LF`，布局时把连续空白折叠为空格 |
| 断词 | `overflow-wrap: break-word`，不使用 `anywhere` |
| 文本对齐 | 居中；引用整体仍由 flex 在正文列内右对齐 |
| 最大高度 | 三行，即 60px；超出只做视觉 clamp |
| 用户气泡 | 继续独立使用现有 `70%` / `92%` 上限 |

ChatGPT 公开分享页对同一类长引用的实测结果为：父列 768px、引用行 752px、文本区域 726px、三行 60px、颜色 `rgb(143, 143, 143)`。2026-09-05 对含多个 `LF` 的会话页引用补测确认：`textContent` 保留换行，`innerText` 折叠为空格，能容纳的引用只产生一个 20px 文本行；长引用再按可用宽度自然换行并在 60px 截断。live 与 share 必须通过同一个生产组件得到这些结果。

### Composer 引用前导区

| 属性 | 目标值 |
| --- | --- |
| 顶部引用背景 | `#f9f9f9` |
| 下方输入主体 | `#ffffff` |
| 单行引用内层最小高度 | 44px |
| 引用内层外侧位置 | 左右和顶部各 4px；前导背景自身匹配 Composer 顶部内沿 |
| 内层 padding | 上下 4px，左右 6px |
| 内容 gap | 6px |
| 图标槽 | 36×36，内部 SVG 20×20 |
| 文本 | `#5d5d5d`，14px / 20px，最多三行 |
| 关闭槽 | 36×36，内部 SVG 20×20；保留“取消引用”可访问名称 |
| 外层 | 保留现有 Composer 宽度、圆角、边框、阴影和 overflow；前导背景以自身圆角避免溢出 |

引用超过一行时，前导区随文本增长，但最多只为三行文本分配高度。无引用时不得渲染空的次级背景区域。

### SVG

回复引用箭头固定为 `viewBox="0 0 20 20"`、`fill="currentColor"`、无 stroke，并使用以下 path：

```text
M12.53 6.53a.666.666 0 0 1 .836-.086l.105.085 4 4c.26.26.26.682 0 .942l-4 4a.666.666 0 0 1-.942-.942l2.865-2.864H6A3.665 3.665 0 0 1 2.335 8V4.5a.665.665 0 0 1 1.33 0V8A2.335 2.335 0 0 0 6 10.335h9.394l-2.865-2.864-.085-.105a.666.666 0 0 1 .085-.837
```

Composer 关闭图标同步使用 20×20 的填充版本，避免 20px 回复箭头旁继续出现视觉重量不同的描边或 21px 图标。

## 主要改动文件

| 文件 | 职责 |
| --- | --- |
| `docs/specs/2026-08-31-reply-quote.md` | 修正与本次验收冲突的 Composer 背景、发送后三行和选择稳定期规则 |
| `docs/plans/2026-08-31-reply-quote.md` | 增加本计划的后续修正链接，不重写历史实施记录 |
| `docs/handover/2026-08-31-reply-quote.md` | 记录验收未通过项和本计划入口 |
| `frontend/src/messages/useReplyQuoteSelection.ts` | Selection 候选读取、稳定期计时、取消和发布状态机 |
| `frontend/src/messages/ReplyQuoteSelectionAction.tsx` | 36px 浮层、命中伪元素、参考定位和阴影 |
| `frontend/src/messages/ReplyQuote.tsx` | composer/message 两种视觉变体、三行 clamp、颜色和宽度 |
| `frontend/src/messages/Message.tsx` | live/pending 用户 turn 的引用宿主宽度与移动交互回归 |
| `frontend/src/messages/SharePage.tsx` | public share 使用与 live 相同的 message 宿主几何 |
| `frontend/src/ui/Composer.tsx` | 将引用前导区与白色输入主体拆层 |
| `frontend/src/ui/classes.ts` | 保持通用 Composer surface 不变；引用背景与圆角留在局部生产组件 |
| `frontend/src/ui/icons.tsx` | 替换 ReplyArrow，并按需增加专用 20px Cross |
| `frontend/src/styles/global.css` | 增加语义化回复引用颜色和浮层阴影 token |
| `frontend/src/messages/MessageThread.test.tsx` | 更新 Selection 集成测试，不再断言立即展示 |
| `frontend/src/messages/Message.test.tsx` | 发送后引用结构、完整 excerpt 和复制回归 |
| `frontend/src/messages/SharePage.test.tsx` | 匿名分享引用结构与无私有动作回归 |
| `frontend/src/ui/Composer.test.tsx` | 引用区拆层、关闭、引用-only 与草稿完整性回归 |
| `frontend/tests/visual/thread-bottom.visual.ts` | 真实选区时序、浮层、Composer 和发送后几何测试 |
| `frontend/tests/visual/assistant-rendering.tsx` | 增加 live/share 长引用对照 fixture |
| `frontend/tests/visual/assistant-rendering.visual.ts` | 计算样式一致性和截图验收 |

---

## 阶段 0：修正规范和基线

### 0.1 更新规格中的冲突项

修改 `docs/specs/2026-08-31-reply-quote.md`：

- [ ] 在 Selection 生命周期中增加“选择进行中隐藏、稳定 100ms 后发布”的规则。
- [ ] 将“Composer 不得增加额外背景”改为“不得增加卡片边框或标题，但引用前导区使用 `#f9f9f9`，输入主体为 `#ffffff`”。
- [ ] 将“发送后展示完整快照并自然换行”改为“DOM、数据与复制仍保留完整快照，默认视图最多三行”。
- [ ] 增加发送后引用默认色、hover 色、14/20 排版、20px 图标和正文列宽度要求。
- [ ] 明确 public share 复用 message variant，但没有来源 ID、跳转和私有动作。
- [ ] 将本次计划加入规格的实施链接。

### 0.2 保留历史文档语义

- [ ] 在 `docs/plans/2026-08-31-reply-quote.md` 顶部增加“UI 验收修正见本计划”的链接，不把原计划伪装成尚未实施。
- [ ] 在 `docs/handover/2026-08-31-reply-quote.md` 增加一个验收后续章节，列出四个偏差和本计划链接。
- [ ] 不改写数据、API、转写和回滚章节。

### 完成门

- 文档中不再同时存在“发送后完整展开”和“发送后最多三行”两套相反验收标准。
- 文档中不再同时存在“Composer 无额外背景”和“引用区背景不同”两套相反标准。

---

## 阶段 1：先建立失败测试

### 1.1 Selection 状态机测试

在生产入口 `frontend/src/messages/MessageThread.test.tsx` 使用 fake timers 和可控 Selection/Range，避免为私有 hook 新增测试 seam：

- [ ] `selectionchange` 后 99ms 不发布候选，第 100ms 发布。
- [ ] pointer 按下并拖动期间，即使连续发生有效 `selectionchange`，推进超过 1 秒也不发布。
- [ ] pointer release 后从最新有效选区重新开始 100ms 计时。
- [ ] 稳定期内再次发生 `selectionchange` 时取消旧 timer，并从零重新计时。
- [ ] 键盘 `Shift+Arrow` 产生的 Selection 在最后一次变化后 100ms 发布。
- [ ] Escape、外部 pointer、捕获阶段 scroll、resize、选区 collapse、conversationId 变化和卸载都清除可见候选、待发布候选与 timer。
- [ ] 点击 `[data-reply-quote-action]` 不被外部 pointer 逻辑提前关闭，并继续提交完整 excerpt。
- [ ] 跨消息、排除区、空白文本、零面积 Range 和非 final assistant 选区始终不发布。

更新 `frontend/src/messages/MessageThread.test.tsx`：

- [ ] 删除“触发 selectionchange 后立即 findByRole”的隐式等待逻辑。
- [ ] 保留一条从有效选区到 `onReplyQuote(sourceMessageId, excerpt)` 的生产入口集成测试。

### 1.2 组件和分享测试

- [ ] `ReplyQuote` message variant 的 DOM 包含完整 excerpt，但应用三行视觉 clamp。
- [ ] message variant 不再包含 `max-w-[70%]` 或移动端 `max-w-[92%]`。
- [ ] Composer 有独立的 `data-reply-quote-region` 和 `data-composer-body` 测量缝，不以测试专用组件替代生产 DOM。
- [ ] `Composer.test.tsx` 证明关闭引用只移除引用并恢复输入焦点，不改变 prompt 和附件。
- [ ] 引用-only 仍可发送，提交给回调的 excerpt 未被三行预览截断。
- [ ] `Message.test.tsx` 继续证明复制有用户 prompt 时只复制 prompt，无 prompt 时复制完整 excerpt。
- [ ] `SharePage.test.tsx` 证明只收到 excerpt 的匿名 DTO 也能渲染同一 message variant，且没有来源链接、编辑、删除或替换动作。

### 完成门

- 新增和修改的测试在实现变更前按预期失败。
- 失败原因分别指向即时展示、错误可见高度、70% 宽度、无三行 clamp、无背景分层和错误 SVG，而不是 fixture 或 mock 初始化错误。

---

## 阶段 2：实现 Selection 稳定期状态机

### 2.1 分离“读取”和“发布”

在 `useReplyQuoteSelection.ts` 中把当前 `evaluate()` 拆为：

```ts
readSelectionCandidate(): ReplyQuoteSelectionCandidate | null
clearPendingCandidate(): void
scheduleCandidate(candidate: ReplyQuoteSelectionCandidate): void
publishCandidateIfStillValid(): void
```

规则：

- `readSelectionCandidate()` 是无 React 写入的读取函数，继续执行同消息、排除区、空白文本和几何校验。
- 使用 `range.getBoundingClientRect()` 作为选区外接矩形，使水平定位基于整个选区的起始边缘；零面积时回退到非空 `getClientRects()`，仍无面积则拒绝。
- effect 闭包保存唯一 settle timer 和当前 pointer selection 标记，不把它们放入 reducer 或 localStorage。
- timer 到期时重新读取 Selection；Selection 已变化、折叠或失效时不得发布旧候选。
- 所有清理路径必须同时清除 React candidate、pending ref 和 timer。

### 2.2 事件顺序

使用以下状态转换，不允许多个事件各自直接 `setCandidate()`：

```text
eligible pointerdown
  -> 隐藏现有动作
  -> pointerSelecting = true
  -> 取消 settle timer

selectionchange while pointerSelecting
  -> 更新 pending candidate
  -> 不启动 timer，不展示

pointerup
  -> pointerSelecting = false
  -> 重新读取 Selection
  -> 有效则启动 100ms timer，无效则全部清理

selectionchange without active pointer
  -> 重新读取 Selection
  -> 有效则重启 100ms timer，无效则全部清理

timer fires
  -> 再次校验 Selection
  -> 仍与 pending candidate 一致才发布
```

补充约束：

- [ ] pointerdown 发生在非 eligible assistant 内容中时只执行关闭，不在 pointerup 后重新展示旧选区。
- [ ] pointerdown 发生在浮层按钮内时保留 native Selection，交给按钮自身处理。
- [x] `pointercancel` 按取消处理，避免拖动中断后遗留候选。
- [ ] scroll 使用 capture 监听，任何祖先滚动都立即关闭并取消 timer。
- [ ] cleanup 必须 `clearTimeout`，避免卸载后 setState。

### 完成门

- 阶段 1.1 的状态机测试全部通过。
- React 测试无 `act()`、卸载后写入或 fake timer 泄漏警告。

---

## 阶段 3：对齐选区浮层

修改 `ReplyQuoteSelectionAction.tsx`：

- [ ] 删除默认 `{width: 116, height: 48}`；初始测量使用 36px 高度和基于内容的宽度，挂载后再以真实 rect 校正。
- [ ] 可见按钮使用 `h-9 px-3 text-[14px] leading-5 font-medium rounded-[12px]`。
- [ ] 删除 `border-border-strong` 和通用 `shadow-popover`，使用专用参考阴影。
- [ ] hover 只把背景改为 `#f9f9f9`；保留键盘 `focus-visible` 轮廓。
- [ ] 增加 `::before` 命中伪元素，使 36px 可见高度得到至少 44px 命中高度。
- [ ] `left` 改为 `clamp(4px, selection.left - 4px, viewportWidth - width - 4px)`，不再 `translateX(-50%)` 居中。
- [ ] `top` 优先为 `selection.top - height - 4px`，空间不足时使用 `selection.bottom + 4px`。
- [ ] viewport resize 后仍按既有产品规则关闭，不实时漂移浮层。
- [ ] 进入/退出动效不得改变固定几何，并继续尊重 `prefers-reduced-motion`。

在 `global.css` 增加语义 token：

```css
--color-reply-quote-action-foreground: #0d0d0d;
--color-reply-quote-action-hover: #f9f9f9;
--shadow-reply-quote-action:
  0 8px 12px rgba(0, 0, 0, 0.08),
  0 0 1px rgba(0, 0, 0, 0.62);
```

不得修改通用 `--shadow-popover`，避免影响菜单、模型选择器和对话框。

### 完成门

- 可见 rect 高度严格为 36px，宽度随“询问Piko”自适应。
- `::before` 的计算宽高或浏览器 hit test 证明有效目标至少 44×44px。
- 桌面和 390px viewport 下均不出界，顶部空间不足时正确翻转。

---

## 阶段 4：统一图标和 ReplyQuote 原语

### 4.1 图标

修改 `frontend/src/ui/icons.tsx`：

- [ ] 把 `replyArrowIcon` 默认尺寸改为 20。
- [ ] 使用冻结的 20×20 填充 path，删除 stroke、strokeWidth、strokeLinecap 和 strokeLinejoin。
- [ ] 修正错误的 scroll-to-latest 注释，说明该图标仅用于 reply quote。
- [ ] 如现有 `Icons.Close` 不是参考填充版本，增加专用 `ReplyQuoteClose`，不要全局替换其他关闭按钮图标。

### 4.2 语义颜色

在 `global.css` 增加：

```css
--color-reply-quote-message: #8f8f8f;
--color-reply-quote-message-hover: #0d0d0d;
--color-reply-quote-composer: #5d5d5d;
--color-reply-quote-region: #f9f9f9;
```

不得用 `text-text-muted` 代替这些值；通用 muted token 仍服务其他 UI。

### 4.3 message variant

修改 `ReplyQuote.tsx` 的 `message` 分支：

- [ ] 根元素使用 `mx-2 mt-1 mb-1 w-[calc(100%-1rem)]`，不再使用 `max-w-[70%]` 或移动 `92%`。
- [ ] 根元素 `justify-end items-start gap-1.5 text-[14px] leading-5 font-normal`。
- [ ] 默认颜色为 reply quote message token，hover 时根元素、箭头和文字一起变为 message hover token。
- [ ] SVG 固定 20×20，不能由调用方传回 24。
- [x] excerpt 使用 `whitespace-normal [overflow-wrap:break-word] text-center` 和三行 WebKit clamp；原始 `LF` 保留在 DOM 中，只在消息布局阶段折叠为空格。
- [ ] 完整 excerpt 仍作为 DOM text content 和复制来源；不在组件中 slice、truncate 或生成替代字符串。
- [ ] 根元素继续使用非交互语义，不伪造无 onClick 的 button；本次只复刻 hover 视觉，不新增跳转。

### 4.4 composer variant

修改 `ReplyQuote.tsx` 的 `composer` 分支：

- [ ] 根元素只负责内部一行布局，不自行决定 Composer 外层背景。
- [ ] 使用最小高度 44px、`px-1.5 py-1`、gap 6px。
- [ ] 左侧图标槽和关闭槽均为 36×36，SVG 为 20×20。
- [ ] 文本使用 14/20、composer token、最多三行。
- [ ] 关闭按钮保留至少 44×44 命中范围、`aria-label="取消引用"` 和 focus-visible；不保留当前圆形灰底 hover，除非重新实测参考出现该背景。

### 完成门

- Composer、message 和 share 中 `[data-icon="reply-arrow"]` 的 rect 都是 20×20、viewBox 都是 `0 0 20 20`、fill 都为当前文字颜色。
- 长 excerpt 在 DOM 中仍完整，但 Composer 和 message 计算高度最多分别包含三行文本。

---

## 阶段 5：拆分 Composer 表面

当前 Composer 自身既是 grid 又拥有统一 `px-2 py-[5px]`，直接给引用行加背景会在四周留下白色沟槽。实施时必须拆分结构，而不是增加一条局部 `bg-sunken` class。

### 5.1 目标 DOM

保持 `composerRef`、`data-testid="composer"`、拖放和 expanded 状态在最外层：

```text
composer outer: width/radius/border/shadow，保持 overflow visible
  reply quote prelude（仅 replyQuote 非空时）: #f9f9f9
    ReplyQuote variant=composer
  composer body: #ffffff + 原 grid + 原 px-2/py-[5px]
    attachments（若存在）
    prompt and controls
```

### 5.2 约束

- [ ] 把 grid 和原 padding 移到 `data-composer-body`；最外层不再以公共 padding 包住引用区。
- [x] 最外层保持 overflow visible，引用前导背景自身使用与 Composer 内沿匹配的顶部圆角，避免裁掉 inline absolute 模型菜单。
- [ ] `data-reply-quote-region` 使用 `#f9f9f9`，其内部引用行左右和顶部各留 4px，底部与白色主体直接衔接。
- [ ] 引用内层圆角使用顶部 24px、底部 8px；背景通过父层或伪元素延伸到外层顶部，不出现白色边缝。
- [ ] 无 replyQuote 时完全不渲染 prelude，body 的 padding、输入框 y 坐标和 Composer 总高度与修改前一致，允许 1px 测量误差。
- [ ] 有附件无引用时保持当前附件位置和 Composer 高度。
- [ ] 同时有引用和附件时顺序仍为引用、附件、prompt；附件保留白色 body 背景。
- [ ] prompt 扩展、拖放遮罩、模型菜单定位、发送/停止按钮和 mobile safe area 均继续以外层 composer 为锚点。
- [x] 现有 fixed/portal 菜单和 inline absolute 模型菜单继续可见。

### 完成门

- 有引用时顶部和下方主体的计算背景分别为 `rgb(249, 249, 249)` 与 `rgb(255, 255, 255)`。
- 背景在四个圆角内无溢出、无 1px 白缝。
- 无引用 Composer 的宽度、高度、输入框和控制按钮坐标与基线一致。

---

## 阶段 6：live、pending/server 和 share 几何一致

### 6.1 live message

修改 `Message.tsx`：

- [ ] 保留引用位于用户气泡上方的结构。
- [ ] 引用宿主继续是 `w-full`，由 `ReplyQuote` 自身产生左右 8px margin 和正文列减 16px的宽度。
- [ ] 用户气泡继续使用现有 70%/92% 上限，不能随引用变宽。
- [ ] pending message、服务端接管后的 message 和编辑态读取同一个 message variant。
- [ ] 移动端长按、contextmenu 抑制和复制操作不能因为引用变成全宽而改变命中目标。

### 6.2 public share

修改 `SharePage.tsx`：

- [ ] 引用的直接父容器宽度与 live 的正文列相同。
- [ ] 使用同一个 `ReplyQuote variant="message"`，不增加 share 专用颜色、宽度或 clamp。
- [ ] quote-only 分享 turn 仍只显示引用，不生成空白气泡。
- [ ] 保持匿名 DTO 只有 excerpt；没有来源链接、内部 ID、编辑、删除、替换或跳转。
- [ ] share 的 hover 颜色与 live 相同，但元素仍是非交互语义。

### 完成门

- 对相同 excerpt，live 与 share 的 width、height、font-size、line-height、color、gap、margin、line clamp 和 SVG rect 全部一致。
- 桌面父列为 768px 时两者引用行都为 752px；窄屏时都等于可用父宽减 16px。

---

## 阶段 7：真实 Chrome 验收

### 7.1 thread-bottom 交互测试

重写 `frontend/tests/visual/thread-bottom.visual.ts` 中的回复引用段落：

- [ ] 使用真实 `page.mouse` drag 或可产生 pointerdown/move/up 的辅助函数选择文本，不只用 `Range + selectionchange` 绕过用户手势。
- [ ] pointerdown 后拖动到 pointerup 前，持续断言“询问Piko”不可见。
- [ ] 在页面内用 `performance.now()` 记录 pointerup 和浮层首次插入时间，断言差值 `>= 80ms && < 1000ms`。
- [ ] 删除当前“可见 action 高度至少 44px”的错误断言，改为可见 rect 高 36px。
- [ ] 通过 `getComputedStyle(element, "::before")` 或 `elementFromPoint` 验证伪元素命中范围至少 44×44px。
- [ ] 验证字体 14/20、圆角 12px、左右 padding 12px、背景、hover 和专用 shadow。
- [ ] 验证浮层相对选区起始边缘和 4px 垂直间距，覆盖顶部翻转和 viewport 右边缘夹取。
- [ ] 点击后验证 Composer 两层背景、20px 图标、36px 槽和完整 excerpt。
- [ ] 使用超过三行的 excerpt 发送，验证引用行宽度为 turn 宽减 16px、高度不超过 60px、默认色和 hover 色正确。
- [ ] 验证气泡仍不超过 turn 宽度的 70%/92%，且页面无横向滚动。

### 7.2 live/share 对照 fixture

扩展 `frontend/tests/visual/assistant-rendering.tsx`：

- [x] 在既有 `data-testid="entry-parity"` section 增加 long reply quote user turn，并为它生成独立截图 artifact。
- [ ] section 同时渲染生产 `MessageThread → Message` 和生产 `SharePage`，两边使用同一段足够产生四行以上的 excerpt 和同一用户 prompt。
- [ ] fixture 的两列提供相同可用内容宽度，避免把 fixture 外壳宽度差异误判为组件差异。
- [ ] share service fixture 仍返回真实匿名 share DTO，不直接渲染 `ReplyQuote` 绕过生产入口。

更新 `frontend/tests/visual/assistant-rendering.visual.ts`：

- [ ] 分别读取 live/share 引用、文本、SVG、父列和用户气泡 rect。
- [ ] 比较两边所有计算样式和几何；允许 x/y 不同，不允许宽高和排版不同。
- [ ] 验证两边均三行、默认色相同，hover 后均变为 `#0d0d0d`。
- [ ] 在 desktop-chrome 和 mobile-chrome 项目都执行。
- [ ] 人工检查新截图后才更新 golden，不使用 mask 隐藏引用区域差异。

### 完成门

- 两个 Playwright 项目均通过。
- 测试附件中保存 selection timing、popover geometry、composer surfaces、sent quote geometry 和 live/share parity JSON。
- 桌面与移动截图中无溢出、背景接缝、图标偏移或用户气泡宽度回归。

---

## 阶段 8：完整验证

### 定向前端测试

```bash
cd frontend
pnpm exec vitest run \
  src/messages/MessageThread.test.tsx \
  src/messages/Message.test.tsx \
  src/messages/SharePage.test.tsx \
  src/ui/Composer.test.tsx
```

### 定向真实浏览器测试

```bash
cd frontend
pnpm exec playwright test tests/visual/thread-bottom.visual.ts --project=desktop-chrome
pnpm exec playwright test tests/visual/thread-bottom.visual.ts --project=mobile-chrome
pnpm exec playwright test tests/visual/assistant-rendering.visual.ts --project=desktop-chrome
pnpm exec playwright test tests/visual/assistant-rendering.visual.ts --project=mobile-chrome
```

### 前端全量门

```bash
cd frontend
pnpm lint
pnpm typecheck
pnpm exec vitest run
pnpm build
pnpm exec playwright test
```

### 分享 contract 安全回归

本次不修改后端，但公开分享是验收面，因此运行最小相关回归：

```bash
uv run pytest -q \
  tests/schemas/test_conversation_schemas.py \
  tests/api/test_shares.py \
  tests/services/shares/test_share_service.py
```

### 工作区检查

```bash
git diff --check
git status --short
```

### 完成门

- 所有定向和全量检查通过。
- 若存在与本次改动无关的既有失败，必须记录完整命令、错误、基线证据和剩余风险，不能只写“环境问题”。
- `git status --short` 中不得出现意外生成物、Playwright 临时输出或新的包管理器 lockfile。
- 不修改 `pnpm-lock.yaml`，除非实施中确实增加依赖；本计划不需要新依赖。

## 验收追踪矩阵

| 验收项 | 单元/组件证据 | 真实浏览器证据 |
| --- | --- | --- |
| 选择过程中不展示 | Selection hook fake timer + pointer 状态测试 | mouse drag 在 pointerup 前不可见 |
| 停止选择后 1 秒内展示 | 100ms timer 精确测试 | `performance.now()` 差值 80–999ms |
| 浮层 1:1 样式 | 结构和 token 测试 | 36px、14/20、12px 圆角、padding、shadow、hover 实测 |
| 发送后横向铺满 | message variant 不含气泡上限 | 引用宽 = 父列宽 - 16px |
| 发送后颜色和 hover | 语义 token | `#8f8f8f → #0d0d0d` |
| 发送后最高三行 | clamp 结构且完整 DOM 文本 | 文本高不超过 60px |
| Composer 背景分层 | region/body 结构测试 | `#f9f9f9` 与 `#ffffff` 计算样式 |
| SVG 1:1 | viewBox/path/默认 size 测试 | 三个入口 SVG rect 均为 20×20 |
| 分享页一致 | SharePage 生产入口测试 | live/share 计算样式逐项相等 |
| 完整 excerpt 未损失 | Composer/Message/复制测试 | 发送后 DOM 数据与提交 payload 证据 |

## 风险与防护

### Selection 事件竞态

风险：`selectionchange` 可能发生在 pointerup 前后多次，旧 timer 会让浮层闪现或复活。

防护：只保留一个 timer；timer 到期必须重新读取并比对 Selection；所有关闭路径同时清理可见、pending 和 timer 三层状态。

### Composer 几何回归

风险：把 grid 移入 body 后影响 textarea 自动高度、附件位置、菜单锚点或底部 safe area。

防护：保留 composerRef 在外层；对无引用、有附件、有引用、引用+附件、长 prompt 五种状态分别测量；无引用状态坐标误差不得超过 1px。

### 全宽引用扩大移动端手势区域

风险：live message 的长按、复制或 contextmenu 行为因引用从 70% 变成全宽而改变。

防护：继续由现有 user turn 宿主处理移动事件；在 mobile-chrome 运行长按和横向溢出回归。

### 分享页泄露或行为扩张

风险：为了复制 ChatGPT 的 button hover，误加来源跳转或要求 share DTO 暴露来源 ID。

防护：message variant 保持非交互语义，只应用 hover 颜色；分享 contract 测试继续断言没有来源 ID 和私有动作。

### 通用 token 污染

风险：修改 `text-muted`、`shadow-popover` 或 `composerSurface` 后影响非引用 UI。

防护：新增 reply quote 专用 token；不修改通用 muted、popover shadow 或 Composer surface。

## 回滚策略

本计划不改变数据和 API，因此可以按前端层次独立回滚：

1. 先禁用新的 Selection 浮层展示，但保留已经发送的引用渲染。
2. 如 Composer 分层存在阻断问题，只回滚 Composer DOM 分层，保留 message 三行和新图标。
3. 如 message 全宽在移动端存在严重问题，只回滚 message 布局，不删除 excerpt 字段或 share 渲染能力。
4. 任何回滚都不得退回到不认识 reply quote 的旧前端，否则 quote-only turn 会显示为空白。

## Definition of Done

- [x] 规格、原计划、交接和本计划不存在互相冲突的 UI 验收描述。
- [x] 拖动选择时浮层不可见；停止后约 100ms、最迟 1 秒内出现。
- [x] 浮层可见高度 36px，命中范围至少 44×44px，样式和定位满足冻结基线。
- [x] 发送后引用铺满正文列减 16px，折叠原始换行后自然排版，最多三行，颜色和 hover 正确。
- [x] Composer 引用区与输入主体背景不同，无引用时 Composer 几何无变化。
- [x] 所有回复引用箭头均为同一 20×20 填充 SVG。
- [x] live、pending/server、刷新恢复和 public share 使用相同 message variant。
- [x] 完整 excerpt 在草稿、提交、复制和分享展示链路中未被截断。
- [x] desktop-chrome 和 mobile-chrome 定向测试通过；全量测试仅保留已知且无关的 macOS overlay scrollbar 失败。
- [x] 前端 lint、typecheck、完整 Vitest、production build 和分享后端定向回归通过。
- [x] 最终交接记录实际执行命令、测试结果、截图/测量附件和未完成风险。
