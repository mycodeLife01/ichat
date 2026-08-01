import { useEffect, useId, useRef, useState } from "react";

import type { MessageResponse, MessageSource } from "../api/types";
import { AttachmentCard } from "../files/AttachmentCard";
import type { DraftAttachment, FileReadRole } from "../files/types";
import { BottomSheet } from "../ui/BottomSheet";
import {
  buttonControl,
  focusRing,
  messageBubble,
  mobileActionItem,
  neutralMenuItem,
  primaryButton,
} from "../ui/classes";
import { Icons } from "../ui/icons";
import { Markdown } from "./Markdown";
import { MessageAction } from "./MessageAction";
import { SourceFavicon } from "./SourcesPanel";

type MessageProps = {
  message: MessageResponse;
  // On mobile, assistant actions stay resident; user actions open in a
  // BottomSheet via long-press on the bubble. Desktop shows an icon-only
  // action bar with hover-dropdown labels.
  isMobile?: boolean;
  // null = enabled; a string = disabled with that Chinese reason.
  mutateDisabledReason?: string | null;
  onEditAndRegenerate?: (
    messageId: string,
    content: string,
    attachmentIds?: string[],
  ) => void;
  onRegenerate?: (messageId: string) => void;
  onReadAttachment?: (fileId: string, role: FileReadRole) => Promise<{ url: string }>;
  /** Ready files selected in the composer can be added to an edited message. */
  composerAttachments?: DraftAttachment[];
  maxAttachmentsPerMessage?: number;
  // Opens the sources side panel (AppShell owns the panel state).
  onShowSources?: (sources: MessageSource[]) => void;
};

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

// `group` drives the action bar's hover/focus reveal; `scroll-mt-[60px]`
// preserves the .msg scroll-margin used by intent-based thread scrolling.
const msgBase = "msg group flex scroll-mt-[60px] flex-col gap-1.5";

// Long user messages are clipped to this height with an expand toggle.
const COLLAPSE_MAX_HEIGHT = 320;

