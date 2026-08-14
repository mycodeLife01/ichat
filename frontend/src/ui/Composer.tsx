import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import { createPortal } from "react-dom";

import type { ChatModelCapability, ImageContext } from "../api/types";
import { AttachmentCard } from "../files/AttachmentCard";
import type { DraftAttachment, FileReadRole, FilesCapability } from "../files/types";
import { categoryForFileName } from "../files/utils";
import {
  clampThinkingLevel,
  THINKING_LEVEL_OPTIONS,
  thinkingLevelLabel,
  type ThinkingLevel,
} from "../runs/thinkingLevel";
import {
  composerSurface,
  focusRing,
  neutralMenuItem,
  popoverSurface,
  primaryButton,
} from "./classes";
import { Icons } from "./icons";

type ComposerState = "idle" | "submitting" | "streaming" | "stopping";

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  state: ComposerState;
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  webSearchEnabled?: boolean;
  webSearchAvailable?: boolean;
  onWebSearchEnabledChange?: (enabled: boolean) => void;
  models?: ChatModelCapability[];
  model?: string | null;
  onModelChange?: (modelId: string) => void;
  imageContext?: ImageContext;
  onRemoveImages?: () => Promise<void> | void;
  fileCapability?: FilesCapability;
  fileUploadAllowed?: boolean;
  attachments?: DraftAttachment[];
  onSelectFiles?: (files: FileList | File[]) => void;
  onCancelAttachment?: (clientId: string) => void;
  onRetryAttachment?: (clientId: string) => void;
  onMoveAttachment?: (clientId: string, direction: -1 | 1) => void;
  onReadAttachment?: (fileId: string, role: FileReadRole) => Promise<{ url: string }>;
  canSend?: boolean;
  sendDisabledReason?: string | null;
  readOnly?: boolean;
  isMobile?: boolean;
};

// ChatGPT lets the prompt occupy up to 30% of the viewport before scrolling.
// Once it reaches that ceiling, the prompt takes a full-width row and the
// controls move into a footer row instead of floating beside the text.
const PROMPT_MAX_HEIGHT = "max(30svh, 5rem)";
const PROMPT_MAX_VIEWPORT_RATIO = 0.3;
const PROMPT_MIN_MAX_HEIGHT = 80;

// Composer tools share one geometry: a 36px visual target with a 4px
// pseudo-element bleed, so the effective touch target reaches 44×44 CSS px
// without enlarging the visual footprint.
const composerToolTarget =
  "relative h-9 before:absolute before:-inset-1 before:content-['']";

// Labeled pills (web search, model/thinking picker) use the pill role with a
// fixed 1px border, so geometry never shifts between idle and selected.
// Background and border swap as complete class sets per state: Tailwind
// resolves conflicting utilities by stylesheet order, not className order.
// Composer tools deliberately have no press motion (scale/translate) — state
// feedback is background/color only.
const composerPill =
  `${composerToolTarget} inline-flex items-center gap-1.5 rounded-pill border px-2.5 ` +
  `text-[13px] font-medium ${focusRing} ` +
  "transition-[background,color,border-color] duration-[120ms] " +
  "disabled:cursor-not-allowed disabled:opacity-50";
const composerPillIdle =
  "border-transparent bg-transparent text-text-muted hover:bg-hover hover:text-text-primary";
// Send and stop share ChatGPT's primary composer action. State is expressed
// through the icon plus the accessible name; disabled swaps to the reference
// neutral palette while preserving native behavior and a not-allowed cursor.
const composerPrimaryAction =
  `${composerToolTarget} inline-flex w-9 items-center justify-center rounded-pill ` +
  `bg-composer-submit text-composer-submit-foreground ${focusRing} ` +
  "transition-[background-color,color,opacity] duration-[120ms] " +
  "not-disabled:hover:bg-composer-submit-hover " +
  "disabled:cursor-not-allowed disabled:bg-composer-submit-disabled " +
  "disabled:text-composer-submit-disabled-foreground disabled:opacity-100 " +
  "aria-busy:cursor-wait aria-busy:opacity-60";

