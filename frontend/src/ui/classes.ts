// Shared Tailwind utility-class strings for controls reused across components.
// Semantic class names that remain in JSX (e.g. "toast", "sheet-backdrop") are
// test/JS hooks only and carry no styles.

export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

const iconControlStateBase =
  `inline-flex items-center justify-center rounded-control ${focusRing} ` +
  "transition-[background,color,transform] duration-[120ms] active:scale-[0.97] " +
  "disabled:cursor-not-allowed disabled:text-text-faint disabled:opacity-60 " +
  "disabled:hover:bg-transparent aria-busy:cursor-wait aria-busy:opacity-60";

export const iconControl =
  `${iconControlStateBase} text-text-muted hover:bg-hover hover:text-text-primary`;

// The collapsed desktop rail mirrors ChatGPT's near-black action marks instead
// of inheriting the muted color used by secondary icon controls elsewhere.
export const railIconControl =
  `${iconControlStateBase} text-[#0d0d0d] hover:bg-hover hover:text-[#0d0d0d]`;

// Danger entry points stay red at rest and gain the soft red surface on
// hover/focus, per the danger action rule.
export const dangerIconControl =
  `${iconControlStateBase} text-danger hover:bg-danger-soft focus-visible:bg-danger-soft`;

const buttonStateBase =
  `inline-flex items-center justify-center rounded-control ${focusRing} ` +
  "transition-[background,color,opacity,transform] duration-[120ms] active:scale-[0.98] " +
  "disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-wait aria-busy:opacity-60";

export const buttonControl =
  `${buttonStateBase} text-type-primary hover:bg-hover`;

export const primaryButton =
  `${buttonStateBase} bg-accent text-accent-foreground hover:opacity-90`;

export const solidDangerButton =
  `${buttonStateBase} bg-danger-solid text-danger-solid-foreground hover:opacity-90`;

const interactiveItemStateBase =
  `rounded-item ${focusRing} transition-[background,color] duration-[120ms] ` +
  "aria-current:bg-selected aria-selected:bg-selected data-[selected=true]:bg-selected " +
  "disabled:cursor-not-allowed disabled:text-type-disabled disabled:hover:bg-transparent " +
  "aria-busy:cursor-wait aria-busy:opacity-60";

export const interactiveItem =
  `${interactiveItemStateBase} hover:bg-hover focus-visible:bg-hover active:bg-active`;

export const dangerInteractiveItem =
  `${interactiveItemStateBase} text-danger hover:bg-danger-soft focus-visible:bg-danger-soft active:bg-danger-soft`;

export const popoverSurface =
  "rounded-popover border border-border-strong bg-surface shadow-popover";

export const cardSurface =
  "rounded-card border border-border bg-surface";

export const dialogSurface =
  "rounded-dialog border border-border-strong bg-surface shadow-dialog";

export const composerSurface =
  "rounded-composer border border-border-strong bg-surface shadow-composer";

// ChatGPT-aligned typography roles. These strings are the public seam for
// business surfaces; generated Markdown keeps consuming the same underlying
// tokens from its narrow global.css scope.
const uiTextBase = "font-ui text-ui font-normal [letter-spacing:normal]";
const uiLabelBase = "font-ui text-ui font-medium [letter-spacing:normal]";
const metaTextBase = "font-ui text-meta font-normal [letter-spacing:normal]";
const composerTextBase = "font-ui text-composer font-normal [letter-spacing:normal]";
const readingTextWrap =
  "whitespace-normal [text-wrap:wrap] [overflow-wrap:break-word] [word-break:normal]";

export const uiText = `${uiTextBase} text-type-primary`;
export const uiLabel = `${uiLabelBase} text-type-primary`;
export const metaText = `${metaTextBase} text-type-tertiary`;
export const surfaceTitle =
  "font-ui text-surface-title font-normal text-type-primary [letter-spacing:normal] [text-wrap:balance] [overflow-wrap:break-word] [word-break:normal]";

// These semantic aliases intentionally share one metric contract. Pages choose
// a role name instead of copying the same utility combination locally.
export const controlText = uiText;
export const formLabel = uiText;
export const formValue = uiText;
export const formHelp = `${metaText} ${readingTextWrap}`;

export const composerText =
  `${composerTextBase} text-type-primary [white-space:break-spaces] ` +
  "[overflow-wrap:break-word] [word-break:normal] placeholder:text-type-tertiary placeholder:opacity-100";
export const composerPlaceholder =
  `${composerTextBase} overflow-hidden text-ellipsis whitespace-nowrap text-type-tertiary`;
