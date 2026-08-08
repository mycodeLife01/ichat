# 已发送图片落位稳定性修复交接

日期：2026-08-09

## 交接目的

本轮修复用户发送带图片消息时，图片从输入框落入正式消息区域的抖动、加载中间态、闪烁和尺寸不自然问题。最终方案只稳定布局与复用本地预览，不改变既有消息 UI，也不对图片像素本身施加淡入、缩放、位移或覆盖层。

本文件只记录本轮前端交互修复。文件生命周期、上传状态机和安全预览派生规则继续以[统一文件上传交接](./2026-08-01-unified-file-upload.md)、[GPT 图片输入交接](./2026-08-03-gpt-vision-input.md)和[前端架构](../architecture/frontend.md)为准。

## 最终可观察行为

新发送图片在当前消息视图中的行为应满足以下约束：

1. 图片落位的第一帧就是用户刚刚选择的本地原图内容，不显示骨架、加载文字、空白底或远端图片中间态。
2. 从输入框预览到消息附件，持续复用同一个本地 Blob URL；已落位图片使用单个 `<img>` 节点，不在后台安全预览解码完成后更换 `src`。
3. 图片内容没有透明度、缩放、裁切变化或位置动画。曾加入的最后 6px 位移已经按需求完整删除。
4. API 返回的宽高元数据在远端预览加载前预留最终画框，避免图片解码造成消息高度或宽度跳变。
5. 单张横图最大画框为 `384 × 256`，单张竖图或方图最大画框为 `256 × 384`；多图集合沿用原有布局。
6. 当前消息附件视图卸载后释放 Blob URL；React Strict Mode 的 effect 重放通过延迟到下一事件循环并允许取消的清理方式处理，避免开发环境提前回收。
7. 页面刷新或日后重新挂载时，本地 Blob 已不存在，附件再按原有签名安全预览流程加载持久化派生图。

## 修复轨迹与关键节点

| 阶段 | 观察到的问题 | 处理与结论 |
|---|---|---|
| 初始问题 | 用户消息落位时，附件先以未知尺寸或加载态出现，随后真实图片改变布局，产生明显抽搐。 | 为消息附件补充宽高元数据，并在图片请求前计算、预留最终画框。 |
| UI 回归纠正 | 第一轮尝试改变了原有消息外观。 | 恢复原 UI；后续限定为渲染时序和布局稳定性修复，不重做视觉样式。 |
| 图片首帧 | 消息已落位但远端签名预览尚未返回，短暂显示加载态。 | 选择文件时立即创建 Blob URL；提交发送前先将它从编辑器所有权转交给待落位消息，发送成功后保留，失败则还给编辑器。 |
| 硬切远端预览 | 在远端安全派生图解码后从本地原图硬切，虽然没有加载空白，但仍会闪一下。 | 判定根因是原图与安全派生图在像素、编码或几何上的差异；放弃在当前挂载周期切源。 |
| 透明度交叉淡化 | 试过约 120ms 的双图淡化。 | 图片内部在收尾阶段产生类似收缩的观感，违反“动画不能影响图片本身”的要求，已移除。 |
| 外层位移动画 | 试过仅让附件容器从 `translateY(6px)` 回到原位，以保持图片内容不变。 | 用户要求删除最后的小位移；对应样式、关键帧和 token 已全部删除，`global.css` 当前无此改动。 |
| 最终方案 | 需要落位流畅，同时图片全程无任何附加视觉效果。 | 当前挂载周期固定使用本地 Blob 和单一图片节点；远端预览延后到未来无本地 Blob 的重新挂载时再使用。 |

## 最终数据与渲染链路

1. [`useAttachmentUploads.ts`](../../frontend/src/files/useAttachmentUploads.ts) 在选择图片时立即创建 Blob URL，并由 `detachImagePreviews` 在提交发送前转移所有权。
2. [`AppShell.tsx`](../../frontend/src/app/AppShell.tsx) 以附件 file ID 为键暂存待落位和已发送图片预览；发送失败时恢复到编辑器，消息附件卸载后负责回收。
3. [`MessageThread.tsx`](../../frontend/src/messages/MessageThread.tsx) 与 [`Message.tsx`](../../frontend/src/messages/Message.tsx) 只透传匹配附件的本地预览 URL。
4. [`AttachmentCard.tsx`](../../frontend/src/files/AttachmentCard.tsx) 优先渲染本地 Blob；本地预览存在时不请求签名预览，也不渲染 loader。它同时根据附件宽高和单图/多图上下文固定画框。
5. [`files.py`](../../app/schemas/files.py) 与 [`service.py`](../../app/services/files/service.py) 将持久化附件的 `stats.width`、`stats.height` 带入消息 API，供之后没有本地 Blob 的渲染预留空间。

## 后续追加：消息编辑仅允许修改文字

同日根据最新交互要求，已删除消息编辑态图片和文件附件上的“前移、后移、删除”操作栏。编辑器仍展示原附件作为只读上下文并允许正常预览，但不再维护可变附件副本；保存时只提交新的 `content`，省略 `attachment_ids`，由后端继承当前消息版本的原附件及顺序。普通 Composer 中未发送附件的上传、取消和草稿操作不受影响。

