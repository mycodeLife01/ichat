import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Download,
  Eye,
  FileCode2,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileType2,
  Image as ImageIcon,
  LoaderCircle,
  Presentation,
  RotateCcw,
  X,
} from "lucide-react";

import type { FileReadRole } from "./types";
import {
  attachmentWarnings,
  errorLabel,
  isUploadFailed,
  isUploadInProgress,
  fileExtension,
  statusLabel,
  warningLabel,
} from "./utils";
import type { DraftAttachment, FileAttachment, SharedAttachmentPlaceholder } from "./types";

type AttachmentDisplay = FileAttachment | SharedAttachmentPlaceholder | DraftAttachment;
type ReadUrlResolver = (fileId: string, role: FileReadRole) => Promise<{ url: string }>;

const READ_URL_CACHE_TTL_MS = 4 * 60 * 1_000;
const READ_URL_CACHE_LIMIT = 200;
const readUrlCache = new WeakMap<
  ReadUrlResolver,
  Map<string, { createdAt: number; request: Promise<string> }>
>();

function cachedReadUrl(
  getReadUrl: ReadUrlResolver,
  fileId: string,
  role: FileReadRole,
): Promise<string> {
  let cache = readUrlCache.get(getReadUrl);
  if (!cache) {
    cache = new Map();
    readUrlCache.set(getReadUrl, cache);
  }

  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.createdAt >= READ_URL_CACHE_TTL_MS) cache.delete(key);
  }
  const cacheKey = `${fileId}:${role}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached.request;

  const request = getReadUrl(fileId, role)
    .then(({ url }) => url)
    .catch((error: unknown) => {
      cache?.delete(cacheKey);
      throw error;
    });
  cache.set(cacheKey, { createdAt: now, request });
  if (cache.size > READ_URL_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return request;
}

type AttachmentCardProps = {
  attachment: AttachmentDisplay;
  mode?: "composer" | "message" | "share" | "editor";
  getReadUrl?: (fileId: string, role: FileReadRole) => Promise<{ url: string }>;
  localPreviewUrl?: string;
  onCancel?: (clientId: string) => void;
  onRetry?: (clientId: string) => void;
  onMove?: (clientId: string, direction: -1 | 1) => void;
  canMoveBack?: boolean;
  canMoveForward?: boolean;
  imageLayout?: "single" | "collection" | "mixed";
  imageCollectionPosition?: "first" | "middle" | "last";
};

function isDraftAttachment(attachment: AttachmentDisplay): attachment is DraftAttachment {
  return "client_id" in attachment;
}

function hasFileId(
  attachment: FileAttachment | SharedAttachmentPlaceholder,
): attachment is FileAttachment {
  return "id" in attachment;
}

/**
 * The handle a read URL is requested with: a file id for owner views, or the
 * share-scoped `ref` on a public snapshot. Returns null when the attachment
 * carries neither, which keeps preview/download disabled.
 */
function readHandle(
  attachment: FileAttachment | SharedAttachmentPlaceholder | null,
): string | null {
  if (attachment === null) return null;
  if (hasFileId(attachment)) return attachment.id;
  return attachment.ref ?? null;
}

function positiveDimension(value: number | string | undefined): number | null {
  const dimension = typeof value === "number" ? value : Number(value);
  return Number.isFinite(dimension) && dimension > 0 ? dimension : null;
}

function fittedImageFrame(
  width: number | null,
  height: number | null,
  maxWidth: number,
  maxHeight: number,
): CSSProperties | undefined {
  if (width === null || height === null) return undefined;
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, width * scale),
    height: Math.max(1, height * scale),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function attachmentTypeLabel(name: string, category: string): string {
  const extension = fileExtension(name);
  const labels: Record<string, string> = {
    csv: "CSV",
    docx: "Word 文档",
    go: "Go",
    java: "Java",
    js: "JavaScript",
    json: "JSON",
    md: "Markdown",
    pdf: "PDF",
    pptx: "演示文稿",
    py: "Python",
    sql: "SQL",
    txt: "文本文件",
    ts: "TypeScript",
    xlsx: "电子表格",
    yaml: "YAML",
    yml: "YAML",
  };
  if (labels[extension]) return labels[extension];
  if (category === "image") return "图片";
  return "文件";
}

function AttachmentTypeIcon({
  name,
  category,
  loading,
}: {
  name: string;
  category: string;
  loading: boolean;
}) {
  if (loading) {
    return <LoaderCircle className="animate-spin text-text-muted" size={24} />;
  }

  const extension = fileExtension(name);
  if (category === "image") {
    return <ImageIcon className="text-[#38aee8]" size={24} />;
  }
  if (extension === "xlsx" || extension === "csv") {
    return <FileSpreadsheet className="text-[#16a34a]" size={24} />;
  }
  if (extension === "pptx") {
    return <Presentation className="text-[#e85d24]" size={24} />;
  }
  if (extension === "docx") {
    return <FileType2 className="text-[#2b6fdb]" size={24} />;
  }
  if (extension === "json" || extension === "yaml" || extension === "yml") {
    return <FileJson className="text-[#d69e2e]" size={24} />;
  }
  if (category === "code") {
    return <FileCode2 className="text-text-primary" size={24} />;
  }
  if (extension === "pdf") {
    return <FileText className="text-[#e5484d]" size={24} />;
  }
  return <FileText className="text-search-foreground" size={24} />;
}

export function AttachmentCard({
  attachment,
  mode = "message",
  getReadUrl,
  localPreviewUrl,
  onCancel,
  onRetry,
  imageLayout = "single",
  imageCollectionPosition = "middle",
}: AttachmentCardProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [loadingRole, setLoadingRole] = useState<FileReadRole | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const previewRequestRef = useRef<Promise<string> | null>(null);
  const staticAttachment = isDraftAttachment(attachment) ? null : attachment;
  const draft = isDraftAttachment(attachment) ? attachment : null;
  const file = draft?.file ?? staticAttachment;
  const fileId = readHandle(file);
  const isImage = (file?.category ?? draft?.category) === "image";
  const warning = file ? attachmentWarnings(file) : [];
  const progress = draft && isUploadInProgress(draft.status);
  const failed = draft && isUploadFailed(draft.status);

  const resolvePreviewUrl = async (): Promise<string | null> => {
    if (draft?.local_preview_url) return draft.local_preview_url;
    if (localPreviewUrl) return localPreviewUrl;
    if (previewUrl) return previewUrl;
    if (!fileId || !getReadUrl || !file?.preview_available) return null;
    if (!previewRequestRef.current) {
      setLoadingRole("preview");
      setReadError(null);
      previewRequestRef.current = cachedReadUrl(getReadUrl, fileId, "preview")
        .then((url) => {
          setPreviewUrl(url);
          return url;
        })
        .catch((error: unknown) => {
          setReadError("The image could not be opened. Please try again.");
          throw error;
        })
        .finally(() => {
          previewRequestRef.current = null;
          setLoadingRole((role) => (role === "preview" ? null : role));
        });
    }
    try {
      return await previewRequestRef.current;
    } catch {
      return null;
    }
  };

  // Images without a transferable local preview need a signed thumbnail.
  // Freshly sent images keep their object URL for the current mounted view.
  useEffect(() => {
    if (
      !isImage ||
      draft?.local_preview_url ||
      localPreviewUrl ||
      previewUrl ||
      !file?.preview_available
    ) {
      return;
    }
    void resolvePreviewUrl();
    // resolvePreviewUrl intentionally keys on the stable file identity. Local
    // state updates must not start a second signed-URL request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, file?.preview_available, isImage, draft?.local_preview_url, localPreviewUrl]);

  const read = async (role: FileReadRole) => {
    if (role === "preview") {
      const url = await resolvePreviewUrl();
      if (url) setPreviewOpen(true);
      return;
    }
    if (!fileId || !getReadUrl || loadingRole) return;
    setLoadingRole(role);
    setReadError(null);
    try {
      const url = await cachedReadUrl(getReadUrl, fileId, role);
      const link = document.createElement("a");
      link.href = url;
      link.download = file?.name ?? draft?.name ?? "download";
      link.rel = "noopener noreferrer";
      link.click();
    } catch {
      setReadError("The file could not be opened. Please try again.");
    } finally {
      setLoadingRole(null);
    }
  };

  // A public snapshot renders with the same geometry as a live message; its
  // read capability is gated by the presence of a `ref` + resolver, not by mode.
  const isMessageLike = mode === "message" || mode === "share";
  if (
    (mode === "composer" && draft) ||
    ((isMessageLike || mode === "editor") && !draft)
  ) {
    const name = file?.name ?? draft?.name ?? "Attachment";
    const compactStatus = failed && draft
      ? draft.error_message ?? errorLabel(draft.error_code)
      : progress
        ? "正在上传"
        : attachmentTypeLabel(name, file?.category ?? draft?.category ?? "text");
    const readRole: FileReadRole = file?.preview_available ? "preview" : "download";
    const canRead = Boolean(fileId && getReadUrl);
    const category = file?.category ?? draft?.category ?? "text";
    const buttonLabel = isMessageLike
      ? readRole === "preview"
        ? "Preview image"
        : "Download original file"
      : name;

    if (isImage) {
      const immediatePreviewUrl = draft?.local_preview_url ?? localPreviewUrl;
      const imageUrl = immediatePreviewUrl ?? previewUrl;
      const canPreview = Boolean(imageUrl || (fileId && getReadUrl && file?.preview_available));
      const isComposer = mode === "composer" || mode === "editor";
      const isCollection = imageLayout !== "single";
      const isMixedComposerImage = isComposer && imageLayout === "mixed";
      const collectionRadius =
        imageCollectionPosition === "first"
          ? "rounded-lg rounded-s-2xl"
          : imageCollectionPosition === "last"
            ? "rounded-lg rounded-e-2xl"
            : "rounded-lg";
      const imageStats = file?.stats;
      const imageWidth = positiveDimension(imageStats?.width);
      const imageHeight = positiveDimension(imageStats?.height);
      const isLandscapeMessageImage =
        isMessageLike &&
        !isCollection &&
        imageWidth !== null &&
        imageHeight !== null &&
        imageWidth > imageHeight;
      const singleMessageImageClass = isLandscapeMessageImage
        ? "max-h-64 max-w-96"
        : "max-h-96 max-w-64";
      // Reserve the final single-image box while its signed preview loads.
      // Landscape images use ChatGPT's wider 384 x 256 bounds, while portrait
      // images retain the established 256 x 384 bounds.
      const imageFrameStyle = isMessageLike && !isCollection
        ? fittedImageFrame(
            imageWidth,
            imageHeight,
            isLandscapeMessageImage ? 384 : 256,
            isLandscapeMessageImage ? 256 : 384,
          )
        : undefined;
      const imageFrameClass = isComposer
        ? isMixedComposerImage
          ? "h-[60px] w-14 rounded-xl"
          : isCollection
          ? "h-20 w-20 rounded-[18px]"
          : imageUrl
            ? "max-h-[120px] max-w-[160px] rounded-[18px]"
            : "h-[120px] w-[120px] rounded-[18px]"
        : isCollection
          ? `h-32 w-32 ${collectionRadius}`
          : imageUrl
            ? `${singleMessageImageClass} rounded-[28px]`
            : "h-40 w-40 rounded-[28px]";
      const imageClass = isComposer
        ? isCollection
          ? "h-full w-full"
          : "max-h-[120px] max-w-[160px]"
        : isCollection
          ? "h-full w-full"
          : singleMessageImageClass;

      return (
        <article
          role="group"
          aria-label={name}
          aria-busy={progress ? "true" : undefined}
          className={`group/attachment relative shrink-0 text-left ${imageFrameClass}`}
          style={imageFrameStyle}
          data-attachment-status={draft?.status ?? "bound"}
          data-attachment-kind="image"
        >
          <button
            type="button"
            className={`relative block overflow-hidden border border-border bg-sunken transition-opacity duration-[120ms] enabled:hover:opacity-90 disabled:cursor-default ${imageFrameClass}`}
            style={imageFrameStyle}
            aria-label={`打开图片：${name}`}
            disabled={!canPreview}
            onClick={() => void read("preview")}
          >
            {imageUrl ? (
              <img
                key={
                  localPreviewUrl
                    ? "local-preview"
                    : previewUrl
                      ? "remote-preview"
                      : "image-preview"
                }
                className={`block object-cover ${imageClass}`}
                src={imageUrl}
                alt={name}
              />
            ) : (
              <span className="flex h-full min-h-20 w-full min-w-20 items-center justify-center text-text-muted">
                <ImageIcon size={24} aria-hidden="true" />
              </span>
            )}
            {(progress || (loadingRole === "preview" && !localPreviewUrl)) && (
              <span className="absolute inset-0 flex items-center justify-center bg-black/25 text-white">
                <LoaderCircle className="animate-spin" size={24} aria-label="正在上传" />
              </span>
            )}
            {failed && (
              <span className="absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1 text-[11px] text-white">
                上传失败
              </span>
            )}
          </button>
          {isMessageLike && !file?.preview_available && fileId && getReadUrl && (
            <button
              type="button"
              className="absolute right-1 bottom-1 z-[2] inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface/90 text-text-muted shadow-popover hover:bg-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-60"
              aria-label="Download original file"
              disabled={loadingRole === "download"}
              onClick={() => void read("download")}
            >
              {loadingRole === "download" ? (
                <LoaderCircle className="animate-spin" size={15} />
              ) : (
                <Download size={15} />
              )}
            </button>
          )}
          {draft && (
            <div className="absolute -top-1 -right-1 z-[2] flex gap-1 opacity-0 transition-opacity duration-[120ms] group-focus-within/attachment:opacity-100 group-hover/attachment:opacity-100">
              {failed && onRetry && (
                <button
                  type="button"
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-text-muted shadow-popover hover:text-text-primary"
                  aria-label="Retry upload"
                  onClick={() => onRetry(draft.client_id)}
                >
                  <RotateCcw size={13} />
                </button>
              )}
              {onCancel && (
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
          )}
          <div className="sr-only">
            {readError && <p>{readError}</p>}
            {file && file.model_input_kind === null && (
              <p>File available for download — the model cannot read its contents.</p>
            )}
            {warning.map((item) => (
              <p key={item}>{warningLabel(item)}</p>
            ))}
          </div>
          {previewOpen && imageUrl && (
            <ImagePreviewDialog
              name={name}
              url={imageUrl}
              onClose={() => setPreviewOpen(false)}
              onDownload={fileId && getReadUrl ? () => void read("download") : undefined}
              downloading={loadingRole === "download"}
            />
          )}
        </article>
      );
    }

    return (
      <article
        role="group"
        aria-label={name}
        aria-busy={progress ? "true" : undefined}
        className="group/attachment relative w-[320px] min-w-[320px] text-left max-[760px]:w-[240px] max-[760px]:min-w-[240px]"
        data-attachment-status={draft?.status ?? "bound"}
      >
        <div className="relative h-[60px]">
          <button
            type="button"
            className="absolute inset-0 grid rounded-[18px] border border-border bg-surface text-left transition-colors duration-[120ms] enabled:hover:bg-hover disabled:cursor-default"
            aria-label={buttonLabel}
            disabled={!canRead}
            onClick={() => void read(readRole)}
          />
          <div className="pointer-events-none relative z-[1] flex h-full min-w-0 items-center gap-2 p-2.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" aria-hidden="true">
              <AttachmentTypeIcon
                name={name}
                category={category}
                loading={Boolean(progress)}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold leading-5 text-text-primary">
                {name}
              </span>
              <span
                className={`flex min-w-0 items-center gap-1 truncate text-[14px] leading-5 ${
                  failed ? "text-error-foreground" : "text-text-muted"
                }`}
              >
                {failed && <AlertCircle className="shrink-0" size={13} />}
                <span className="truncate">{readError ?? compactStatus}</span>
              </span>
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
        <div className="sr-only">
          {file && file.model_input_kind === null && (
            <p>File available for download — the model cannot read its contents.</p>
          )}
          {warning.map((item) => (
            <p key={item}>{warningLabel(item)}</p>
          ))}
        </div>
      </article>
    );
  }

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
          {file && file.model_input_kind === null && (
            <p className="mt-1 text-[11.5px] text-text-muted">
              File available for download — the model cannot read its contents.
            </p>
          )}
          {warning.map((item) => (
            <p key={item} className="mt-1 text-[11.5px] text-warning-foreground">
              {warningLabel(item)}
            </p>
          ))}
          {readError && <p className="mt-1 text-[11.5px] text-error-foreground">{readError}</p>}
        </div>
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

function ImagePreviewDialog({
  name,
  url,
  onClose,
  onDownload,
  downloading,
}: {
  name: string;
  url: string;
  onClose: () => void;
  onDownload?: () => void;
  downloading: boolean;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeHandlerRef = useRef(onClose);
  closeHandlerRef.current = onClose;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeHandlerRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[rgba(0,0,0,0.9)]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <h2 id={titleId} className="sr-only">{name}</h2>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative max-h-[85vh] max-w-[90vw] outline-none"
      >
        <img className="max-h-[85vh] max-w-[90vw] object-contain" src={url} alt={name} />
      </div>
      <div className="absolute top-3 right-3 flex items-center gap-1 text-white">
        {onDownload && (
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
            aria-label="Download original file"
            disabled={downloading}
            onClick={onDownload}
          >
            {downloading ? <LoaderCircle className="animate-spin" size={20} /> : <Download size={20} />}
          </button>
        )}
        <button
          ref={closeRef}
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10"
          aria-label="关闭图片预览"
          data-dialog-initial-focus
          onClick={onClose}
        >
          <X size={22} />
        </button>
      </div>
    </div>,
    document.body,
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
