import type {
  DraftAttachment,
  DraftAttachmentStatus,
  FileAttachment,
  FileCategory,
  FileUploadStatus,
} from "./types";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"]);
const OFFICE_EXTENSIONS = new Set(["docx", "pptx", "xlsx"]);
const DATA_EXTENSIONS = new Set([
  "csv", "tsv", "json", "yaml", "yml", "toml", "xml", "ini", "cfg", "conf", "properties", "env",
]);
const CODE_EXTENSIONS = new Set([
  "py", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "go", "java", "sql",
  "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "rs", "rb", "php", "kt", "kts", "swift",
  "scala", "dart", "lua", "pl", "r", "m", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", "graphql", "gql", "proto",
  "tf", "hcl", "gradle", "dockerfile", "makefile",
]);

export function fileExtension(name: string): string {
  const suffix = name.trim().split(".").at(-1);
  return suffix && suffix !== name ? suffix.toLowerCase() : "";
}

export function categoryForFileName(name: string): FileCategory {
  const extension = fileExtension(name);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (OFFICE_EXTENSIONS.has(extension)) return "office";
  if (DATA_EXTENSIONS.has(extension)) return "data";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  return "text";
}

export function categoryLimit(
  categoryMaxBytes: Record<string, number>,
  name: string,
): number | null {
  const extension = fileExtension(name);
  const category = categoryForFileName(name);
  const capabilityCategory = category === "data" || category === "code" ? "text" : category;
  // Accept both the product-level category form (office/text/image) and a
  // future per-extension capability without coupling the UI to either shape.
  return (
    categoryMaxBytes[extension] ??
    categoryMaxBytes[category] ??
    categoryMaxBytes[capabilityCategory] ??
    categoryMaxBytes.default ??
    null
  );
}

export function attachmentWarnings(
  attachment: Pick<FileAttachment, "warning" | "warnings">,
): string[] {
  return attachment.warning ?? attachment.warnings ?? [];
}

export function isUploadInProgress(status: DraftAttachmentStatus): boolean {
  return (
    status === "creating" ||
    status === "uploading" ||
    status === "pending" ||
    status === "queued" ||
    status === "processing"
  );
}

export function isUploadReady(status: DraftAttachmentStatus): boolean {
  return status === "succeeded";
}

export function isUploadFailed(status: DraftAttachmentStatus): boolean {
  return (
    status === "rejected" ||
    status === "failed" ||
    status === "expired" ||
    status === "cancelled"
  );
}

export function statusLabel(status: DraftAttachmentStatus): string {
  const labels: Record<DraftAttachmentStatus, string> = {
    creating: "Preparing upload",
    uploading: "Uploading",
    pending: "Waiting for confirmation",
    queued: "Queued for processing",
    processing: "Scanning and processing",
    succeeded: "Ready",
    rejected: "Rejected",
    failed: "Processing failed",
    expired: "Upload expired",
    cancelled: "Cancelled",
  };
  return labels[status];
}

/**
 * The only copy shown for any upload failure. Error codes stay on the draft
 * and in API responses for diagnosis and are never shown to the user.
 */
export const FILE_UPLOAD_FAILURE_LABEL = "文件上传失败，请稍后再试";

export function warningLabel(warning: string): string {
  const labels: Record<string, string> = {
    animated_image_first_frame_only: "Only the first frame is shown in the preview.",
    complexity_limit_exceeded: "The file is available to download, but it is too complex for the model to read.",
    csv_shape_limit_exceeded: "The CSV shape exceeds the normal analysis limits, but its text remains available to the model.",
    embedded_content_not_extracted: "Embedded files or objects were not read by the model.",
    external_links_not_extracted: "External links were not opened; only visible document text was read.",
    format_corrected: "The file type was detected from its contents and differs from its extension.",
    no_extractable_text: "No readable text was found, so the model cannot read this file.",
    partial_content_not_extracted: "Some visual or hidden content was not read by the model.",
    text_encoding_normalized: "The text encoding was converted safely for model input.",
  };
  return labels[warning] ?? warning;
}

export function draftFromUpload(
  draft: DraftAttachment,
  update: {
    status: FileUploadStatus;
    error_code: string | null;
    message?: string | null;
    file?: FileAttachment | null;
  },
): DraftAttachment {
  const file = update.file ?? null;
  return {
    ...draft,
    status: update.status,
    error_code: update.error_code,
    error_message: update.message ?? null,
    file,
    name: file?.name ?? draft.name,
    media_type: file?.media_type ?? draft.media_type,
    size_bytes: file?.size_bytes ?? draft.size_bytes,
    category: file?.category ?? draft.category,
  };
}

export function isPollingStatus(status: DraftAttachmentStatus): status is FileUploadStatus {
  return status === "pending" || status === "queued" || status === "processing";
}
