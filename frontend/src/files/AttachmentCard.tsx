import { useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  RotateCcw,
  X,
} from "lucide-react";

import type { FileReadRole } from "./types";
import { attachmentWarnings, errorLabel, isUploadFailed, isUploadInProgress, statusLabel } from "./utils";
import type { DraftAttachment, FileAttachment, SharedAttachmentPlaceholder } from "./types";

type AttachmentDisplay = FileAttachment | SharedAttachmentPlaceholder | DraftAttachment;

type AttachmentCardProps = {
  attachment: AttachmentDisplay;
  mode?: "composer" | "message" | "share" | "editor";
  getReadUrl?: (fileId: string, role: FileReadRole) => Promise<{ url: string }>;
  onCancel?: (clientId: string) => void;
  onRetry?: (clientId: string) => void;
  onMove?: (clientId: string, direction: -1 | 1) => void;
  canMoveBack?: boolean;
  canMoveForward?: boolean;
  onRemove?: (fileId: string) => void;
  onMoveFile?: (fileId: string, direction: -1 | 1) => void;
};

function isDraftAttachment(attachment: AttachmentDisplay): attachment is DraftAttachment {
  return "client_id" in attachment;
}

function hasFileId(
  attachment: FileAttachment | SharedAttachmentPlaceholder,
): attachment is FileAttachment {
  return "id" in attachment;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

export function AttachmentCard({
  attachment,
  mode = "message",
  getReadUrl,
  onCancel,
  onRetry,
  onMove,
  canMoveBack = false,
  canMoveForward = false,
  onRemove,
  onMoveFile,
}: AttachmentCardProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loadingRole, setLoadingRole] = useState<FileReadRole | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const staticAttachment = isDraftAttachment(attachment) ? null : attachment;
  const draft = isDraftAttachment(attachment) ? attachment : null;
  const file = draft?.file ?? staticAttachment;
  const fileId = file && hasFileId(file) ? file.id : null;
  const isImage = (file?.category ?? draft?.category) === "image";
  const warning = file ? attachmentWarnings(file) : [];
  const progress = draft && isUploadInProgress(draft.status);
  const failed = draft && isUploadFailed(draft.status);

  const read = async (role: FileReadRole) => {
    if (!fileId || !getReadUrl || loadingRole) return;
    setLoadingRole(role);
    setReadError(null);
    try {
      const { url } = await getReadUrl(fileId, role);
      if (role === "preview") {
        setPreviewUrl(url);
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.download = file?.name ?? draft?.name ?? "download";
        link.rel = "noopener noreferrer";
        link.click();
      }
    } catch {
      setReadError("The file could not be opened. Please try again.");
    } finally {
      setLoadingRole(null);
    }
  };

  return (
    <article
      className="rounded-item border border-border bg-surface px-3 py-2.5 text-left"
      data-attachment-status={draft?.status ?? "bound"}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-text-muted" aria-hidden="true">
          {isImage ? <ImageIcon size={18} /> : <FileText size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-text-primary">{file?.name ?? draft?.name}</p>
          <p className="mt-0.5 text-[11.5px] text-text-muted">
            {file?.media_type ?? draft?.media_type} · {formatBytes(file?.size_bytes ?? draft?.size_bytes ?? 0)}
          </p>
          {draft && (
            <p
              className={`mt-1 flex items-center gap-1 text-[11.5px] ${
                failed ? "text-error-foreground" : "text-text-muted"
              }`}
            >
              {progress && <LoaderCircle className="animate-spin" size={12} aria-hidden="true" />}
              {failed && <AlertCircle size={12} aria-hidden="true" />}
              {statusLabel(draft.status)}
            </p>
          )}
          {failed && (
            <p className="mt-1 text-[11.5px] text-error-foreground">
              {draft.error_message ?? errorLabel(draft.error_code)}
            </p>
          )}
          {file?.model_consumable === false && (
            <p className="mt-1 text-[11.5px] text-text-muted">
              Image preview only — the model cannot read this image.
            </p>
          )}
          {warning.map((item) => (
            <p key={item} className="mt-1 text-[11.5px] text-warning-foreground">
              {item}
            </p>
          ))}
          {readError && <p className="mt-1 text-[11.5px] text-error-foreground">{readError}</p>}
        </div>
        {mode === "composer" && draft && (
          <div className="flex shrink-0 items-center gap-0.5">
            {failed && onRetry && (
              <CardButton label="Retry upload" onClick={() => onRetry(draft.client_id)}>
                <RotateCcw size={14} />
              </CardButton>
            )}
            {onMove && (
              <>
                <CardButton
                  label="Move attachment earlier"
                  disabled={!canMoveBack}
                  onClick={() => onMove(draft.client_id, -1)}
                >
                  <ChevronLeft size={15} />
                </CardButton>
                <CardButton
                  label="Move attachment later"
                  disabled={!canMoveForward}
                  onClick={() => onMove(draft.client_id, 1)}
                >
                  <ChevronRight size={15} />
                </CardButton>
              </>
            )}
            {onCancel && (
              <CardButton label={progress ? "Cancel upload" : "Remove attachment"} onClick={() => onCancel(draft.client_id)}>
                <X size={15} />
              </CardButton>
            )}
          </div>
        )}
        {mode === "editor" && fileId && (
          <div className="flex shrink-0 items-center gap-0.5">
            {onMoveFile && (
              <>
                <CardButton
                  label="Move attachment earlier"
                  disabled={!canMoveBack}
                  onClick={() => onMoveFile(fileId, -1)}
                >
                  <ChevronLeft size={15} />
                </CardButton>
                <CardButton
                  label="Move attachment later"
                  disabled={!canMoveForward}
                  onClick={() => onMoveFile(fileId, 1)}
                >
                  <ChevronRight size={15} />
                </CardButton>
              </>
            )}
            {onRemove && (
              <CardButton label="Remove attachment" onClick={() => onRemove(fileId)}>
                <X size={15} />
              </CardButton>
            )}
          </div>
        )}
      </div>

      {fileId && getReadUrl && file?.preview_available && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <CardTextButton
            label="Preview image"
            loading={loadingRole === "preview"}
            onClick={() => void read("preview")}
          >
            <Eye size={13} />
            预览
          </CardTextButton>
          <CardTextButton
            label="Download original file"
            loading={loadingRole === "download"}
            onClick={() => void read("download")}
          >
            <Download size={13} />
            下载
          </CardTextButton>
        </div>
      )}
      {fileId && getReadUrl && !file?.preview_available && (
        <div className="mt-2">
          <CardTextButton
            label="Download original file"
            loading={loadingRole === "download"}
            onClick={() => void read("download")}
          >
            <Download size={13} />
            下载
          </CardTextButton>
        </div>
      )}
      {previewUrl && (
        <img
          className="mt-2 max-h-64 max-w-full rounded-control border border-border object-contain"
          src={previewUrl}
          alt={`${file?.name ?? "Attachment"} preview`}
        />
      )}
    </article>
  );
}

function CardButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="inline-flex h-7 w-7 items-center justify-center rounded-control text-text-muted hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function CardTextButton({
  label,
  loading,
  onClick,
  children,
}: {
  label: string;
  loading: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="inline-flex h-7 items-center gap-1 rounded-control border border-border px-2 text-[11.5px] text-text-muted hover:bg-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-60"
      aria-label={label}
      disabled={loading}
      onClick={onClick}
    >
      {loading ? <LoaderCircle className="animate-spin" size={13} aria-hidden="true" /> : children}
    </button>
  );
}
