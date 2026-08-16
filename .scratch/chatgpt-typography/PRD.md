# ChatGPT 1:1 文字系统迁移（保留 iChat 品牌字标）

Type: refactor

Status: ready-for-agent

Blocked by: None

日期：2026-08-16

需求来源：对当前 iChat 与 Chrome 中已登录的 ChatGPT 进行真实浏览器对比；产品决定暂不改变 iChat 品牌字标，其余文字系统按 ChatGPT 当前模式 1:1 迁移。

相关计划：.scratch/ui-system-unification/PRD.md。该计划明确把字体体系列为范围外；本计划只负责文字系统，并继续消费其圆角、表面和状态语义，不重新设计这些部分。

## Problem Statement

iChat 当前没有单一、可追溯的文字系统。根节点使用 Inter 栈和 15px 基准，而桌面侧边栏、助手 Markdown、用户消息、Composer、思考区、菜单、Dialog、账户、分享、附件和认证界面又分别叠加不同的字体、字号、行高、字重和颜色。响应式断点还会把部分 14px、15px、16px 文本放大为另一组值。

截至 2026-08-16，frontend/src 中存在：

- 146 处 text-[…px] 任意字号；
- 其中 50 处为 10.5px、11.5px、12.5px、13.5px 等半像素字号；
- 23 处 leading-[…] 任意行高；
- 11 组从 10px 到 22px 的任意字号值；
- 多处组件级字体栈、移动端字号覆盖和相近但不一致的弱文字颜色。

这会导致同一角色在不同页面出现密度、基线、换行和强调关系漂移，也让后续调整只能继续在 JSX 中添加任意值。

真实浏览器对比同时表明：

- 助手 Markdown 正文、H1/H2/H3、列表和表格主体已经非常接近当前 ChatGPT，应优先锁定而不是重做；
- 桌面侧边栏主要文字已经接近 ChatGPT 的 14/20 体系；
- 用户消息、Composer、思考展开正文、菜单与大量次级页面仍使用 iChat 自有的 Inter/15px/半像素组合；
- iChat 品牌字标属于产品身份，不进入本次迁移。

## Goal

除品牌字标外，让 iChat 所有用户可见文字按其语义角色映射到当前 ChatGPT 的文字系统，并在真实 Chrome 中得到相同的 computed typography 与文本节奏。

完成后：

1. 页面内容、控件、菜单、状态、消息、表单和阅读界面统一使用 ChatGPT 当前的 UI 字体栈与角色尺度。
2. 同一语义角色在桌面和移动端不再自行发明字号或行高。
3. 已经对齐的助手正文和桌面侧边栏保持视觉稳定。
4. 所有 iChat 品牌字标的字体、字号、行高、字重、字距、缩放、颜色和几何边界与迁移前完全一致。
5. 业务 JSX 不再直接选择任意像素字号和任意行高，而是消费语义文字令牌。

## 1:1 的定义

本计划中的 1:1 是“文字系统 1:1”，包括：

- font-family 及其回退顺序；
- font-size、line-height、font-weight、letter-spacing；
- 主文字、次级文字、占位符、禁用文字和用户消息前景色；
- 标题、段落、列表、表格、引用与代码的排印节奏；
- 文本换行、断词、省略、截断和响应式字号行为；
- hover、focus、selected、disabled、loading、error 等状态中的文字颜色；
- 由字体度量直接决定的行盒高度、段落间距和阅读节奏。

本计划不复制 ChatGPT 的 DOM、class 名、私有字体文件或品牌资产。ChatGPT 的非品牌 UI 当前解析为系统字体栈，因此不需要引入 OpenAI Sans。OpenAI Sans 只与 ChatGPT 品牌呈现有关，而 iChat 品牌字标明确保持不变。

以下不属于本计划：

- UI 文案内容本身；
- 背景、边框、圆角、阴影、图标和动效；
- 页面布局、信息架构、API、状态机和业务行为；
- 因容器设计不同而产生的非文字几何差异。

允许文字度量改变自然换行和行盒高度，但不得借机改变容器圆角、背景或功能。若精确字号导致已有控件无法容纳文本，应先使用与 ChatGPT 相同的截断或信息层级；不得通过缩小字号绕过问题。

## 品牌字标冻结边界

以下内容视为同一个“iChat 品牌字标”范围，全部冻结：

