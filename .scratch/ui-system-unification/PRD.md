# 全局 UI 设计系统统一：圆角与状态颜色

Type: refactor
Status: ready-for-agent
Blocked by: None

日期：2026-07-23
需求来源：全项目前端 UI 审计、ChatGPT 实际界面研究，以及改造前后静态/交互原型评审
术语依据：根目录 `CONTEXT.md`（会话、Run、邮箱验证、注销、停用）

## Problem Statement

作为 iChat 用户，我在侧边栏、菜单、Composer、消息、账号、分享和认证页面中会遇到多套彼此不一致的圆角与状态颜色：同一层级的按钮、列表项、卡片和弹窗使用不同圆角；普通、成功和失败操作有时呈现为相同的黑色 Toast，有时又分别使用硬编码的绿色、红色或灰色；部分成功/提醒样式引用了未定义的主题颜色，因此实际界面不能稳定表达状态。

作为前端维护者，我无法根据组件角色和业务语义直接选择一个确定的样式原语，只能在组件内重新挑选 Tailwind 圆角、背景色、文字色、遮罩和阴影。这造成重复的任意值、接近但职责重叠的 danger 色、难以全局调整的视觉决策，以及测试对具体 utility class 的脆弱依赖。

当前生产代码共有约 100 处圆角声明、12 种 Tailwind 圆角写法，实际固定值覆盖多个没有正式命名的层级。现有主题只覆盖部分基础圆角和颜色；成功、警告、失败、危险操作与普通交互尚未形成完整、可复用、可访问的状态系统。

## Solution

参考 ChatGPT 的设计逻辑而非逐像素复制其品牌外观，为 iChat 建立一套以“组件层级”和“状态语义”为核心的前端设计系统：

1. 建立语义圆角层级，让细节、控件、交互项、浮层、卡片、Dialog、Composer 和 pill 各自拥有稳定角色。
2. 建立中性优先的颜色系统：普通、hover、selected、disabled 使用灰阶；成功、失败、提醒和危险操作只在语义真正需要时使用状态颜色。
3. 扩展全局通知状态，使 Toast 在数据层携带明确 tone，并根据 tone 输出图标、颜色和可访问性角色。
4. 提供统一的行内状态组件，覆盖持续成功、字段/表单失败、Run 失败和提醒状态。
5. 统一 Dropdown、UserMenu、BottomSheet、Dialog、按钮、输入框和 Composer 的交互状态与表面层级。
6. 将所有业务组件迁移到共享令牌和共享样式原语，移除 UI JSX 中的硬编码颜色、重复任意圆角和 inline danger 覆盖。
7. 保留现有功能、路由、API、文案意图与响应式信息架构；本次只改变视觉和状态表达层。

预期结果是：开发者先判断“这是哪一类组件、发生了哪一种状态”，再由设计系统决定圆角与颜色；业务组件不再直接选择红色、绿色或具体圆角数值。

## User Stories

