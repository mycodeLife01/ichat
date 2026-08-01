import type {
  DraftAttachment,
  DraftAttachmentStatus,
  FileAttachment,
  FileCategory,
  FileUploadStatus,
} from "./types";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const OFFICE_EXTENSIONS = new Set(["docx", "pptx", "xlsx"]);
const DATA_EXTENSIONS = new Set(["csv", "json", "yaml", "yml"]);
const CODE_EXTENSIONS = new Set(["py", "js", "ts", "go", "java", "sql"]);

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

export function errorLabel(errorCode: string | null | undefined): string {
  if (!errorCode) return "The file could not be processed. Please try again.";
  const labels: Record<string, string> = {
    unsupported_type: "This file type is not supported.",
    file_too_large: "This file is larger than the allowed limit.",
    message_too_large: "The selected files exceed the message size limit.",
    invalid_encoding: "Please convert the file to UTF-8 and try again.",
    no_extractable_text: "No readable text was found in this document.",
    password_protected: "Remove the file password locally and try again.",
    file_expired: "This upload expired. Select the file again.",
    upload_cancelled: "This upload was cancelled.",
  };
  return labels[errorCode] ?? "The file could not be processed. Please try again.";
}

export function draftFromUpload(
  draft: DraftAttachment,
  update: {
    status: FileUploadStatus;
    error_code: string | null;
    message?: string | null;
    file: FileAttachment | null;
  },
): DraftAttachment {
  return {
    ...draft,
    status: update.status,
    error_code: update.error_code,
    error_message: update.message ?? null,
    file: update.file,
    name: update.file?.name ?? draft.name,
    media_type: update.file?.media_type ?? draft.media_type,
    size_bytes: update.file?.size_bytes ?? draft.size_bytes,
    category: update.file?.category ?? draft.category,
  };
}

export function isPollingStatus(status: DraftAttachmentStatus): status is FileUploadStatus {
  return status === "pending" || status === "queued" || status === "processing";
}
