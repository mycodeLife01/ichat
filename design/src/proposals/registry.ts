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
];
export function applyProposal(id: string | null) {
  if (id === "example-composer")
    document.documentElement.style.setProperty("--radius-composer", "20px");
}