export function Message({
  message,
  isMobile = false,
  mutateDisabledReason = null,
  onEditAndRegenerate,
  onRegenerate,
  onReadAttachment,
  composerAttachments = [],
  maxAttachmentsPerMessage = 5,
  onShowSources,
}: MessageProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  // undefined deliberately means "omit attachment_ids", which tells the API
  // to inherit this revision's attachments. Any array (including []) is the
  // explicit replacement form.
  const [editedAttachmentIds, setEditedAttachmentIds] = useState<string[] | undefined>();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Long user messages collapse to COLLAPSE_MAX_HEIGHT with an expand toggle;
  // `overflowing` is measured from the rendered content.
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const disabledReasonId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mobile user messages have no visible action button (no hover on touch);
  // a long-press on the bubble opens the action sheet instead.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const disabled = mutateDisabledReason !== null;
  const isUser = message.role === "user";

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    },
    [],
  );

  // Auto-grow the edit textarea to fit its content. The surrounding panel
  // caps the visible editor height and owns scrolling for long drafts.
  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);

  // Detect whether the bubble content exceeds the collapse cap. Re-measure on
  // resize since reflow changes the wrapped height.
  useEffect(() => {
    if (editing) return;
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > COLLAPSE_MAX_HEIGHT);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [editing, message.content]);

  const startLongPress = () => {
    longPressTimer.current = setTimeout(() => setSheetOpen(true), 450);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const startEditing = () => {
    setDraft(message.content);
    setEditedAttachmentIds(undefined);
    setEditing(true);
  };
  const mutate = isUser ? startEditing : () => onRegenerate?.(message.id);
  const mutateLabel = isUser ? "编辑并重发" : "重新生成";
  const MutateIcon = isUser ? Icons.Pencil : Icons.Refresh;
  const messageAttachments = message.attachments ?? [];
  const readyComposerAttachments = composerAttachments.flatMap((attachment) =>
    attachment.status === "succeeded" && attachment.file ? [attachment.file] : [],
  );
  const attachmentById = new Map(
    [...messageAttachments, ...readyComposerAttachments].map((attachment) => [attachment.id, attachment]),
  );
  const effectiveEditedAttachmentIds =
    editedAttachmentIds ?? messageAttachments.map((attachment) => attachment.id);
  const editedAttachments = effectiveEditedAttachmentIds.flatMap((id) => {
    const attachment = attachmentById.get(id);
    return attachment ? [attachment] : [];
  });
  const hasEditedModelInput = editedAttachments.some(
    (attachment) => attachment.model_consumable && attachment.category !== "image",
  );

  const removeEditedAttachment = (fileId: string) => {
    setEditedAttachmentIds((current) => {
      const source = current ?? messageAttachments.map((attachment) => attachment.id);
      return source.filter((id) => id !== fileId);
    });
  };
  const moveEditedAttachment = (fileId: string, direction: -1 | 1) => {
    setEditedAttachmentIds((current) => {
      const source = [...(current ?? messageAttachments.map((attachment) => attachment.id))];
      const index = source.indexOf(fileId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= source.length) return source;
      [source[index], source[target]] = [source[target], source[index]];
      return source;
    });
  };
  const composerIdsToAdd = readyComposerAttachments
    .map((attachment) => attachment.id)
    .filter((id) => !effectiveEditedAttachmentIds.includes(id));
  const canAddComposerAttachments =
    composerIdsToAdd.length > 0 &&
    effectiveEditedAttachmentIds.length + composerIdsToAdd.length <=
      maxAttachmentsPerMessage;
  const addComposerAttachments = () => {
    if (!canAddComposerAttachments) return;
    setEditedAttachmentIds([...effectiveEditedAttachmentIds, ...composerIdsToAdd]);
  };

  // Copy shows a transient check (已复制) before reverting to the copy icon.
  const handleCopy = () => {
    copy(message.content);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  // Mobile sheet rows consume the same neutral action-item primitive as the
  // sidebar and user action sheets.
  const sheetActions = (afterAction: () => void) => (
    <>
      <button
        className={`${neutralMenuItem} ${mobileActionItem}`}
        data-variant="neutral"
        onClick={() => {
          copy(message.content);
          afterAction();
        }}
      >
        <Icons.Copy size={15} />
        复制
      </button>
      <button
        className={`${neutralMenuItem} ${mobileActionItem}`}
        data-variant="neutral"
        disabled={disabled}
        title={mutateDisabledReason ?? undefined}
        aria-describedby={disabled ? disabledReasonId : undefined}
        onClick={() => {
          mutate();
          afterAction();
        }}
      >
        <MutateIcon size={15} />
        {mutateLabel}
      </button>
      {mutateDisabledReason && (
        <p
          id={disabledReasonId}
          className="px-5 pt-1 pb-2 text-[13px] leading-5 text-text-muted"
        >
          {mutateDisabledReason}
        </p>
      )}
    </>
  );

  // Desktop bar: icon-only actions with a hover-dropdown label. The assistant
  // bar is always visible (resident); the user bar reveals on message hover.
  // Copy cross-fades to a check (已复制); both icons stay mounted so the swap
  // doesn't remount a node under the cursor (which would re-open the dropdown).
  // The bar reveals on message hover/focus via the parent `group`; the
  // assistant bar is always visible (resident).
  const compactResidentActions = isMobile && !isUser;
  const actionsBase =
    "msg-actions mt-1 flex gap-0.5 transition-opacity duration-[120ms] " +
    "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";
  const desktopBar = (
    <div
      className={`${actionsBase}${isUser ? " justify-end" : " resident opacity-100"}`}
    >
      <MessageAction
        label={copied ? "已复制" : "复制"}
        icon={
          <span className="copy-swap relative inline-flex h-[18px] w-[18px]" data-copied={copied}>
            <Icons.Copy
              size={18}
              className={`absolute inset-0 transition-opacity duration-[120ms]${copied ? " opacity-0" : ""}`}
            />
            <Icons.Check
              size={18}
              className={`absolute inset-0 transition-opacity duration-[120ms]${copied ? "" : " opacity-0"}`}
            />
          </span>
        }
        onClick={handleCopy}
        compact={compactResidentActions}
      />
      <MessageAction
        label={mutateLabel}
        icon={<MutateIcon size={18} />}
        onClick={mutate}
        disabled={disabled}
        compact={compactResidentActions}
        disabledReason={mutateDisabledReason}
      />
    </div>
  );

  // Mobile: assistant actions stay resident (the desktop bar already is — no
  // hover exists on touch); user actions open via long-press on the bubble.
  const actionBar =
    isMobile && isUser ? (
      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        ariaLabel="消息操作"
      >
        {sheetActions(() => setSheetOpen(false))}
      </BottomSheet>
    ) : (
      desktopBar
    );

  if (isUser && editing) {
    const save = () => {
      const trimmed = draft.trim();
      if (trimmed === "" && !hasEditedModelInput) return;
      setEditing(false);
      if (editedAttachmentIds === undefined) {
        onEditAndRegenerate?.(message.id, trimmed);
      } else {
        onEditAndRegenerate?.(message.id, trimmed, editedAttachmentIds);
      }
    };
    const cancel = () => {
      setDraft(message.content);
      setEditedAttachmentIds(undefined);
      setEditing(false);
    };
    return (
      <div className={`${msgBase} user items-end`}>
        {/* Editing uses a full-width panel rather than stretching the compact
            message bubble, matching the visual hierarchy of the reference. */}
        <div className="w-full animate-edit-in rounded-[24px] bg-sunken p-3">
          <div className="m-2 max-h-[25dvh] overflow-y-auto">
            <textarea
              autoFocus
              ref={editRef}
              className="block min-h-12 w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-[16px] leading-6 text-text-primary outline-none"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  save();
                }
                if (event.key === "Escape") cancel();
              }}
            />
          </div>
          {messageAttachments.length > 0 || readyComposerAttachments.length > 0 ? (
            <div className="mx-2 mt-2 rounded-control border border-border bg-surface p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12px] text-text-muted">
                  {editedAttachmentIds === undefined
                    ? "Keeping this message's original attachments."
                    : "This edit will replace the original attachments."}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {readyComposerAttachments.length > 0 && (
                    <button
                      type="button"
                      className="rounded-control border border-border px-2 py-1 text-[11.5px] text-text-muted hover:bg-hover hover:text-text-primary"
                      onClick={addComposerAttachments}
                      disabled={!canAddComposerAttachments}
                      title={
                        composerIdsToAdd.length === 0
                          ? "These attachments are already included."
                          : !canAddComposerAttachments
                            ? "Remove an attachment before adding these files."
                            : undefined
                      }
                    >
                      添加输入区附件
                    </button>
                  )}
                  {editedAttachmentIds !== undefined && (
                    <button
                      type="button"
                      className="rounded-control border border-border px-2 py-1 text-[11.5px] text-text-muted hover:bg-hover hover:text-text-primary"
                      onClick={() => setEditedAttachmentIds(undefined)}
                    >
                      恢复原附件
                    </button>
                  )}
                  {effectiveEditedAttachmentIds.length > 0 && (
                    <button
                      type="button"
                      className="rounded-control border border-border px-2 py-1 text-[11.5px] text-text-muted hover:bg-hover hover:text-text-primary"
                      onClick={() => setEditedAttachmentIds([])}
                    >
                      移除全部
                    </button>
                  )}
                </div>
              </div>
              {editedAttachments.length > 0 && (
                <div className="mt-2 flex flex-col gap-1.5">
                  {editedAttachments.map((attachment, index) => (
                    <AttachmentCard
                      key={attachment.id}
                      attachment={attachment}
                      mode="editor"
                      getReadUrl={onReadAttachment}
                      onRemove={removeEditedAttachment}
                      onMoveFile={moveEditedAttachment}
                      canMoveBack={index > 0}
                      canMoveForward={index < editedAttachments.length - 1}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 px-2 pt-2">
            <button
              className={`${buttonControl} h-9 rounded-full border border-border-strong bg-surface px-3 text-[14px] font-medium leading-5 hover:bg-hover`}
              onClick={cancel}
            >
              取消
            </button>
            <button
              className={`${primaryButton} h-9 rounded-full px-3 text-[14px] font-medium leading-5`}
              onClick={save}
              disabled={draft.trim() === "" && !hasEditedModelInput}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isUser) {
    const collapsed = overflowing && !expanded;
    return (
      <div className={`${msgBase} user items-end`}>
        <div
          className={`max-w-[70%] ${messageBubble}${
            isMobile ? " select-none [-webkit-touch-callout:none]" : ""
          }`}
          onTouchStart={isMobile ? startLongPress : undefined}
          onTouchEnd={isMobile ? cancelLongPress : undefined}
          onTouchMove={isMobile ? cancelLongPress : undefined}
          onTouchCancel={isMobile ? cancelLongPress : undefined}
          // Android fires contextmenu on long-press — keep the sheet, not the
          // system menu. (select-none/touch-callout cover iOS selection.)
          onContextMenu={isMobile ? (event) => event.preventDefault() : undefined}
        >
          <div className="relative">
            <div
              ref={contentRef}
              className="min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere"
              style={collapsed ? { maxHeight: `${COLLAPSE_MAX_HEIGHT}px`, overflow: "hidden" } : undefined}
            >
              {message.content}
            </div>
            {/* Fade the clipped last line into the bubble background. */}
            {collapsed && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-sunken to-transparent" />
            )}
          </div>
          {messageAttachments.length > 0 && (
            <MessageAttachments
              attachments={messageAttachments}
              onReadAttachment={onReadAttachment}
            />
          )}
          {overflowing && (
            <button
              className="mt-1.5 inline-flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-[13px] font-medium text-text-muted transition-colors duration-[120ms] hover:text-text-primary"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "收起" : "展开"}
              <Icons.Chevron
                size={13}
                className={`transition-transform duration-[160ms]${expanded ? " rotate-180" : ""}`}
              />
            </button>
          )}
        </div>
        {actionBar}
      </div>
    );
  }

  const sources = message.metadata?.sources ?? [];
  return (
    <div className={`${msgBase} assistant items-stretch`}>
      <div className="min-w-0 flex-1">
        {/* Pass the raw (possibly undefined) sources ref, not the `?? []`
            fallback, so Markdown's memo stays stable across unrelated re-renders
            (a fresh [] each render would bust it). */}
        <Markdown content={message.content} sources={message.metadata?.sources} isMobile={isMobile} />
        {messageAttachments.length > 0 && (
          <MessageAttachments
            attachments={messageAttachments}
            onReadAttachment={onReadAttachment}
          />
        )}
        {sources.length > 0 && (
          <SourcesTrigger sources={sources} onClick={() => onShowSources?.(sources)} />
        )}
        {actionBar}
      </div>
    </div>
  );
}

function MessageAttachments({
  attachments,
  onReadAttachment,
}: {
  attachments: NonNullable<MessageResponse["attachments"]>;
  onReadAttachment?: (fileId: string, role: FileReadRole) => Promise<{ url: string }>;
}) {
  return (
    <div className="mt-2 flex flex-col gap-1.5" aria-label="附件">
      {attachments.map((attachment) => (
        <AttachmentCard
          key={attachment.id}
          attachment={attachment}
          getReadUrl={onReadAttachment}
        />
      ))}
    </div>
  );
}

// ChatGPT-style trigger pill: stacked favicons of the first sources plus a
// 「来源」 label; clicking opens the sources side panel.
export function SourcesTrigger({
  sources,
  onClick,
}: {
  sources: MessageSource[];
  onClick: () => void;
}) {
  return (
    <button
      className={`${focusRing} mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-pill border border-border bg-sunken py-1 pr-3 pl-1.5 text-[12.5px] text-text-muted transition-colors duration-[120ms] hover:bg-hover hover:text-text-primary max-[760px]:min-h-11`}
      type="button"
      aria-label={`查看 ${sources.length} 个来源`}
      onClick={onClick}
    >
      <span className="flex items-center -space-x-1.5">
        {sources.slice(0, 3).map((source) => (
          <span
            key={`${source.id}:${source.url}`}
            className="inline-flex h-[18px] w-[18px] items-center justify-center overflow-hidden rounded-pill border border-border bg-surface"
          >
            <SourceFavicon url={source.url} size={12} />
          </span>
        ))}
      </span>
      来源
    </button>
  );
}
