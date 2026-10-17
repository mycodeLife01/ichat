export const proposals = [
  {
    id: "current",
    name: "当前设计",
    status: "baseline",
    description: "源自当前前端，等待首版验收。",
  },
  {
    id: "example-composer",
    name: "候选示例 · 输入框圆角",
    status: "draft",
    description:
      "仅用于验证候选隔离：在完整页面里将输入框圆角调整为 20px。不是已批准的产品变更。",
  },
  {
    id: "sidebar-run-status",
    name: "侧栏 · 会话运行状态",
    status: "draft",
    description:
      "多会话并发：侧栏行尾显示进行中（旋转图标）与后台完成未读（蓝点），进入会话后清除；悬停时让位给“更多”按钮，行高不变。新会话先以骨架占位，标题随后异步写入。收起侧栏的“最近聊天”与移动端“打开历史”按钮在有未读时显示角标。在“侧栏 · 运行状态”场景中：切到其他会话，生成会转入后台继续，完成后出现蓝点。",
  },
];
export function applyProposal(id: string | null) {
  if (id === "example-composer")
    document.documentElement.style.setProperty("--radius-composer", "20px");
  if (id === "sidebar-run-status")
    document.documentElement.style.setProperty("--color-unread-indicator", "#1a73c7");
}