export const composerMode =
  `${composerTextBase} whitespace-nowrap text-type-tertiary`;
export const composerMenuItem = `${uiText} !text-ui !leading-5`;
export const composerMenuValue =
  `${uiTextBase} min-w-0 truncate whitespace-nowrap text-type-tertiary group-disabled:text-type-disabled`;

export const userMessageText =
  "font-ui text-user-message font-normal text-type-user-message [letter-spacing:normal] " +
  "whitespace-pre-wrap [overflow-wrap:anywhere] [word-break:normal]";
export const assistantText =
  `font-ui text-assistant font-normal text-type-primary [letter-spacing:normal] ${readingTextWrap}`;
export const reasoningCollapsed =
  "font-ui text-reasoning font-normal text-type-tertiary [letter-spacing:normal] " +
  readingTextWrap;
export const reasoningText =
  "font-ui text-reasoning font-normal text-type-primary [letter-spacing:normal] " +
  readingTextWrap;

export const attachmentTitle = `${uiLabel} min-w-0 truncate whitespace-nowrap`;
export const attachmentMeta = `${metaText} ${readingTextWrap}`;
export const sourceTitle = `${uiLabel} ${readingTextWrap}`;
export const sourceMeta = `${metaText} ${readingTextWrap}`;

// Message actions use the ordinary control role. Their dark-surface hover hint
// keeps the Meta metrics without binding a foreground tone.
export const messageActionText = controlText;
export const messageActionSecondary =
  `${uiTextBase} !text-ui !leading-5 text-type-tertiary`;
export const messageActionHint = metaTextBase;
export const chatControlLabel = uiLabelBase;

// Status tone supplies its own foreground; these roles only choose density.
// Important metrics let a chat-only consumer override an unmigrated shared
// surface without changing ticket 04's default typography early.
export const semanticStatus = `${uiTextBase} !text-ui !leading-5`;
export const semanticStatusMeta = `${metaTextBase} !text-meta !leading-4`;
export const runStatusText = semanticStatus;

// User message bubble — a static content container in the reading column,
// shared by the live thread and the public share page.
export const messageBubble =
  `min-w-0 overflow-hidden rounded-[22px] bg-sunken px-4 py-2.5 ${userMessageText}`;

// One semantic width/alignment seam for final, streaming, and shared
// assistant turns. The Markdown body and its adjacent surfaces stay together.
export const assistantContentColumn =
  "assistant-content mx-auto w-full min-w-0 max-w-[var(--assistant-content-width)]";

const menuItemBase =
  `${interactiveItemStateBase} flex min-h-9 w-full items-center gap-2.5 whitespace-nowrap px-3 ` +
  `text-left ${controlText}`;

export const neutralMenuItem =
  `${menuItemBase} text-type-primary hover:bg-hover focus-visible:bg-hover active:bg-active`;

export const dangerMenuItem =
  `${menuItemBase} text-danger hover:bg-danger-soft focus-visible:bg-danger-soft active:bg-danger-soft`;

export const mobileActionItem =
  "min-h-11 gap-3 px-5";

export const inputControl =
  `rounded-item border border-border bg-canvas ${formValue} ${focusRing} ` +
  "transition-[background,border-color] duration-[120ms] hover:border-border-strong " +
  "placeholder:text-type-tertiary placeholder:opacity-100 " +
  "disabled:cursor-not-allowed disabled:bg-sunken disabled:text-type-disabled " +
  "aria-busy:cursor-wait aria-busy:bg-sunken aria-invalid:border-error-border " +
  "data-[state=success]:border-success-border";

export const statusNotice =
  `flex items-start gap-2 rounded-control border px-3 py-2 ${semanticStatusMeta}`;

export const toastSurface =
  `box-border flex w-max max-w-[calc(100vw-32px)] items-center gap-2 rounded-control border px-3.5 py-2 shadow-popover ${semanticStatus}`;

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
  dangerIconControl: interactiveStates,
  buttonControl: interactiveStates,
  primaryButton: interactiveStates,
  solidDangerButton: interactiveStates,
  interactiveItem: interactiveStates,
  dangerInteractiveItem: interactiveStates,
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
  composerSurface: staticSurfaceStates,
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

// Shimmering placeholder while an auto-generated title is pending.
export const titleSkeleton =
  "title-skeleton inline-block h-[11px] animate-skel rounded-[2px] " +
  "bg-[linear-gradient(90deg,rgba(20,20,19,0.06)_0%,rgba(20,20,19,0.12)_50%,rgba(20,20,19,0.06)_100%)] " +
  "[background-size:200%_100%]";
