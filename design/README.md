# Piko Design

这是本项目长期维护的 UI 设计工程。它提供完整页面、组件与可操作场景，供讨论设计、确认交互、再实施到正式前端。React 展示代码独立放在 `design/src/`，运行时不依赖 `frontend/`，也不需要 API、账号、数据库或密钥。

## 启动与验收

```bash
pnpm --dir design install --frozen-lockfile
pnpm --dir design dev
```

打开 http://127.0.0.1:5180。左侧选择页面和状态，中间画布是真实浏览器文档；顶部切换桌面、移动或自定义尺寸。工具栏不会参与产品页面的 CSS 和尺寸计算。默认适应窗口，可切换到 100% 检查细节；缩放仅作用于外层预览，iframe 内仍是设定的真实桌面/移动视口。

- **场景目录**：聊天、侧栏、引用、来源、附件、搜索、分享、账号、认证、模型管理及基础组件。
- **直接操作**：发送/停止、编辑重发、模型选择、历史搜索、引用回源、文件选择与预览、分享创建撤销、头像裁剪、昵称/密码/注销流程、管理配置编辑。
- **过程控制**：播放、暂停、单步查看生成过程；“完成等待”释放加载场景；错误场景第一次操作失败，重试成功。
- **重置**：重新载入该场景，恢复内存样本，同时清理 Design 的分享快照。不会修改产品数据。
- **独立画布**：打开 `/canvas.html?scene=chat&proposal=current`，方便浏览、截图和对照。
- **版本比较**：“当前设计”和候选版本使用同一场景及画布尺寸。候选示例只改变输入框圆角，不是已经批准的产品变更。
- **导出待确认记录**：下载 JSON 草稿；不会将未确认的方案标记为 approved。

演示登录可填写任意通过表单校验的账号/密码，模型管理访问密钥使用 `design-demo`；`invalid` 演示拒绝访问。不要填写真实凭据。密码、邮件、模型调用和上传只使用本地结果，不产生外部操作。文件预览使用浏览器 Blob URL；分享链接只能在同一 Design 地址中查看，不能作为线上公开链接。

## 目录与改动边界

| 目录 | 用途 |
| --- | --- |
| `src/workbench/` | 目录、尺寸、版本、回放与记录工具 |
| `src/canvas/` | 产品页面组合和有限演示状态 |
| `src/ui/`、`messages/`、`auth/`、`conversations/`、`model-admin/`、`search/` | 独立展示代码，与对应产品组件保持可追踪关系 |
| `src/styles/global.css` | 从实际前端提取的设计 token、基础样式和关键动画 |
| `src/scenarios/` | 稳定场景 ID、来源、合成样本 |
| `src/runtime/` | 小型本地结果回调、身份和通知；不实现后端业务系统 |
| `src/proposals/` | 候选变体注册和局部覆盖 |
| `catalog/` | 覆盖、来源、基线记录 |
| `approvals/` | 人工确认记录格式与归档规则 |
| `tests/`、`references/` | 交互、几何、配对验证及证据说明 |

`src/api/` 仅保留展示所需类型和错误值，没有网络客户端。不得加入真实 fetch、SSE、JWT、生产存储或跨目录运行时引用。需要新结果时增加一个小型场景回调，不复制产品 store、reducer 和服务生命周期。

## 下一个 UI 需求如何开始

1. 明确需求和受影响页面，在 `src/proposals/registry.ts` 添加稳定 proposal ID、说明和局部变体；从当前完整页面开始，保留周围 UI。
2. 需要新状态时，在 `src/scenarios/registry.ts` 注册场景；在 `data.ts` 增加小型固定样本，在 `runtime/` 增加必要结果。不要复制整个页面工程。
3. 候选 CSS 放在候选画布文档内；结构或交互变化通过候选 ID 选择局部组件/props，current 分支保持原实现。禁止直接改共享组件而让 current 一起变化。
4. 运行相关交互和视觉检查，在相同尺寸下比较 current/candidate。交互行为也要进入需求说明，截图不能替代状态约定。
5. 执行 `pnpm --dir design catalog` 更新内容指纹，再导出待确认记录。用户确认后归档 proposal、需求、场景、尺寸、设计 commit/内容指纹、截图及例外；填写 approvedBy/approvedAt。没有确认就保持 draft。
6. 正式前端按固定版本实现，只迁移产品展示和交互代码。通过对应场景对照后记录 implementation commit，再将候选提升为 current。
7. 产品紧急 UI 修复必须回补 Design。历史通过 Git 和确认记录查看，不让活跃目录无限积累旧稿。

新增设计的工作仍由代码完成，本工程没有拖拽编辑器。页面外壳、展示组件、场景机制和确认流程已经可以复用；新的业务能力仍需要新增对应的设计状态。

## 检查

```bash
pnpm --dir design lint
pnpm --dir design typecheck
pnpm --dir design test --run
pnpm --dir design check:boundaries
pnpm --dir design exec playwright install chromium
pnpm --dir design test:visual
pnpm --dir design build
```

原版对照另需安装正式前端依赖：

```bash
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend exec tsc -p tsconfig.design-reference.json
pnpm --dir design test:parity
```

两套浏览器命令共用测试端口 5182，请顺序运行。对照会自动启动 Design 5182 和原版参考 5183；不复用已启动的业务服务。日常 Design 开发端口 5180 不受影响。

生产构建可用 `pnpm --dir design preview` 打开 http://127.0.0.1:4180。前后端互不依赖构建产物，HTML 双入口由 Vite 输出。

详见 [证据与对照规则](references/README.md)、[设计确认记录](approvals/README.md)、[初版需求](../docs/specs/2026-09-06-design-workbench.md)。