- frontend/src/ui/Wordmark.tsx；
- Sidebar 展开态 20px 和收起态 18px 的 Wordmark；
- SharePage 桌面 18px、移动 20px 的 Wordmark；
- VerifyEmailPage、ResetPasswordPage、ConfirmAccountDeletionPage 的 18px Wordmark；
- AuthScreen 顶部独立实现的 22px “iChat”品牌标题；
- frontend/src/styles/global.css 中只服务于品牌字标的字体、字距与 transform 规则。

冻结不仅表示“不编辑组件”，还表示迁移前后 computed style 和截图边界不变。全局字体切换不得通过继承间接改变字标。现有 --font-sans 保留给品牌使用；新的非品牌 UI 使用独立的 --font-ui。

## 当前锁定的 ChatGPT 参考

参考环境为 2026-08-16 的 Chrome 当前 ChatGPT 界面，100% 页面缩放。ChatGPT 是可变化的外部产品，因此下表在本计划内是冻结基线；后续 ChatGPT 改版不会自动改变本项目目标。

### 字体与颜色

- UI 字体栈：-apple-system-body, ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif, "Segoe UI Emoji", "Segoe UI Symbol"
- 主文字：#0d0d0d
- 第三级文字与占位符：#8f8f8f
- 禁用文字：#b4b4b4
- 用户消息文字：#0c274a
- 品牌字体和品牌颜色：保持 iChat 当前 computed value，不映射为 ChatGPT
- 等宽代码与 KaTeX：继续使用内容专用字体，但字号、行高、字重和周围节奏按 ChatGPT 参考

### 已确认角色

| 角色 | 字号 / 行高 | 字重 | 颜色 | 迁移规则 |
|---|---:|---:|---|---|
| 普通 UI、Sidebar、菜单、按钮标签 | 14 / 20px | 400 | primary 或 tertiary | 跨桌面与移动一致，不再移动端放大 |
| 分组标题、强调标签 | 14 / 20px | 500 | primary | 不使用 600 代替普通分组强调 |
| Meta、帮助、时间与弱说明 | 12 / 16px | 400 | tertiary | 功能文本下限为 12px |
| Composer 输入正文 | 16 / 26px | 400 | primary | placeholder 使用 tertiary |
| Composer 当前模式/思考等级 | 16 / 26px | 400 | primary | 完整名称保留在菜单或可访问名称中 |
| 用户消息正文 | 16 / 24px | 400 | #0c274a | 编辑态与只读态一致 |
| 助手正文 | 16 / 26px | 400 | #0d0d0d | 当前已对齐，先令牌化再锁定 |
| 思考折叠标签 | 16 / 24px | 400 | #8f8f8f | streaming 不改变字号 |
| 思考展开正文 | 16 / 24px | 400 | #0d0d0d | 不再降为 14/15px muted |
| Markdown H1 | 24 / 32px | 600 | #0d0d0d | 保留当前已对齐节奏 |
| Markdown H2 | 20 / 28px | 600 | #0d0d0d | 保留当前已对齐节奏 |
| Markdown H3 | 18 / 28px | 600 | #0d0d0d | 保留当前已对齐节奏 |
| Markdown H4 | 16 / 24px | 600 | #0d0d0d | 语义降级不缩成 UI 标签 |
| Markdown H5 | 16 / 26px | 600 | #0d0d0d | 保留正文行盒 |
| Markdown H6 | 16 / 26px | 400 | #0d0d0d | 通过语义而非极小字号降级 |
| 表格正文 | 14 / 24px | 400 | #0d0d0d | 保留现有表格阅读密度 |
| 表头 | 14 / 16px | 600 | #0d0d0d | 保留现有表头层级 |
| 行内代码 | 14 / 24px | 500 | 当前代码前景色 | 使用等宽字体 |
| 代码块 | 当前 assistant golden | 当前 assistant golden | 当前语法色 | 只令牌化，不产生视觉变化 |

Dialog、Popover 说明、账户/分享表单、认证生命周期页和附件状态必须在 ticket 01 中逐一映射到上表角色；只有确实不存在对应角色的页面标题，才允许补充新的 ChatGPT 实测角色。不得保留 10.5px 至 13.5px 半像素值作为“特殊情况”。

## Implementation Decisions

### 1. 建立独立的 UI 字体令牌

在 frontend/src/styles/global.css 中新增 --font-ui，并把 ChatGPT 系统栈作为唯一非品牌 UI 字体。保留：

- --font-sans：只服务于 Wordmark 和 AuthScreen 品牌标题；
- --font-mono：代码内容；
- --font-serif：确有内容语义的衬线文本；
- KaTeX 自带的数学字体。

