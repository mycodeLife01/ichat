// Shared Tailwind utility-class strings for controls reused across components.
// Semantic class names that remain in JSX (e.g. "toast", "sheet-backdrop") are
// test/JS hooks only and carry no styles.

export const iconBtn =
  "inline-flex h-7 w-7 items-center justify-center rounded-sm text-fg-muted " +
  "transition-[background,color] duration-[120ms] hover:bg-bg-hover hover:text-fg";

export const ghostBtn =
  "rounded-md px-2.5 py-[5px] text-[13px] text-fg-muted " +
  "transition-[background,color] duration-100 hover:bg-bg-hover hover:text-fg";

export const primaryBtn =
  "rounded-md bg-accent px-3.5 py-2 text-[13.5px] font-medium text-accent-fg " +
  "transition-opacity duration-[120ms] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

// Base message action (no padding — callers add p-* per variant).
export const msgAction =
  "inline-flex items-center gap-[5px] rounded-sm text-xs text-fg-muted " +
  "transition-[background,color] duration-100 hover:bg-bg-hover hover:text-fg " +
  "disabled:cursor-not-allowed disabled:text-fg-faint disabled:hover:bg-transparent disabled:hover:text-fg-faint";

// Shimmering placeholder while an auto-generated title is pending.
export const titleSkeleton =
  "title-skeleton inline-block h-[11px] animate-skel rounded-[2px] " +
  "bg-[linear-gradient(90deg,rgba(20,20,19,0.06)_0%,rgba(20,20,19,0.12)_50%,rgba(20,20,19,0.06)_100%)] " +
  "[background-size:200%_100%]";

// Menu / bottom-sheet row.
export const sheetItem =
  "flex w-full items-center gap-3 px-[22px] py-3.5 text-left text-[15px] text-fg " +
  "hover:bg-bg-hover active:bg-bg-hover disabled:cursor-not-allowed disabled:text-fg-faint " +
  "disabled:hover:bg-transparent";