1. 作为聊天用户，我希望侧边栏会话项、用户区域和菜单项使用一致的 hover 与圆角，以便它们看起来属于同一交互家族。
2. 作为聊天用户，我希望 Dropdown 的内部 item 圆角低于 Dropdown 容器圆角，以便浮层层级清楚而不显得所有元素都是同一种胶囊。
3. 作为聊天用户，我希望 Card、Dialog 和 Composer 的圆角按表面独立程度递增，以便快速理解哪些内容是列表项、浮层或核心操作区。
4. 作为聊天用户，我希望普通选中状态保持中性灰阶，以免把“当前选中”误读为“操作成功”。
5. 作为聊天用户，我希望“链接已复制”“昵称已更新”等短暂成功反馈保持克制，同时有明确的 Check 图标，以便确认动作成功但不被大块绿色打断。
6. 作为聊天用户，我希望“邮箱已验证”等持续成功状态使用稳定的成功样式，以便一眼识别已经成立的账户事实。
7. 作为聊天用户，我希望发送、复制、撤销或保存失败时看到区别于普通提示的错误反馈，以便及时采取重试行动。
8. 作为聊天用户，我希望 Run 失败在消息上下文中持续显示，而不是只出现一个短暂 Toast，以便失败状态不会在我阅读前消失。
9. 作为聊天用户，我希望字段错误显示在对应输入框附近，并说明发生了什么以及如何修正，以便不用猜测失败原因。
10. 作为聊天用户，我希望“邮箱未验证”等提醒与删除错误使用不同颜色和文案，以便提醒不被误解为已经失败。
11. 作为聊天用户，我希望删除、注销等危险操作默认只在文字和图标上使用红色，并在 hover 时出现浅红背景，以便危险性明确但界面不过度警报化。
12. 作为聊天用户，我希望只有最终、不可逆的确认按钮使用实心红色，以便最危险的一步具有最高视觉权重。
13. 作为移动端用户，我希望 BottomSheet 的圆角、菜单项和危险项规则与桌面 Dropdown 一致，以便跨设备体验连续。
14. 作为移动端用户，我希望所有可触达控件具备足够的触摸目标，并且不依赖 hover 才能发现操作。
15. 作为键盘用户，我希望每个按钮、菜单项、输入框和 Composer 都有清晰的 focus-visible 状态，以便知道当前焦点位置。
16. 作为屏幕阅读器用户，我希望普通/成功通知使用 status，失败通知使用 alert，并且状态不只通过颜色表达，以便及时获得正确语义。
17. 作为低视力用户，我希望正文、状态文字、图标和焦点环满足相应对比度，以便在不同显示设备上仍可辨认。
18. 作为用户，我希望 disabled 控件同时通过透明度、颜色和不可用行为表达状态，以便不会误以为界面失效。
19. 作为用户，我希望 loading 控件保留可理解的标签或进度图标，以便知道操作仍在进行。
20. 作为前端开发者，我希望从语义圆角令牌中选择组件角色，而不是在 JSX 中重新输入 10px、14px 或 18px，以便全局调整时只修改一处。
21. 作为前端开发者，我希望普通、成功、失败、提醒和危险操作拥有明确的颜色角色，以便新增组件时不再自行发明色值。
22. 作为前端开发者，我希望 Toast action 强制携带 tone，以便成功和失败不会在状态层被压扁成相同的 message。
23. 作为前端开发者，我希望共享菜单、按钮、状态提示和表面原语成为单一事实源，以便 Sidebar、UserMenu、Composer 和账号页面不会再次漂移。
24. 作为前端开发者，我希望业务 JSX 中不再出现 UI 用十六进制色、rgba 遮罩和 inline danger style，以便主题检查和代码审查可以机械化。
25. 作为前端开发者，我希望现有功能测试继续通过，并用用户可见行为而不是 Tailwind utility 名验证状态，以便后续样式重构不需要大面积修改测试。
26. 作为设计维护者，我希望能从一张明确的圆角与颜色决策表中评审全项目组件，以便未来修改有一致依据。
27. 作为设计维护者，我希望 ChatGPT 只作为交互层级与状态克制原则的参考，而不是复制品牌标识和所有像素值，以便 iChat 保留自身产品身份。
28. 作为项目维护者，我希望本次改造不触及后端、数据库、API 或 Run 状态机，以便可以作为独立前端迭代发布和回滚。
29. 作为项目维护者，我希望改造按令牌与状态基础设施、共享组件、高频业务页面、视觉验收的顺序推进，以便每一阶段都可以单独验证。
30. 作为项目维护者，我希望完成后不存在未定义的 success/warning utility，以便构建产物真实包含所有组件声明的状态样式。

## Implementation Decisions

### 总体原则

- 模仿 ChatGPT 的“角色分级、中性优先、状态色局部出现”逻辑，不复制 ChatGPT 品牌、文案或页面结构。
- 统一不等于所有组件使用同一个圆角；圆角由表面层级决定。
- 状态颜色由业务语义和反馈持续时间决定，不由具体页面自行决定。
- 普通、hover、selected、active、disabled 均属于中性系统，不借用 success、warning 或 danger。
- 所有颜色值、圆角值、遮罩和阴影必须集中在 Tailwind CSS v4 的主题层；业务组件只消费语义名称。

### 圆角层级

采用以下语义层级：

| 角色 | 基准值 | 主要用途 |
|---|---:|---|
| detail | 4px | Tooltip、代码、骨架和小型细节 |
| control | 8px | 小型图标按钮、普通控件 |
| item | 10px | 会话行、菜单项、输入框、普通交互行 |
| popover | 14px | Dropdown、UserMenu、Citation popover |
| card | 16px | 独立内容卡片、BottomSheet 顶部 |
| dialog | 20px | Modal、账号和设置操作面 |
| composer | 28px | 核心消息输入表面 |
| pill | 999px | Avatar、状态 pill、明确的胶囊按钮 |