先新增令牌，不立刻切换 html/body。所有主要表面完成迁移后，才把根节点从 15px/Inter 切换为 16px/--font-ui，避免 rem 与继承造成不可控的全局跳变。

### 2. 用语义文字角色替代任意值

在 Tailwind v4 theme 和 frontend/src/ui/classes.ts 中建立少量稳定角色，而不是为每个组件创建一个 class：

- uiText：14/20、400；
- uiLabel：14/20、500；
- metaText：12/16、400；
- controlText：14/20、400；
- composerText：16/26、400；
- userMessageText：16/24、400；
- assistantText：16/26、400；
- reasoningText：16/24、400。

标题、Markdown、表格、代码继续由 global.css 的窄作用域规则消费相同底层令牌。业务 JSX 选择“角色”，不选择 12.5px、13px 或 1.55。

### 3. 先保护已经正确的区域

- .assistant-markdown 当前正文与标题指标作为 golden，第一阶段只把硬编码值映射到令牌；
- .sidebar-desktop 当前 14/20 主体作为回归基线；
- 任何 token 化提交若改变这两处截图，必须先证明变化来自已确认的 ChatGPT 参考，否则回退；
- 品牌字标在所有阶段都必须通过专门的 computed-style 与截图断言。

### 4. 按表面迁移

聊天核心：

- Composer 输入、placeholder、模式选择、菜单和拖放状态；
- 用户消息、消息编辑器、消息操作；
- StreamingMessage、ThinkingBlock、Run 状态、引用、来源、工具与附件；
- 助手 Markdown、表格、引用和代码。

次级界面：

- Sidebar、UserMenu、Dropdown、BottomSheet；
- Toast、VerifyEmailBanner、ConfirmDialog、ModalDialog、ShareDialog；
- AccountCard、MySharesCard、AvatarCropper；
- AuthScreen、ResetPasswordPage、VerifyEmailPage、ConfirmAccountDeletionPage；
- 分享页、附件卡片及上传/解析状态。

### 5. 响应式规则

- 同一角色默认在桌面与移动端保持相同字号和行高；
- 移除 Composer 16→17、ThinkingBlock 14/16→15/17、Sidebar 14→15 等未经 ChatGPT 参考支持的断点放大；
- 触摸目标继续由 padding、min-size 或 bleed 保证，不通过放大字体凑 44px；
- 在 320、375、390/414、768px 视口验证截断和换行；
- 在 200% 浏览器缩放下不得出现文字裁切、控件不可达或横向滚动。

### 6. 文本颜色

本计划只调整文字前景色，不改组件表面色：

- primary 统一为 #0d0d0d；
- tertiary 与 placeholder 统一为 #8f8f8f；
- disabled 统一为 #b4b4b4；
- 用户消息正文统一为 #0c274a；
- error、warning、success 继续消费现有 UI 状态系统的语义 tone，不为模仿 ChatGPT 而丢失业务状态；
- 链接、引用、代码语法色若已在 assistant golden 中对齐，只做令牌化。

如果新前景色在 iChat 现有背景上不满足 WCAG 4.5:1，必须记录为 blocker；不得在本计划内静默修改背景色扩大范围。

### 7. 迁移顺序

1. 锁定 ChatGPT 参考矩阵和 iChat 品牌字标基线。
2. 建立字体、字号、行高、字重和文字颜色令牌。
3. 迁移聊天核心文字。
4. 迁移次级页面和状态文字。
5. 切换根字体并清除遗留任意值。
6. 完成视觉、可访问性和构建验收。

聊天核心与次级页面可以在令牌完成后并行；根字体切换必须等待两者全部完成。

## Testing Decisions

### 自动化 seam

1. 语义 class 只测试角色契约和消费者，不在 jsdom 中断言浏览器字体渲染。
2. 真实字体、字号、行高、字重、字距和颜色使用 Playwright 的 getComputedStyle 断言。
3. 像素节奏、换行和字标边界使用 Playwright screenshot。
4. 助手 Markdown 沿用 assistant-rendering golden，迁移后不应出现无依据 diff。
5. 新增 typography-system visual fixture，集中展示中文、英文、数字、标点、emoji、长单词、长 URL、列表、表格、代码、表单、菜单、状态和所有字标变体。
6. 行为测试继续按可访问角色和用户流程断言，不把 Tailwind class 字符串当作主要契约。

### 浏览器矩阵

