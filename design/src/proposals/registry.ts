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

// Live-adjustable values for a proposal. The workbench renders a slider for
// each and posts changes to the canvas, which writes them as CSS variables.
export type Tweak = {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  unit: string;
  presets: number[];
};
export const tweaks: Record<string, Tweak[]> = {};

// Named combinations of a proposal's tweaks; one click sets every listed value.
export type TweakPreset = {
  name: string;
  description: string;
  values: Record<string, number>;
};
export const tweakPresets: Record<string, TweakPreset[]> = {};
export function applyTweak(name: string, value: string) {
  document.documentElement.style.setProperty(name, value);
}
export function applyProposal(id: string | null) {
  if (id === "example-composer")
    document.documentElement.style.setProperty("--radius-composer", "20px");
}