- 允许语义角色映射到相同数值，但不允许业务组件绕过角色直接使用重复 arbitrary radius。
- 父级容器的圆角应大于其内部 item；例如 popover 14px、item 10px。
- 用户消息气泡属于内容容器，采用 card/item 体系中的统一角色，不再保留单独的无名数值。
- 移动 BottomSheet 只对顶部边角使用 card 级圆角，内部操作行继续使用 item 规则或无独立外框的整行规则。

### 中性色与表面

- 建立 canvas、sidebar、surface、sunken、hover、selected、border、border-strong、text-primary、text-muted、text-faint、accent、accent-foreground 等明确角色。
- 参考实际 ChatGPT 界面，将主文字、次级文字、弱边框、hover 和 selected 收敛到克制的灰阶关系；最终色值必须在浏览器中通过对比度和视觉验收。
- hover 与 selected 必须是不同角色：hover 表示瞬时指针反馈，selected 表示持续选中。
- raised surface、popover、dialog 和 composer 的层级主要通过边框、圆角和克制阴影表达，不通过多种任意背景色堆叠。

### 状态色与危险操作

- 状态系统至少包含 `neutral`、`success`、`error`、`warning` 四种 tone。
- success、error、warning 分别提供 foreground、soft surface 和 border 角色。
- danger 作为动作语义与 error 状态共享同一红色家族，不再保留职责重叠的多套 menu-danger/danger 色；可保留 foreground、soft surface、border 和 solid action 四个角色。
- 短暂成功默认使用中性深色 Toast 加 Check 图标，不使用整块绿色背景。
- 持续成功状态使用绿色图标/文字；只有确需高可见度时使用浅绿 surface。
- 操作失败 Toast 使用错误图标、错误 foreground 和浅红 surface，并使用 `role="alert"`。
- 字段失败使用输入框错误边框、错误图标和替换 helper 的错误文案；不得只改变边框颜色。
- Run 失败继续在消息上下文中使用持续状态提示，不重复弹出相同含义的 Toast。
- warning 只用于尚未失败但需要用户关注的状态，不复用 danger 红色。
- destructive menu item 默认红色文字/图标，hover/focus/active 使用浅红 surface；最终不可逆确认按钮使用 solid danger。

### Toast 与状态模型

- 全局 Toast state 从 `{id, message}` 扩展为 `{id, message, tone}`。
- `tone` 是通知 action 的必填语义；所有现有调用点必须在迁移中明确分类，避免默认值继续掩盖错误。
- 保留单调递增 id、自动消失计时、同文案重复触发重新动画和 `app/reset` 清空等现有行为。
- success/neutral/warning Toast 使用 `role="status"`；error Toast 使用 `role="alert"`。
- Toast 必须同时使用图标和文案表达状态，不以颜色作为唯一通道。
- 自动消失时长维持现有短反馈节奏；持久错误和需要用户操作的状态不得仅依赖自动消失 Toast。

### 共享组件与样式原语

- 扩展现有共享样式原语，覆盖 icon control、普通 button、primary button、interactive item、popover、card、dialog、composer、neutral menu item、danger menu item、status notice 和 toast。
- 新增或收敛统一的行内状态展示组件，支持 neutral/success/error/warning，并根据使用场景输出 status 或 alert。
- Sidebar 会话项、Sidebar 用户区域、Dropdown item 和 UserMenu item 使用同一个 interactive-item 表面规则。
- 会话 Dropdown、UserMenu、Composer 内选择菜单和 Citation popover 使用同一个 popover 容器与 item 规则。
- ConfirmDialog、ShareDialog、账号/分享/头像面板采用 dialog/card 角色，不再各自选择无名圆角、遮罩和阴影。
- Composer 保留其独立的大圆角和输入行为，内部 pill、icon control、菜单继续消费共享原语。
- 表单输入框在 default、hover、focus、disabled、loading、error、success 状态下保持固定边框宽度和固定几何尺寸。

### 迁移与兼容

- 第一阶段建立主题令牌、Toast tone 和行内状态原语。
- 第二阶段迁移 Sidebar、UserMenu、BottomSheet、Toast、Dialog 和 Composer 等高频共享交互面。
- 第三阶段迁移账号、分享、消息、引用、来源面板和认证页面。
- 第四阶段移除未定义 utility、UI 硬编码颜色、重复 arbitrary radius、inline danger style、重复遮罩和阴影。
- 保留现有语义类名作为测试或运行时钩子时，它们不得继续承担视觉样式职责。
- 不改变桌面/移动动作的业务逻辑；桌面 Dropdown 和移动 BottomSheet 继续共享同一组动作和禁用规则。
- 不改变路由、API 调用、Run 生命周期、会话数据或认证行为。

