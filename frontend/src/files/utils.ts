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
    account_inactive: "This account can no longer use the uploaded file.",
    animated_image: "Animated images are not supported.",
    cell_limit_exceeded: "This spreadsheet is too complex for the model to read.",
    content_type_mismatch: "The browser-reported file type could not be accepted.",
    csv_column_limit_exceeded: "The CSV file has too many columns.",
    csv_row_limit_exceeded: "The CSV file has too many rows.",
    document_node_limit_exceeded: "This document is too complex for the model to read.",
    encrypted_document: "Remove the file password locally and try again.",
    external_reference_not_allowed: "This Office file contains an external data connection that cannot be read safely.",
    file_format_mismatch: "The file contents do not match the filename extension.",
    file_too_large: "This file is larger than the allowed limit.",
    image_dimensions_exceeded: "The image dimensions are too large.",
    image_pixel_limit_exceeded: "The image contains too many pixels.",
    invalid_image: "The image is damaged or uses an unsupported encoding.",
    invalid_ooxml: "The Office file is damaged or has an unsupported internal format.",
    invalid_pdf: "The PDF is damaged or has an unsupported internal format.",
    invalid_text_encoding: "Please convert the file to UTF-8 or UTF-16 and try again.",
    message_too_large: "The selected files exceed the message size limit.",
    malware_detected: "The file did not pass the security scan.",
    manifest_conflict: "File processing could not be completed safely. Please try again.",
    nested_archive_not_allowed: "The Office file contains an embedded file that cannot be read.",
    invalid_encoding: "Please convert the file to UTF-8 and try again.",
    no_extractable_text: "No readable text was found in this document.",
    nul_byte_not_allowed: "The text file contains unsupported binary data.",
    ooxml_compression_ratio_exceeded: "The Office file exceeds safe compression limits.",
    ooxml_entry_limit_exceeded: "The Office file contains too many internal parts.",
    ooxml_size_limit_exceeded: "The expanded Office file is too large.",
    ooxml_type_mismatch: "The Office file contents do not match the filename extension.",
    object_changed: "The uploaded file changed before processing. Upload it again.",
    original_changed: "The uploaded file could not be preserved exactly.",
    parser_failed: "The file could not be read. Please try again.",
    pdf_page_limit_exceeded: "The PDF has too many pages for the model to read.",
    password_protected: "Remove the file password locally and try again.",
    processing_failed: "File processing failed. Please try again.",
    resource_limit: "The file exceeds safe processing limits.",
    scanner_signatures_stale: "Security scanning is temporarily unavailable.",
    scanner_unavailable: "Security scanning is temporarily unavailable.",
    slide_limit_exceeded: "The presentation has too many slides for the model to read.",
    unsafe_archive_path: "The Office file has an unsafe or damaged internal structure.",
    unsafe_xml: "The Office file contains unsupported XML declarations.",
    unsupported_file_type: "This file type is not supported.",
    unsupported_type: "This file type is not supported.",
    file_expired: "This upload expired. Select the file again.",
    upload_expired: "This upload expired. Select the file again.",
    upload_failed: "The upload failed. Please try again.",
    upload_cancelled: "This upload was cancelled.",
    worksheet_limit_exceeded: "The spreadsheet has too many sheets for the model to read.",
  };
  return labels[errorCode] ?? "The file could not be processed. Please try again.";
}

export function warningLabel(warning: string): string {
  const labels: Record<string, string> = {
    animated_image_first_frame_only: "Only the first frame is shown in the preview.",
    complexity_limit_exceeded: "The file is available to download, but it is too complex for the model to read.",
    csv_shape_limit_exceeded: "The CSV shape exceeds the normal analysis limits, but its text remains available to the model.",
    embedded_content_not_extracted: "Embedded files or objects were not read by the model.",
    external_links_not_extracted: "External links were not opened; only visible document text was read.",
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
