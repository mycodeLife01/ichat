import { useId, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  ClipboardPaste,
  LoaderCircle,
  RotateCcw,
  X,
} from "lucide-react";

import { ModalDialog } from "../ui/ModalDialog";
import { iconControl } from "../ui/classes";
import type { DraftAttachment, FileAttachment, SharedAttachmentPlaceholder } from "./types";
import { FILE_UPLOAD_FAILURE_LABEL, isUploadFailed, isUploadInProgress } from "./utils";
import {
  countChars,
  countLines,
  firstLine,
  formatCount,
  MESSAGE_CHAR_LIMIT,
  pastedText,
  rememberPastedText,
  usePastedTextActions,
  usePastedTextReader,
} from "./pastedText";

type Props = {
  attachment: FileAttachment | SharedAttachmentPlaceholder | DraftAttachment;
  mode?: "composer" | "message" | "share" | "editor";
  /** File id (owner) or share ref (public snapshot); null before processing. */
  readHandle: string | null;
  onCancel?: (clientId: string) => void;
  onRetry?: (clientId: string) => void;
};

const READ_TEXT_ERROR = "The pasted text could not be loaded. Please try again.";

function statValue(
  stats: Record<string, number | string> | undefined,
  key: "line_count" | "first_line",
): number | string | undefined {
  return stats?.[key];
}