### 可访问性与交互状态

- 所有交互组件覆盖 default、hover、focus-visible、active、disabled、loading、error、success 八类状态；不适用的状态需要在组件契约中明确说明，而不是静默遗漏。
- hover 仅在支持 hover 的指针环境启用；移动端不得存在 hover-only 功能。
- focus-visible 使用至少 2px 的可见焦点环，并同时对元素本身和页面背景达到 3:1。
- 移动端可触达控件的有效触摸目标不小于 44×44 CSS px。
- Disabled 同时使用 native disabled/aria-disabled、不可用光标和视觉降权。
- 输入框错误必须使用 `aria-invalid` 与关联错误文案。

## Testing Decisions

### 测试原则

- 测试外部可见行为和可访问语义，不测试 Tailwind utility 的具体拼接顺序。
- exact radius、颜色、阴影和 computed style 属于浏览器视觉验收，不在 jsdom 单元测试中逐值断言。
- 保留现有业务行为断言；样式迁移不应改变会话、Run、分享、账户或认证流程。
- 优先使用最高可复用 seam，避免为每个业务组件复制 tone 和 class 断言。

### 测试 seam

1. **UI reducer / Toast 状态 seam（主要自动化 seam）**
   - 验证 showToast 保留 tone、message 和单调递增 id。
   - 验证相同 message/tone 连续触发仍产生新 id。
   - 验证 hideToast 与 app reset 清空通知。
   - 验证 neutral/success/warning 输出 status，error 输出 alert。
   - 验证错误与成功同时具有图标和文案，而不是只改变颜色。

2. **共享 UI 与 AppShell 用户流程 seam（高层行为 seam）**
   - 通过可访问角色操作真实组件，并使用 fake services 驱动复制、分享、撤销、保存、发送、停止、重新生成、邮箱验证等成功/失败路径。
   - 验证每条路径产生正确 tone 或正确的持久行内状态。
   - 验证 Run failed 只保留消息上下文状态，不重复弹出相同 Toast。
   - 验证 Sidebar/UserMenu/Desktop Dropdown/Mobile BottomSheet 的动作和禁用原因保持一致。
   - 验证 ConfirmDialog 的 destructive 行为、取消路径和焦点管理不回归。

3. **真实浏览器视觉 seam（圆角和颜色的权威验收）**
   - 桌面至少覆盖 1280×800；移动覆盖 320、375、390/414、768 CSS px。
   - 截图或 computed-style 矩阵覆盖 Sidebar item、用户区域、Dropdown、UserMenu、BottomSheet、Toast 四 tone、行内状态、ConfirmDialog、账号 Card、Composer、输入框八状态和消息气泡。
   - 验证无横向滚动、菜单不裁切、Dialog 居中、Popover 边缘翻转/收敛、移动侧边栏和 BottomSheet 正常。
   - 验证主文本达到 WCAG 4.5:1，图标和焦点环达到 3:1。
   - 对比基准使用已确认的静态对比页与交互体验页；它们是评审参考，不进入生产入口。

### 既有测试先例

- UI reducer 与 Toast 已有单调 id、自动消失、卸载 cleanup、reset 等测试，可扩展 tone 和 role。
- Sidebar 已有桌面菜单、移动 BottomSheet、UserMenu 和交互表面测试，应把 exact utility class 断言逐步替换为可见行为与语义断言。
- Composer 已有发送、停止、智能水平和联网搜索测试，可补充 disabled/loading/error/success 语义。
- ConfirmDialog、StreamingMessage、AccountCard、ShareDialog、MySharesCard 和 VerifyEmailBanner 已覆盖相关用户流程，可在原缝上补充 tone/状态断言。
- 浏览器视觉回归可沿用此前 Tailwind v4 重构的桌面/移动截图与 computed-style 对比方法。

### 完整验证命令

```text
pnpm exec vitest run
pnpm run lint
pnpm run typecheck
pnpm run build
```

后端无行为变更，不要求新增后端测试；若实现意外触及 API 或数据契约，则必须停止并另行评审范围。

