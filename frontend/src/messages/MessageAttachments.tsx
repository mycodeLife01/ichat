import { useEffect, useRef } from "react";

import { AttachmentCard } from "../files/AttachmentCard";
import type {
  FileAttachment,
  FileReadRole,
  SharedAttachmentPlaceholder,
} from "../files/types";

/**
 * A materialized message attachment, either the owner's view (carrying a file
 * id) or a public snapshot placeholder (carrying a share-scoped ref). Both use
 * the same layout so the share page and the live thread look identical.
 */
export type DisplayAttachment = FileAttachment | SharedAttachmentPlaceholder;

function attachmentKey(attachment: DisplayAttachment, index: number): string {
  if ("id" in attachment) return attachment.id;
  return attachment.ref ?? `${attachment.name}-${index}`;
}

// Renders the attachment block above/below a message body: images grouped into
// a single-image or collection layout, files as compact cards. Consecutive
// attachments of the same kind stay in one group so ordering is preserved.
export function MessageAttachments({
  attachments,
  onReadAttachment,
  localImagePreviews,
  onLocalImagePreviewConsumed,
  align = "start",
}: {
  attachments: readonly DisplayAttachment[];
  onReadAttachment?: (fileId: string, role: FileReadRole) => Promise<{ url: string }>;
  localImagePreviews?: ReadonlyMap<string, string>;
  onLocalImagePreviewConsumed?: (fileId: string) => void;
  align?: "start" | "end";
}) {
  const isEnd = align === "end";
  const orderedAttachments = attachments
    .map((attachment, index) => ({ attachment, index }))
    .sort((left, right) =>
      (left.attachment.position ?? left.index) - (right.attachment.position ?? right.index),
    )
    .map(({ attachment }) => attachment);
  const localImageFileIds = orderedAttachments
    .filter(
      (attachment) =>
        attachment.category === "image" &&
        "id" in attachment &&
        localImagePreviews?.has(attachment.id),
    )
    .map((attachment) => ("id" in attachment ? attachment.id : ""))
    .filter((fileId) => fileId !== "");
  const localImageFileIdsRef = useRef(localImageFileIds);
  const previewReleaseTimerRef = useRef<number | null>(null);
  localImageFileIdsRef.current = localImageFileIds;

  useEffect(() => {
    if (previewReleaseTimerRef.current !== null) {
      window.clearTimeout(previewReleaseTimerRef.current);
      previewReleaseTimerRef.current = null;
    }
    return () => {
      if (!onLocalImagePreviewConsumed || localImageFileIdsRef.current.length === 0) return;
      const fileIds = [...localImageFileIdsRef.current];
      // Defer cleanup so React Strict Mode's effect replay can cancel it.
      previewReleaseTimerRef.current = window.setTimeout(() => {
        for (const fileId of fileIds) onLocalImagePreviewConsumed(fileId);
      }, 0);
    };
  }, [onLocalImagePreviewConsumed]);

  const imageCount = orderedAttachments.filter((attachment) => attachment.category === "image").length;
  const singleImage = imageCount === 1 && orderedAttachments.length === 1;
  const groups: Array<{
    kind: "images" | "files";
    items: DisplayAttachment[];
  }> = [];
  for (const attachment of orderedAttachments) {
    const kind = attachment.category === "image" ? "images" : "files";
    const previous = groups.at(-1);
    if (previous?.kind === kind) previous.items.push(attachment);
    else groups.push({ kind, items: [attachment] });
  }

  return (
    <div
      className={`flex w-full max-w-full flex-col gap-1 ${
        isEnd ? "items-end" : "mt-2 items-start"
      }`}
      aria-label="附件"
    >
      {groups.map((group, groupIndex) =>
        group.kind === "images" ? (
          <div
            key={`images-${groupIndex}`}
            className={`flex gap-1 ${
              singleImage
                ? `w-[70%] flex-col ${isEnd ? "items-end" : "items-start"}`
                : `max-w-72 flex-row flex-wrap ${isEnd ? "justify-end" : "justify-start"}`
            }`}
            data-attachment-group="images"
            data-image-layout={singleImage ? "single" : "collection"}
          >
            {group.items.map((attachment, index) => (
              <AttachmentCard
                key={attachmentKey(attachment, index)}
                attachment={attachment}
                mode={"id" in attachment ? "message" : "share"}
                getReadUrl={onReadAttachment}
                localPreviewUrl={
                  "id" in attachment ? localImagePreviews?.get(attachment.id) : undefined
                }
                imageLayout={singleImage ? "single" : "collection"}
                imageCollectionPosition={
                  index === 0 ? "first" : index === group.items.length - 1 ? "last" : "middle"
                }
              />
            ))}
          </div>
        ) : (
          <div
            key={`files-${groupIndex}`}
            className={`${groupIndex > 0 ? "mt-1 " : ""}flex max-w-[80%] flex-wrap gap-2 ${isEnd ? "justify-end" : "justify-start"}`}
            data-attachment-group="files"
          >
            {group.items.map((attachment, index) => (
              <AttachmentCard
                key={attachmentKey(attachment, index)}
                attachment={attachment}
                mode={"id" in attachment ? "message" : "share"}
                getReadUrl={onReadAttachment}
              />
            ))}
          </div>
        ),
      )}
    </div>
  );
}
