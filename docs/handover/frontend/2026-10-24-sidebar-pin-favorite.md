# 侧栏置顶与收藏交接（2026-10-24）

## 需求与结论

用户可以置顶任意独立会话，也可以收藏会话。设计候选 `sidebar-pin-favorite` 由 jackey 于
2026-10-24 批准并提升为当前设计，审批记录见
`design/approvals/2026-10-24-sidebar-pin-favorite.json`。批准的取值：

| 项 | 取值 |
|---|---|
| 图钉样式 | Phosphor（`PinGlyph`），已置顶时 hover 图钉实心；菜单“取消置顶”用删除线图钉（PushPinSlash），与“取消收藏”一致 |
| 分组标题字号 | 14px |
| 分组标题墨色 | 正文色 60%（`color-mix`，随明暗主题变化） |
| 会话行间距 | 2px（相邻 `.history-row-spaced` 行） |
| 收藏弹窗查找 | 仅按标题子串过滤已加载的收藏，不调用全文搜索；无匹配时只显示“没有匹配的收藏”，不加提示小字 |

## 产品规则

- **置顶**：侧栏“最近”之上的“置顶”分组，按 `pinned_at` 倒序，每个用户最多 10 个。超限时
  不发请求，直接提示 warning toast“最多置顶 10 个对话”；服务端以 `PIN_LIMIT_REACHED` 兜底。
  置顶会话不出现在“最近”里，也不随新消息改变顺序。
- **收藏**：不改变侧栏位置。入口是“新建对话”“搜索对话”下方的常驻“收藏”（rail 同样提供），
  打开 `FavoritesDialog`，按 `favorited_at` 倒序。弹窗里取消收藏后该行保留为空心星，可再点
  重新收藏，关闭弹窗后才从列表消失。
- 入口：侧栏行“更多”菜单（置顶 / 收藏 / 分享 / 重命名 / 删除），聊天页右上角三点菜单；桌面端
  hover 行时在“更多”右侧显示斜置图钉，一键置顶或取消。
- 成功提示统一使用绿色 success toast：已置顶 / 已取消置顶 / 已加入收藏 / 已取消收藏。
- “聊天”分组改名为“最近”；“置顶”“最近”标题可点击折叠，hover 显示折叠箭头。
- 标记不更新 `updated_at`，因此不会把会话顶到“最近”最前。
- 删除会话后两个标记都不再出现；撤销删除保留标记，但若置顶已满 10 个则恢复时丢弃置顶。

## 实现路径

- 后端：迁移 `20261024_0028` 增加可空 `pinned_at`、`favorited_at` 与两个部分索引；
  `PUT/DELETE /conversations/{id}/pin`、`/favorite`；列表接口 `view=recent|pinned|favorites`，
  `recent` 排除置顶会话。置顶与恢复删除都先锁定该用户的置顶集合再计数，避免并发越过上限。
  标记更新使用 Core update 显式保留 `updated_at`。
- 前端状态：`conversationIndex.items` 只含未置顶的最近会话，`pinnedItems` 为全部置顶会话；
  `conversations/markerChanged` 按标记把行移入或移出对应列表并同步详情。
  `useConversationLoader` 与 `useConversationListSync` 并行拉取 recent 与 `view: "pinned"`。
- `useConversationMarkers`：乐观更新 → 请求 → 用服务端结果确认，失败回滚并提示
  “操作失败，请重试”。`toggleFavorite` 返回保存后的状态或 `null`，供收藏弹窗回滚本地行。
- `FavoritesDialog` 独立请求 `view: "favorites"`，不写入侧栏索引。

## 验证

- 后端：`tests/api/test_conversations.py` 覆盖置顶上限、列表视图、标记不改 `updated_at`、删除与
  恢复规则，以及拒绝操作他人会话。
- 前端：`useConversationMarkers`、`FavoritesDialog`、`Sidebar`、`ThreadActions`、`state` 等单测；
  lint、typecheck、build 通过。
- design：catalog、parity 与 visual 测试见审批记录 evidence。
- 真实 Chrome 端到端结果见审批记录 `evidence.realChrome`。

## 注意事项

- 新增任何行操作都要同时加到展开列表、rail 浮层和移动端 sheet（共用 `rowActionOrder`）。
- 行高在置顶/未置顶、hover、运行中各状态下必须保持不变：图钉只在 hover 时替换尾部区域，
  不改变行的 height/padding。
