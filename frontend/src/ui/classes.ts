// Shared Tailwind utility-class strings for controls reused across components.
// Semantic class names that remain in JSX (e.g. "toast", "sheet-backdrop") are
// test/JS hooks only and carry no styles.

export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

export const iconControl =
  `inline-flex items-center justify-center rounded-control text-text-muted ${focusRing} ` +
  "transition-[background,color,transform] duration-[120ms] hover:bg-hover hover:text-text-primary " +
  "active:scale-[0.97] disabled:cursor-not-allowed disabled:text-text-faint disabled:opacity-60 " +
  "disabled:hover:bg-transparent aria-busy:cursor-wait aria-busy:opacity-60";

const buttonStateBase =
  `inline-flex items-center justify-center rounded-control ${focusRing} ` +
  "transition-[background,color,opacity,transform] duration-[120ms] active:scale-[0.98] " +
  "disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-wait aria-busy:opacity-60";

export const buttonControl =
  `${buttonStateBase} text-text-primary hover:bg-hover`;

export const primaryButton =
  `${buttonStateBase} bg-accent text-accent-foreground hover:opacity-90`;

const interactiveItemStateBase =
  `rounded-item ${focusRing} transition-[background,color] duration-[120ms] ` +
  "aria-current:bg-selected aria-selected:bg-selected data-[selected=true]:bg-selected " +
  "disabled:cursor-not-allowed disabled:text-text-faint disabled:hover:bg-transparent " +
  "aria-busy:cursor-wait aria-busy:opacity-60";

export const interactiveItem =
  `${interactiveItemStateBase} hover:bg-hover focus-visible:bg-hover active:bg-active`;

export const popoverSurface =
  "rounded-popover border border-border-strong bg-surface shadow-popover";

export const cardSurface =
  "rounded-card border border-border bg-surface";

export const dialogSurface =
  "rounded-dialog border border-border-strong bg-surface shadow-dialog";

// The composer's textarea is borderless, so the container carries the visible
// focus indicator (focus-within) and the restrained composer elevation.
export const composerSurface =
  "rounded-composer border border-border-strong bg-surface shadow-composer " +
  "focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-focus-ring";

const menuItemBase =
  `${interactiveItemStateBase} flex min-h-9 w-full items-center gap-2.5 whitespace-nowrap px-3 ` +
  "text-left text-[14px] font-normal leading-none";

export const neutralMenuItem =
  `${menuItemBase} text-text-primary hover:bg-hover focus-visible:bg-hover active:bg-active`;

export const dangerMenuItem =
  `${menuItemBase} text-danger hover:bg-danger-soft focus-visible:bg-danger-soft active:bg-danger-soft`;

export const mobileActionItem =
  "min-h-11 gap-3 px-5 text-[15px]";

export const inputControl =
  `rounded-item border border-border bg-canvas text-text-primary ${focusRing} ` +
  "transition-[background,border-color] duration-[120ms] hover:border-border-strong " +
  "disabled:cursor-not-allowed disabled:bg-sunken disabled:text-text-faint " +
  "aria-busy:cursor-wait aria-busy:bg-sunken aria-invalid:border-error-border " +
  "data-[state=success]:border-success-border";

export const statusNotice =
  "flex items-start gap-2 rounded-control border px-3 py-2 text-[12.5px] leading-[1.55]";

export const toastSurface =
  "flex items-center gap-2 rounded-control border px-3.5 py-2 text-[13px] shadow-popover";

type InteractionState =
  | "default"
  | "hover"
  | "focus-visible"
  | "active"
  | "disabled"
  | "loading"
  | "error"
  | "success";

type StateSupport = "supported" | "not-applicable";

const interactiveStates = {
  default: "supported",
  hover: "supported",
  "focus-visible": "supported",
  active: "supported",
  disabled: "supported",
  loading: "supported",
  error: "not-applicable",
  success: "not-applicable",
} as const satisfies Record<InteractionState, StateSupport>;

const staticSurfaceStates = {
  default: "supported",
  hover: "not-applicable",
  "focus-visible": "not-applicable",
  active: "not-applicable",
  disabled: "not-applicable",
  loading: "not-applicable",
  error: "not-applicable",
  success: "not-applicable",
} as const satisfies Record<InteractionState, StateSupport>;

// Public contract for state coverage. Status notices use explicit tone props;
// static surfaces intentionally have no interaction states.
export const interactionStateContract = {
  iconControl: interactiveStates,
  buttonControl: interactiveStates,
  primaryButton: interactiveStates,
  interactiveItem: interactiveStates,
  neutralMenuItem: interactiveStates,
  dangerMenuItem: interactiveStates,
  inputControl: {
    ...interactiveStates,
    error: "supported",
    success: "supported",
  },
  popoverSurface: staticSurfaceStates,
  cardSurface: staticSurfaceStates,
  dialogSurface: staticSurfaceStates,
  // Focus indication is supported via focus-within: the ring appears on the
  // container because the inner textarea has no border or outline of its own.
  composerSurface: {
    ...staticSurfaceStates,
    "focus-visible": "supported",
  },
  statusNotice: {
    ...staticSurfaceStates,
    error: "supported",
    success: "supported",
  },
  toastSurface: {
    ...staticSurfaceStates,
    error: "supported",
    success: "supported",
  },
} as const satisfies Record<string, Record<InteractionState, StateSupport>>;

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