// The + menu mirrors ChatGPT's pointer behavior: rows are transparent at
// rest and only paint a surface while hovered. Keyboard focus stays visible
// through the outline without leaving a filled row behind.
const toolsMenuItem =
  `mx-1.5 flex min-h-9 !w-[calc(100%-12px)] items-center gap-2.5 whitespace-nowrap ` +
  `rounded-[10px] bg-transparent !px-2.5 text-left text-[14px] font-normal !leading-5 ` +
  `text-text-primary ${focusRing} transition-[background,color] duration-[120ms] ` +
  "hover:bg-hover disabled:cursor-not-allowed disabled:text-text-faint disabled:hover:bg-transparent";

// The picker popover is a fixed-width panel, so its footprint never shifts
// with the length of a model name. The model row unfolds its options as an
// inline list right below the row (top-down, contained in the panel). The
// thinking row keeps the flyout on desktop — a second panel beside the root
// that prefers the right side, flips left when the viewport has no room, and
// slightly overlaps/staggers below the root panel (layered, as in the
// reference); on mobile viewports there is no side room, so its options
// unfold inline above the row instead, growing toward the 模型 row. The
// panel is bottom-anchored above the trigger and grows upward as a list
// unfolds — the menu already hugs the viewport bottom, so growing downward
// would overflow the page and spawn a scrollbar that shifts the whole
// layout. Picking an option folds the submenu back to the root rows; only
// Escape, outside taps, or the trigger close the picker.
type PickerSubmenu = "model" | "level" | null;

// Safety estimate for the flyout's footprint (panel min-width + gap), used
// to pick the side before rendering — measuring after the fact would let
// the panel overflow for a frame and stretch the page.
const FLYOUT_WIDTH_PX = 200;

// Mirrors the max-[760px] mobile breakpoint used across the composer.
const MOBILE_VIEWPORT_MAX_PX = 760;