// Pasted text keeps the file card's 60px height so it lines up with other
// files in the same row. In the composer it is 220px wide and its second line
// offers "在输入框中显示"; sent messages keep the 320px (240 on mobile) card
// with the line count. The text comes from this tab's memory when the paste
// happened here, otherwise from the text endpoint when it is first needed.
export function PastedTextCard({ attachment, mode = "message", readHandle, onCancel, onRetry }: Props) {
  const [open, setOpen] = useState(false);
  const [loadedText, setLoadedText] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const actions = usePastedTextActions();
  const readText = usePastedTextReader();
  const draft = "client_id" in attachment ? attachment : null;
  const file = draft ? draft.file : (attachment as FileAttachment | SharedAttachmentPlaceholder);
  const text = loadedText ?? pastedText(draft?.client_id, readHandle);
  const progress = draft && isUploadInProgress(draft.status);
  const failed = draft && isUploadFailed(draft.status);
  const composer = mode === "composer";
  const lineCount = text !== undefined ? countLines(text) : statValue(file?.stats, "line_count");
  const title =
    (text !== undefined ? firstLine(text) : String(statValue(file?.stats, "first_line") ?? "")) ||
    "粘贴的文本";
  const canExpand =
    composer &&
    draft !== null &&
    draft.status === "succeeded" &&
    actions !== null &&
    (text === undefined || countChars(text) <= MESSAGE_CHAR_LIMIT - actions.promptChars);
  const status = failed
    ? (draft.error_message ?? FILE_UPLOAD_FAILURE_LABEL)
    : progress
      ? "正在上传"
      : typeof lineCount === "number"
        ? `粘贴的文本 · ${formatCount(lineCount)} 行`
        : "粘贴的文本";
  const width = composer
    ? "w-[220px] min-w-[220px]"
    : "w-[320px] min-w-[320px] max-[760px]:w-[240px] max-[760px]:min-w-[240px]";

  const loadText = async (): Promise<string | null> => {
    if (text !== undefined) return text;
    if (!readHandle || !readText) {
      setReadError(READ_TEXT_ERROR);
      return null;
    }
    setLoading(true);
    setReadError(null);
    try {
      const value = await readText(readHandle);
      rememberPastedText(readHandle, value);
      setLoadedText(value);
      return value;
    } catch {
      setReadError(READ_TEXT_ERROR);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const openDialog = () => {
    setOpen(true);
    void loadText();
  };

  const expand = async () => {
    if (!draft || !actions) return;
    const value = await loadText();
    if (value === null) return;
    // Once the text is known, a paste that no longer fits hides the action.
    if (countChars(value) > MESSAGE_CHAR_LIMIT - actions.promptChars) return;
    actions.onExpand(draft.client_id, value);
  };

  return (
    <article
      role="group"
      aria-label="粘贴的文本"
      aria-busy={progress ? "true" : undefined}
      className={`group/attachment relative text-left ${width}`}
      data-attachment-status={draft?.status ?? "bound"}
      data-attachment-kind="pasted-text"
    >
      <div className="relative h-[60px]">
        <button
          type="button"
          className="absolute inset-0 grid rounded-[18px] border border-border bg-surface text-left transition-colors duration-[120ms] hover:bg-hover"
          aria-label="查看粘贴的文本"
          onClick={openDialog}
        />
        <div className="pointer-events-none relative z-[1] flex h-full min-w-0 items-center gap-2 p-2.5">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
            aria-hidden="true"
          >
            {progress ? (
              <LoaderCircle className="animate-spin text-text-muted" size={24} />
            ) : (
              <ClipboardPaste className="text-text-muted" size={24} />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold leading-5 text-text-primary">
              {title}
            </span>
            {canExpand && !failed && !progress ? (
              <button
                type="button"
                className="pointer-events-auto flex max-w-full items-center gap-0.5 text-[14px] leading-5 text-text-muted hover:text-text-primary"
                onClick={() => void expand()}
              >
                <span className="truncate underline underline-offset-[3px]">在输入框中显示</span>
                <ChevronRight className="shrink-0" size={15} aria-hidden="true" />
              </button>
            ) : (
              <span
                className={`flex min-w-0 items-center gap-1 truncate text-[14px] leading-5 ${
                  failed ? "text-error-foreground" : "text-text-muted"
                }`}
              >
                {failed && <AlertCircle className="shrink-0" size={13} />}
                <span className="truncate">{status}</span>
              </span>
            )}
          </span>
        </div>
        <div className="absolute -top-1 -right-1 z-[2] flex gap-1 opacity-0 transition-opacity duration-[120ms] group-focus-within/attachment:opacity-100 group-hover/attachment:opacity-100">
          {failed && onRetry && draft && (
            <button
              type="button"
              className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-text-muted shadow-popover hover:text-text-primary"
              aria-label="Retry upload"
              onClick={() => onRetry(draft.client_id)}
            >
              <RotateCcw size={13} />
            </button>
          )}
          {onCancel && draft && (
            <button
              type="button"
              className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-text-muted shadow-popover hover:text-text-primary"
              aria-label={progress ? "Cancel upload" : "Remove attachment"}
              onClick={() => onCancel(draft.client_id)}
            >
              <X size={15} />
            </button>
          )}
        </div>
      </div>
      {open && (
        <PastedTextDialog
          text={text}
          loading={loading}
          error={readError}
          onClose={() => setOpen(false)}
        />
      )}
    </article>
  );
}

function PastedTextDialog({
  text,
  loading,
  error,
  onClose,
}: {
  text: string | undefined;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const metaId = useId();

  return (
    <ModalDialog
      titleId={titleId}
      descriptionId={metaId}
      onClose={onClose}
      className="flex max-h-[min(80vh,720px)] w-full max-w-[720px] flex-col overflow-hidden"
      backdropClassName="z-50 p-6 max-[760px]:p-3"
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
        <ClipboardPaste className="mt-0.5 shrink-0 text-text-muted" size={20} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-[15px] font-semibold leading-6">
            粘贴的文本
          </h3>
          <p id={metaId} className="min-h-5 text-[13px] leading-5 text-text-muted">
            {text !== undefined &&
              `${formatCount(countLines(text))} 行 · ${formatCount(countChars(text))} 字符`}
          </p>
        </div>
        <button
          type="button"
          className={`${iconControl} h-8 w-8 shrink-0`}
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      {error ? (
        <p
          className="flex items-center gap-2 bg-sunken px-5 py-4 text-[14px] leading-5 text-error-foreground"
          role="alert"
        >
          <AlertCircle className="shrink-0" size={15} aria-hidden="true" />
          {error}
        </p>
      ) : text === undefined || loading ? (
        <div className="flex min-h-40 items-center justify-center bg-sunken" aria-busy="true">
          <LoaderCircle className="animate-spin text-text-muted" size={22} aria-label="正在加载" />
        </div>
      ) : (
        <pre
          className="min-h-0 flex-1 overflow-auto bg-sunken px-5 py-4 font-mono text-[13px] leading-[1.6] whitespace-pre-wrap break-words text-text-primary"
          tabIndex={0}
          aria-label="文本内容"
        >
          {text}
        </pre>
      )}
    </ModalDialog>
  );
}