- 桌面：1280×800 CSS px，100% zoom；
- 窄屏：768px；
- 移动：320、375、390/414px；
- 可访问性：200% zoom、键盘焦点、文本对比度；
- 文本样本：简体中文、ASCII、数字、emoji、连续英文、长链接和混排。

### 完整验证命令

    cd frontend
    pnpm exec vitest run
    pnpm run lint
    pnpm run typecheck
    pnpm run build
    pnpm run test:visual
    git diff --check

## Out of Scope

- 修改 iChat 品牌字标或把它替换为 ChatGPT/OpenAI 字标；
- 引入、下载、打包或仿制 OpenAI Sans；
- 复制 ChatGPT 品牌资产、DOM、class 名或非公开实现；
- 修改产品文案、路由、信息架构、业务流程、API、数据库或 Run 状态机；
- 修改圆角、背景、边框、阴影、图标或动效；
- 深色模式或多主题；
- 与文字系统无关的 Tailwind、组件或测试重构；
- 因某个控件文本过长而缩小到 ChatGPT 角色表之外的字号。

## Risks and Mitigations

### ChatGPT 外部界面会变化

以 2026-08-16 的实测值和截图作为冻结基线，并记录视口、缩放、状态和 computed style。后续变化只能通过新的产品决策更新本 PRD。

### 根字体切换造成隐性 rem 漂移

根切换放在倒数第二阶段；先确认 @theme 中所有布局尺度是否为固定 px 或已具备明确语义，并用页面截图比较前后差异。

### 中文回退字体跨平台不一致

严格使用 ChatGPT 当前回退顺序；macOS Chrome 为权威视觉环境。CI 不以字形逐像素跨平台一致为前提，但必须断言 CSS computed value 和无裁切。

### 已对齐区域被重复改坏

助手正文、侧边栏和品牌字标在第一张 ticket 中建立 golden；后续每张 ticket 都必须运行对应 visual subset。

### 与 UI system 收口任务发生冲突

.scratch/ui-system-unification/issues/09-conformance-and-visual-acceptance.md 仍可能修改 global.css、classes.ts 和相同视觉 fixture。开始本计划的生产代码修改前，应先确认该 ticket 已完成或没有并行修改；若并行，UI system 只负责表面/状态，本计划只负责 typography，并按文件拆分提交。

## Completion Criteria

1. 除 Wordmark、AuthScreen 品牌标题、等宽代码和数学内容的明确字体外，所有用户可见文字使用 --font-ui。
2. 所有 Wordmark 和 AuthScreen 品牌标题的 computed style、transform、颜色及截图边界与迁移前一致。
3. frontend/src 的业务 JSX 不再出现 text-[10px] 至 text-[17px] 任意像素字号或任意 leading；必要值全部来自语义令牌。
4. 不再存在 10.5px、11.5px、12.5px、13.5px 半像素功能字号。
5. Composer、用户消息、思考区、Sidebar、菜单、Dialog、账户、分享、附件、状态提示和认证页面均能追溯到参考矩阵中的角色。
6. 助手 Markdown golden 无未经确认的视觉变化。
7. 桌面和移动端不存在未经参考支持的响应式字号切换。
8. 中文、英文、数字、emoji、长文本和 200% zoom 下无裁切、遮挡或非预期横向滚动。
9. 主文字达到 WCAG 4.5:1；状态文字继续以语义 tone 和非颜色信息表达。
10. Vitest、lint、typecheck、production build、Playwright visual 和 git diff --check 全部通过。
11. frontend architecture 文档记录新的文字令牌、品牌冻结边界和新增 UI 文本应如何选择角色。

## Ticket Index

| ID | Ticket | Status | Blocked by |
|---|---|---|---|
| 01 | 锁定 ChatGPT 参考矩阵与 iChat 品牌字标基线 | ready-for-agent | None |
| 02 | 建立 ChatGPT 文字令牌与共享角色 | ready-for-agent | 01 |
| 03 | 迁移聊天核心文字系统 | ready-for-agent | 02 |
| 04 | 迁移次级页面与状态文字系统 | ready-for-agent | 02 |
| 05 | 切换全局文字基线并清除遗留覆盖 | ready-for-agent | 03, 04 |
| 06 | 完成视觉验收、可访问性检查与文档收口 | ready-for-agent | 05 |

## Frontier

当前 frontier：01。

完成或阻塞 ticket 时，同时更新本索引和对应 issue 文件的状态；讨论和实测差异追加到 ticket 的 Comments，不覆盖历史。