## Out of Scope

- 深色模式或多主题切换。
- 品牌重设计、Logo、字体体系、信息架构或页面布局的大规模改版。
- 逐像素复制 ChatGPT、使用 ChatGPT 品牌资产或复刻其非公开实现。
- 修改后端、数据库、API、SSE、Run 状态机、会话持久化或认证契约。
- 新增业务功能、路由、页面或账户能力。
- 修改现有产品文案，除非为了错误信息清晰度和可访问性进行必要调整。
- 引入新的组件库、CSS-in-JS 方案或更换 Tailwind CSS v4。
- 全局动画系统重构；只处理与状态反馈和现有组件迁移直接相关的动画。
- 将临时静态对比页或交互体验页接入生产构建、路由或部署。
- 为每个组件建立独立快照测试，或以 className 字符串作为设计系统的主要测试契约。
- 与本次圆角、表面层级和状态颜色无关的代码清理或重构。

## Further Notes

### 审计基线

- 生产代码约有 100 处圆角声明、12 种 Tailwind 写法，分布在约 25 个前端生产文件。
- 当前主题只正式覆盖部分圆角层级；12px、14px、18px 等角色尚未语义化。
- Toast 状态目前只有 message，没有 tone；成功和失败会被渲染成相同表面。
- 账户区域存在 success/warning utility 引用，但主题没有对应颜色定义。
- 成功提示、联网搜索激活色、遮罩和多套阴影仍存在组件级硬编码。
- danger、menu-danger、danger-soft、danger-hover 等角色需要收敛。

### ChatGPT 参考结论

- 实际界面体现的是层级递增：小型控件约 8px、列表/菜单项约 10px、Popover 约 14px、Dialog 约 20px、Composer 约 28px、明确胶囊为 full。
- 默认 UI 以灰阶为主；危险操作使用红色文字和浅红 hover，最终确认才使用实心红。
- 成功反馈通常克制，短暂成功更依赖 Check 图标和中性反馈，而不是大面积绿色。
- 本 PRD 采用这些决策模式，不把单次采样的所有色值视为不可修改的品牌常量。

### 评审参考

- `.scratch/ui-system-comparison.html`：改造前后各层级的静态并排说明。
- `.scratch/ui-system-playground.html`：同一功能在改造前/改造后两套 UI 系统中的交互体验。
- 两个文件均为临时评审资产，不是生产实现，也不应加入前端路由。

### 完成标准

1. 业务 JSX 不再包含 UI 用硬编码十六进制/rgba 颜色或 inline danger style。
2. 除明确记录的 detail/composer 等语义角色外，不再使用重复 arbitrary radius。
3. 所有 Toast 调用点具有明确 tone，成功与失败在数据层不再丢失语义。
4. success、warning utility 在构建产物中真实存在，或已由新的共享状态组件完全替代。
5. Sidebar、UserMenu、Dropdown、BottomSheet、Dialog、Composer、账号、分享、消息和认证页面全部迁移到共享规则。
6. 普通 selected 不使用 success/danger 色；danger 只在危险动作和 error 状态中出现。
7. 桌面和移动视觉验收通过，无横向滚动、裁切、焦点丢失或触摸目标不足。
8. 前端单元测试、lint、typecheck 和 production build 全部通过。

### Ticket 索引

| ID | Ticket | Status | Blocked by |
|---|---|---|---|
| 01 | 建立语义设计系统基础与行内状态原语 | `completed` | None |
| 02 | 让全局 Toast 端到端保留通知语义 | `ready-for-agent` | 01 |
| 03 | 统一聊天导航与桌面移动操作菜单 | `completed` | 01 |
| 04 | 统一 Composer 及其内部交互状态 | `completed` | 01 |
| 05 | 统一 Dialog、账户卡片与危险确认流程 | `completed` | 01, 02 |
| 06 | 统一认证与账户生命周期页面状态 | `ready-for-agent` | 01, 02 |
| 07 | 统一分享管理与公开分享界面 | `ready-for-agent` | 01, 02 |
| 08 | 统一消息、Run 状态与引用阅读表面 | `ready-for-agent` | 01 |
| 09 | 完成全局设计系统合规与浏览器视觉验收 | `ready-for-agent` | 02, 03, 04, 05, 06, 07, 08 |

## Frontier

当前 frontier：02、08。

完成或阻塞 ticket 时，同时更新本索引和对应 issue 文件的状态。