对应回归测试为 [`Message.test.tsx`](../../frontend/src/messages/Message.test.tsx) 中的 `keeps image attachment controls absent on hover while editing text`，验证 hover 图片后不存在附件操作按钮，提交回调也只包含消息 ID 和新文字。

## 测试覆盖与验证结果

新增或强化的关键回归点：

- [`AppShell.test.tsx`](../../frontend/src/app/AppShell.test.tsx)：`keeps sent image pixels stable after placement`，验证落位后继续使用同一 Blob、只有一个图片节点且不会启动远端签名预览。
- [`Message.test.tsx`](../../frontend/src/messages/Message.test.tsx)：`keeps sent-image frame geometry stable while the signed preview loads`，并覆盖单张横图和竖图的最终尺寸。
- [`test_vision_conversations.py`](../../tests/api/test_vision_conversations.py)：验证消息附件响应携带图片宽高统计。

已执行的前端检查：

```powershell
cd frontend
pnpm test --run
pnpm lint
pnpm typecheck
pnpm build
```

- 完整前端测试通过：67 个测试文件、518 个测试。
- lint、TypeScript 类型检查和生产构建通过。
- 删除最后 6px 位移后，又单独运行稳定像素回归测试，并重新通过 lint、类型检查和生产构建。
- `git diff --check` 通过；PowerShell/Git 仅报告既有 CRLF 转换提示。
- 本轮最后没有重新运行后端全量 pytest。提交前至少应运行 `pytest tests/api/test_vision_conversations.py`，并按改动风险决定是否运行后端全量测试。

曾在完整前端测试与构建并行执行时观察到一次与本修复无关的 `AppProvider` 异步时序波动；该目标单独运行通过，完整测试独立重跑也通过。如果以后再次出现，应作为独立问题诊断，不要通过放宽图片稳定性断言规避。

## 浏览器实测状态

已能识别用户 Chrome 中打开的 iChat 和参考 ChatGPT 会话，但浏览器控制扩展在接管 iChat 标签页时持续超时；此前重新上传测试图片也受扩展文件 URL 权限和系统文件选择器控制限制。因此，最终精确代码状态尚未完成真实 Chrome 的最后一次视觉 smoke，不能记录为“浏览器已验证通过”。

恢复浏览器控制后建议用同一张横图按以下标准复验：

1. 在正式 iChat 会话发送图片，逐帧观察从编辑器到用户消息的落位。
2. 确认第一帧就是实际原图，图片内部无淡入、缩放、收缩或闪白，容器也无末尾位移。
3. 保持当前消息视图一段时间，确认安全派生图完成后仍不发生像素切换。
4. 刷新页面，确认本地 Blob 消失后能够正常加载持久化安全预览，且预留画框不跳动。
5. 再用竖图和多图消息复验尺寸边界与既有集合布局。

## 当前工作区与边界提醒

当前改动尚未提交。与本轮图片落位直接相关的文件为：

- `app/schemas/files.py`
- `app/services/files/service.py`
- `frontend/src/app/AppShell.tsx`
- `frontend/src/app/AppShell.test.tsx`
- `frontend/src/files/AttachmentCard.tsx`
- `frontend/src/files/types.ts`
- `frontend/src/files/useAttachmentUploads.ts`
- `frontend/src/messages/Message.tsx`
- `frontend/src/messages/MessageThread.tsx`
- `frontend/src/messages/Message.test.tsx`
- `tests/api/test_vision_conversations.py`

需要特别保留并拆分判断的工作区内容：

- `frontend/src/conversations/useRegenerate.ts` 是用户已有的无关改动，不属于本轮图片修复。
- `Message.tsx` 和 `MessageThread.tsx` 中还混有用户此前关于 vision 编辑模型行为的改动。提交或回退时必须按具体 diff hunk 区分，不能整文件覆盖。
- `frontend/src/styles/global.css` 已恢复为修改前状态，不应被列入本修复提交。
- 不要重新引入本地图与远端派生图的同挂载切换。即使加淡化，它仍会让图片内容发生可见变化。

## 后续接手清单

1. 先读取本文件引用的前端架构、统一文件上传和 GPT 图片输入交接，确认安全派生图约束。
2. 检查当前 diff，保护 `useRegenerate.ts` 及消息组件中无关的用户改动。
3. 运行后端目标测试和最终完整前端验证。
4. 修复或绕过 Chrome 控制扩展接管超时，完成上述真实浏览器 smoke。
5. 只有在 smoke 也满足“图片像素全程不变”后再提交；提交时使用 Conventional Commit，并将无关改动分开。

## 建议技能（suggested skills）

- `$diagnosing-bugs`：若真实浏览器仍有抖动或闪烁，用逐帧证据定位布局变化、节点重建或图片源变化，不凭观感继续叠加动画。
- `$chrome:control-chrome`：复用已登录 Chrome 中的正式 iChat 与参考 ChatGPT 会话完成最终交互 smoke；不要记录账号、会话 URL 或测试图片临时路径。
- `$code-review`：提交前按任务规格审查未提交 diff，重点识别 `Message.tsx`、`MessageThread.tsx` 中与本修复交错的用户改动。