// The compact tools menu has two rows. This estimate is used only to choose
// whether it opens above or below the composer before it is painted.
const TOOLS_MENU_HEIGHT_PX = 86;

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  state,
  thinkingLevel,
  onThinkingLevelChange,
  webSearchEnabled = false,
  webSearchAvailable = true,
  onWebSearchEnabledChange = () => {},
  models = [],
  model = null,
  onModelChange = () => {},
  imageContext,
  onRemoveImages,
  fileCapability,
  fileUploadAllowed = true,
  attachments = [],
  onSelectFiles = () => {},
  onCancelAttachment = () => {},
  onRetryAttachment = () => {},
  onMoveAttachment = () => {},
  onReadAttachment,
  canSend,
  sendDisabledReason = null,
  readOnly = false,
  isMobile = false,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [toolsMenuPosition, setToolsMenuPosition] = useState({
    left: 12,
    top: 0,
    width: 300,
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<PickerSubmenu>(null);
  const [flyoutSide, setFlyoutSide] = useState<"right" | "left">("right");
  const [levelInline, setLevelInline] = useState(false);
  const [blockedFiles, setBlockedFiles] = useState<File[] | null>(null);
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  const [removingImages, setRemovingImages] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!toolsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!toolsRef.current?.contains(event.target as Node)) {
        setToolsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setToolsOpen(false);
        window.requestAnimationFrame(() => ref.current?.focus());
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [toolsOpen]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    setPromptExpanded(
      el.scrollHeight >
        Math.max(window.innerHeight * PROMPT_MAX_VIEWPORT_RATIO, PROMPT_MIN_MAX_HEIGHT),
    );
  }, [value]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Expansion changes the textarea padding. Re-measure after that layout
    // state commits so clearing a long prompt cannot retain the padded height.
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [promptExpanded]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);

  const canSubmit = !readOnly && (canSend ?? Boolean(value.trim()));
  const send = () => {
    if (!canSubmit || state !== "idle") return;
    onSend();
  };

  const uploadAccept = fileCapability?.allowed_extensions
    .map((extension) => `.${extension}`)
    .join(",");

  const togglePicker = () => {
    setToolsOpen(false);
    setOpenSubmenu(null);
    setPickerOpen((open) => !open);
  };

  const toggleTools = () => {
    setPickerOpen(false);
    if (!toolsOpen) {
      const anchor = toolsRef.current?.getBoundingClientRect();
      const composer = composerRef.current?.getBoundingClientRect();
      if (anchor && composer) {
        const spaceAbove = composer.top;
        const spaceBelow = window.innerHeight - composer.bottom;
        const opensBelow =
          spaceBelow >= TOOLS_MENU_HEIGHT_PX || spaceBelow >= spaceAbove;
        const menuWidth = Math.min(composer.width || 768, window.innerWidth - 12);
        setToolsMenuPosition({
          left: Math.max(6, Math.min(composer.left, window.innerWidth - menuWidth - 6)),
          top: opensBelow
            ? composer.bottom + 8
            : Math.max(8, composer.top - TOOLS_MENU_HEIGHT_PX - 8),
          width: menuWidth,
        });
      }
    }
    setToolsOpen((open) => !open);
  };

  const toggleSubmenu = (menu: Exclude<PickerSubmenu, null>) => {
    if (menu === "level") {
      const viewportWidth = document.documentElement.clientWidth;
      // Mobile has no side room for the flyout — the options unfold inline
      // above the row instead. Both placements are decided at open time,
      // like the flyout side.
      setLevelInline(viewportWidth <= MOBILE_VIEWPORT_MAX_PX);
      // The root menu's right edge sits at the picker wrapper's right edge
      // (right-0 anchored), so the space beyond it is what the flyout gets.
      const anchor = pickerRef.current?.getBoundingClientRect();
      setFlyoutSide(
        anchor && viewportWidth - anchor.right >= FLYOUT_WIDTH_PX ? "right" : "left",
      );
    }
    setOpenSubmenu((current) => (current === menu ? null : menu));
  };

  // Row edges sit 6px (p-1.5) inside the root panel, so 100%-2px lays the
  // flyout 8px over the panel edge; the flyout's higher z-index keeps it on
  // top of the root panel.
  const flyoutSideClass =
    flyoutSide === "right" ? "left-[calc(100%-2px)]" : "right-[calc(100%-2px)]";

  const selectedModel = models.find((entry) => entry.id === model) ?? null;
  const hasImageAttachments = attachments.some(
    (attachment) => (attachment.file?.category ?? attachment.category) === "image",
  );
  // With no capabilities loaded every tier stays selectable; a model with no
  // thinking tiers (non-reasoning GPT) hides the thinking row entirely.
  const allowedLevels =
    selectedModel === null
      ? THINKING_LEVEL_OPTIONS.map((option) => option.value as string)
      : selectedModel.thinking_levels;
  const effectiveLevel = clampThinkingLevel(thinkingLevel, allowedLevels);
  const levelOptions = THINKING_LEVEL_OPTIONS.filter((option) =>
    allowedLevels.includes(option.value),
  );
  const levelLabel = thinkingLevelLabel(effectiveLevel);
  // Mobile has no room for both names on the pill, so it shows the thinking
  // level alone — unless the model has no tiers, where the model name is the
  // only label left to keep the picker reachable.
  const pickerLabel = (
    isMobile && levelOptions.length > 0
      ? [levelLabel]
      : [selectedModel?.label, levelOptions.length > 0 ? levelLabel : undefined]
  )
    .filter(Boolean)
    .join(" ");
  const primaryRowHeight = attachments.length > 0 ? "min-h-[52px]" : "min-h-[42px]";
  const canDropFiles = fileCapability?.enabled === true && fileUploadAllowed && !readOnly;

  const handleSelectFiles = useCallback((input: FileList | File[]) => {
    if (readOnly) return;
    const files = Array.from(input);
    if (
      files.some((file) => categoryForFileName(file.name) === "image") &&
      selectedModel?.supports_image_input !== true
    ) {
      setBlockedFiles(files);
      return;
    }
    onSelectFiles(input);
  }, [onSelectFiles, readOnly, selectedModel]);

  const handlePromptPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (readOnly) {
      event.preventDefault();
      return;
    }
    if (!canDropFiles) return;
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (images.length === 0) return;
    event.preventDefault();
    handleSelectFiles(images);
  };

  const hasDraggedFiles = (types: readonly string[] | DOMStringList) =>
    Array.from(types).includes("Files");

  useEffect(() => {
    if (!canDropFiles) {
      dragDepthRef.current = 0;
      setDragActive(false);
      return;
    }

    const resetDrag = () => {
      dragDepthRef.current = 0;
      setDragActive(false);
    };
    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer || !hasDraggedFiles(event.dataTransfer.types)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer || !hasDraggedFiles(event.dataTransfer.types)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (event: DragEvent) => {
      if (!event.dataTransfer || !hasDraggedFiles(event.dataTransfer.types)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0 || event.relatedTarget === null) resetDrag();
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer || !hasDraggedFiles(event.dataTransfer.types)) return;
      event.preventDefault();
      const files = event.dataTransfer.files;
      resetDrag();
      if (files.length > 0) handleSelectFiles(files);
    };

    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    window.addEventListener("blur", resetDrag);
    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
      window.removeEventListener("blur", resetDrag);
    };
  }, [canDropFiles, handleSelectFiles]);

  // Shared by both thinking-level placements (mobile inline / desktop flyout).
  const levelOptionItems = levelOptions.map((option) => (
    <button
      key={option.value}
      role="menuitemradio"
      aria-checked={option.value === effectiveLevel}
      className={`${neutralMenuItem} justify-between gap-4 max-[760px]:min-h-11`}
      type="button"
      onClick={() => {
        onThinkingLevelChange(option.value);
        setOpenSubmenu(null);
      }}
    >
      <span>{option.label}</span>
      {option.value === effectiveLevel && <Icons.Check size={14} />}
    </button>
  ));

  const hasNonImageAttachments = attachments.some(
    (attachment) => (attachment.file?.category ?? attachment.category) !== "image",
  );
  const hasMixedAttachmentKinds = hasImageAttachments && hasNonImageAttachments;

  return (
    <div className="composer-wrap border-t border-transparent bg-canvas px-8 pb-[22px] max-[760px]:px-4 max-[760px]:pb-[max(16px,env(safe-area-inset-bottom))]">
      <div
        ref={composerRef}
        data-testid="composer"
        data-drag-active={dragActive ? "true" : "false"}
        data-expanded={promptExpanded ? "true" : "false"}
        className={`composer relative mx-auto grid w-full max-w-[var(--reading-width)] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1 px-2 py-[5px] ${composerSurface}`}
      >
        {attachments.length > 0 && (
          <div
            className="scrollbar-none col-span-3 mx-1 mt-[7px] mb-[10px] flex min-w-0 max-w-full touch-pan-x items-stretch gap-2 overflow-x-auto overscroll-x-contain"
            aria-label="附件"
          >
            {attachments.map((attachment, index) => (
              <AttachmentCard
                key={attachment.client_id}
                attachment={attachment}
                mode="composer"
                getReadUrl={onReadAttachment}
                canMoveBack={index > 0}
                canMoveForward={index < attachments.length - 1}
                onCancel={onCancelAttachment}
                onRetry={onRetryAttachment}
                onMove={onMoveAttachment}
                imageLayout={
                  attachments.length === 1 &&
                  (attachment.file?.category ?? attachment.category) === "image"
                    ? "single"
                    : hasMixedAttachmentKinds &&
                        (attachment.file?.category ?? attachment.category) === "image"
                      ? "mixed"
                    : "collection"
                }
              />
            ))}
          </div>
        )}
        {/* Input state contract: only default applies. The field is
            borderless inside an already-bordered surface, so focus is
            conveyed by the caret alone (no ring — a focus outline here would
            box the whole composer); hover/active have no visual change;
            disabled/loading/error/success are not applicable — the input is
            never locked (send gating lives on the send button) and failures
            surface as toasts rather than field styling. Geometry stays
            borderless and fixed at every length. */}
        <div
          className={`${
            promptExpanded
              ? "composer-prompt-fade col-span-3 col-start-1 px-2.5"
              : "col-start-2"
          } row-start-2 flex min-w-0 items-center ${primaryRowHeight}`}
        >
          <textarea
            ref={ref}
            className={`m-0 block min-h-[25px] min-w-0 flex-1 resize-none overflow-y-auto border-none bg-transparent p-0 text-[16px] leading-[1.55] text-text-primary outline-none placeholder:text-text-faint [scrollbar-width:thin] max-[760px]:text-[17px] ${
              promptExpanded ? "py-4" : ""
            }`}
            value={value}
            readOnly={readOnly}
            onChange={(event) => {
              if (!readOnly) onChange(event.target.value);
            }}
            onPaste={handlePromptPaste}
            placeholder={isMobile ? "" : "有问题，尽管问"}
            rows={1}
            style={{ maxHeight: PROMPT_MAX_HEIGHT }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                send();
              }
            }}
          />
        </div>
        <div className="contents">
          <div
            className={`col-start-1 flex h-[42px] items-center gap-1 ${
              promptExpanded ? "row-start-3" : "row-start-2"
            }`}
          >
            {fileCapability?.enabled && (
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                multiple
                accept={uploadAccept}
                disabled={!fileUploadAllowed || readOnly}
                aria-label="选择附件"
                onChange={(event) => {
                   if (event.target.files) handleSelectFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            )}
            <div className="relative" ref={toolsRef}>
              <button
                className={`${composerToolTarget} inline-flex w-9 items-center justify-center rounded-pill border ${focusRing} transition-[background,color,border-color] duration-[120ms] ${
                  toolsOpen
                    ? "border-transparent bg-hover text-text-primary"
                    : composerPillIdle
                }`}
                type="button"
                aria-label="添加文件等"
                aria-haspopup="menu"
                aria-expanded={toolsOpen}
                onClick={toggleTools}
              >
                <Icons.Plus size={20} />
              </button>
              {toolsOpen && (
                <div
                  role="menu"
                  aria-label="添加和工具"
                  className="fixed z-20 max-w-[calc(100vw-12px)] rounded-[16px] border border-border-strong bg-surface py-1.5 shadow-popover"
                  style={toolsMenuPosition}
                >
                  {fileCapability?.enabled && (
                    <button
                      role="menuitem"
                      className={toolsMenuItem}
                      type="button"
                      disabled={!fileUploadAllowed || readOnly}
                      title={
                        fileUploadAllowed
                          ? "添加照片和文件"
                          : "Verify your email before uploading files."
                      }
                      onClick={() => {
                        setToolsOpen(false);
                        fileInputRef.current?.click();
                      }}
                    >
                      <Icons.Paperclip size={20} className="shrink-0" />
                      <span className="flex min-w-0 items-baseline gap-3 text-left">
                        <span className="shrink-0 text-[14px] text-text-primary">
                          添加照片和文件
                        </span>
                        <span className="truncate text-[14px] font-normal text-text-muted">
                          从电脑上传
                        </span>
                      </span>
                    </button>
                  )}
                  <button
                    role="menuitemcheckbox"
                    aria-checked={webSearchEnabled}
                    className={toolsMenuItem}
                    type="button"
                    disabled={!webSearchAvailable}
                    title={!webSearchAvailable ? "联网搜索不可用" : "网页搜索"}
                    onClick={() => {
                      onWebSearchEnabledChange(!webSearchEnabled);
                    }}
                  >
                    <Icons.Globe
                      size={20}
                      className="shrink-0 text-search-foreground"
                    />
                    <span className="flex min-w-0 flex-1 items-baseline gap-3 text-left">
                      <span className="shrink-0 text-[14px] text-text-primary">网页搜索</span>
                      <span className="truncate text-[14px] font-normal text-text-muted">
                        查找实时新闻和信息
                      </span>
                    </span>
                    {webSearchEnabled ? (
                      <Icons.Check size={16} className="shrink-0 text-text-primary" />
                    ) : (
                      <span className="shrink-0 text-[13px] leading-5 text-text-muted">已关闭</span>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
          <div
            className={`col-start-3 flex h-[42px] items-center gap-1 ${
              promptExpanded ? "row-start-3" : "row-start-2"
            }`}
          >
            {pickerLabel !== "" && (
              <div className="relative" ref={pickerRef}>
                <button
                  className={`${composerPill} ${composerPillIdle}`}
                  type="button"
                  aria-label="模型与思考强度"
                  aria-haspopup="menu"
                  aria-expanded={pickerOpen}
                  onClick={togglePicker}
                >
                  <span>{pickerLabel}</span>
                  <Icons.Chevron size={14} />
                </button>
                {pickerOpen && (
                  <div
                    role="menu"
                    aria-label="模型与思考强度"
                    className={`absolute right-0 bottom-[calc(100%+6px)] z-10 w-[248px] p-1.5 ${popoverSurface}`}
                  >
                    {models.length > 0 && (
                      <div className="relative">
                        <button
                          role="menuitem"
                          aria-haspopup="menu"
                          aria-expanded={openSubmenu === "model"}
                          className={`${neutralMenuItem} justify-between gap-4 max-[760px]:min-h-11`}
                          type="button"
                          onClick={() => toggleSubmenu("model")}
                        >
                          <span>模型</span>
                          <span className="inline-flex min-w-0 items-center gap-1 text-text-muted">
                            {/* leading-normal: the menu item's leading-none
                                paints descenders outside the line box, and
                                truncate's overflow-hidden would clip them. */}
                            <span className="truncate leading-normal">
                              {selectedModel?.label ?? ""}
                            </span>
                            <Icons.Chevron
                              size={14}
                              className={`shrink-0 transition-transform duration-[160ms]${
                                openSubmenu === "model" ? "" : " -rotate-90"
                              }`}
                            />
                          </span>
                        </button>
                        {openSubmenu === "model" && (
                          <div role="menu" aria-label="模型" className="pl-3">
                            {models.map((entry) => (
                              <button
                                key={entry.id}
                                role="menuitemradio"
                                aria-checked={entry.id === selectedModel?.id}
                                className={`${neutralMenuItem} justify-between gap-4 max-[760px]:min-h-11`}
                                type="button"
                                disabled={
                                  (imageContext?.state === "vision_required" &&
                                    !entry.supports_image_input) ||
                                  (imageContext?.state === "legacy_upgrade_required" &&
                                    entry.supports_image_input)
                                }
                                title={
                                  imageContext?.state === "vision_required" &&
                                  !entry.supports_image_input
                                    ? "This conversation requires a vision model."
                                    : imageContext?.state === "legacy_upgrade_required" &&
                                        entry.supports_image_input
                                      ? "Upgrade the original image message first."
                                      : undefined
                                }
                                onClick={() => {
                                  if (
                                    hasImageAttachments &&
                                    !entry.supports_image_input
                                  ) {
                                    setPendingModelId(entry.id);
                                    return;
                                  }
                                  onModelChange(entry.id);
                                  setOpenSubmenu(null);
                                }}
                              >
                                <span className="min-w-0 truncate leading-normal">
                                  {entry.label}
                                </span>
                                {entry.id === selectedModel?.id && (
                                  <Icons.Check size={14} className="shrink-0" />
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {levelOptions.length > 0 && (
                      <div className="relative">
                        {/* Mobile placement: the list sits above the row, so
                            the bottom-anchored panel grows upward toward the
                            模型 row as it unfolds. */}
                        {openSubmenu === "level" && levelInline && (
                          <div role="menu" aria-label="思考强度" className="pl-3">
                            {levelOptionItems}
                          </div>
                        )}
                        <button
                          role="menuitem"
                          aria-haspopup="menu"
                          aria-expanded={openSubmenu === "level"}
                          className={`${neutralMenuItem} justify-between gap-4 max-[760px]:min-h-11`}
                          type="button"
                          onClick={() => toggleSubmenu("level")}
                        >
                          <span>思考强度</span>
                          <span className="inline-flex items-center gap-1 text-text-muted">
                            <span>{levelLabel}</span>
                            <Icons.Chevron
                              size={14}
                              className={`shrink-0 transition-transform duration-[160ms]${
                                openSubmenu === "level" && levelInline
                                  ? " rotate-180"
                                  : " -rotate-90"
                              }`}
                            />
                          </span>
                        </button>
                        {openSubmenu === "level" && !levelInline && (
                          <div
                            role="menu"
                            aria-label="思考强度"
                            className={`absolute bottom-[-12px] ${flyoutSideClass} z-20 min-w-[128px] p-1.5 ${popoverSurface}`}
                          >
                            {levelOptionItems}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {state === "idle" ? (
              <button
                className={composerPrimaryAction}
                type="button"
                aria-label="发送"
                disabled={!canSubmit}
                title={!canSubmit ? sendDisabledReason ?? undefined : undefined}
                onClick={send}
              >
                <Icons.ArrowUp size={20} />
              </button>
            ) : state === "submitting" ? (
              <button
                className={composerPrimaryAction}
                type="button"
                aria-label="发送中"
                aria-busy="true"
                disabled
              >
                <Icons.Loading className="animate-spin" size={15} aria-hidden="true" />
              </button>
            ) : (
              <button
                className={composerPrimaryAction}
                type="button"
                aria-label={state === "stopping" ? "停止中" : "停止生成"}
                aria-busy={state === "stopping"}
                disabled={state === "stopping"}
                onClick={onStop}
              >
                <Icons.Stop size={11} />
              </button>
            )}
          </div>
        </div>
      </div>
      {(blockedFiles || pendingModelId) && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={pendingModelId ? "Image draft options" : "当前模型不支持图片上传"}
        >
          <div className="w-full max-w-[420px] rounded-2xl border border-border bg-surface p-5 shadow-popover">
            <h2 className="text-[16px] font-semibold text-text-primary">
              {pendingModelId ? "Remove images before switching models?" : "当前模型不支持图片上传"}
            </h2>
            <p className="mt-2 text-[13px] leading-5 text-text-muted">
              {pendingModelId
                ? "Your image draft will stay available until you choose how to continue."
                : "请切换至GPT模型以继续"}
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {pendingModelId ? (
                <>
                  <button
                    type="button"
                    className="rounded-control border border-border px-3 py-2 text-[13px] text-text-primary hover:bg-hover"
                    onClick={() => setPendingModelId(null)}
                  >
                    Continue with GPT
                  </button>
                  <button
                    type="button"
                    className="rounded-control border border-border px-3 py-2 text-[13px] text-text-primary hover:bg-hover"
                    disabled={removingImages || !onRemoveImages}
                    onClick={() => {
                      const target = pendingModelId;
                      if (!target || !onRemoveImages || removingImages) return;
                      setRemovingImages(true);
                      void Promise.resolve()
                        .then(() => onRemoveImages())
                        .then(() => {
                          onModelChange(target);
                          setPendingModelId(null);
                        })
                        .catch(() => {
                          // Keep the modal and the current model when any
                          // cancellation fails; the draft remains recoverable.
                        })
                        .finally(() => setRemovingImages(false));
                    }}
                  >
                    {removingImages ? "Removing images…" : "Remove all images and switch"}
                  </button>
                  <button
                    type="button"
                    className="rounded-control border border-border px-3 py-2 text-[13px] text-text-muted hover:bg-hover"
                    onClick={() => setPendingModelId(null)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={`${primaryButton} h-9 px-3.5 text-[13px] font-medium`}
                  onClick={() => setBlockedFiles(null)}
                >
                  确认
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {dragActive &&
        createPortal(
          <div
            className="pointer-events-none fixed inset-0 z-[70] flex p-3 bg-white/80 backdrop-blur-[2px]"
            data-testid="page-file-drop-overlay"
            aria-hidden="true"
          >
            <div className="flex flex-1 items-center justify-center rounded-[28px] border-2 border-dashed border-text-muted/50 bg-surface/85 shadow-popover">
              <div className="flex flex-col items-center gap-3 text-center text-text-primary">
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-sunken">
                  <Icons.Upload size={24} />
                </span>
                <div>
                  <p className="text-[16px] font-semibold leading-6">松开即可上传</p>
                  <p className="mt-0.5 text-[13px] leading-5 text-text-muted">添加照片和文件</p>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
