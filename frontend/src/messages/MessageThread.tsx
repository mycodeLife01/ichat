import type { ReactNode } from "react";

import type { MessageResponse, MessageSource } from "../api/types";
import type { FileReadRole } from "../files/types";
import { Message } from "./Message";

type MessageThreadProps = {
  messages: MessageResponse[];
  pendingMessage?: MessageResponse | null;
  pendingMessageKey?: string;
  messageRenderKeys?: ReadonlyMap<string, string>;
  isMobile?: boolean;
  mutateDisabledReason?: string | null;
  onEditAndRegenerate?: (
    messageId: string,
    content: string,
    attachmentIds?: string[],
  ) => void;
  onRegenerate?: (messageId: string) => void;
  legacyMessageId?: string | null;
  onUpgradeLegacy?: (messageId: string) => void;
  onEditUpgradeLegacy?: (messageId: string) => boolean | void | Promise<boolean | void>;
  onStartNewConversation?: () => void;
  onReadAttachment?: (fileId: string, role: FileReadRole) => Promise<{ url: string }>;
  localImagePreviews?: ReadonlyMap<string, string>;
  onLocalImagePreviewConsumed?: (fileId: string) => void;
  onShowSources?: (sources: MessageSource[]) => void;
  children?: ReactNode;
};

export function MessageThread({
  messages,
  pendingMessage = null,
  pendingMessageKey,
  messageRenderKeys,
  isMobile = false,
  mutateDisabledReason = null,
  onEditAndRegenerate,
  onRegenerate,
  legacyMessageId = null,
  onUpgradeLegacy,
  onEditUpgradeLegacy,
  onStartNewConversation,
  onReadAttachment,
  localImagePreviews,
  onLocalImagePreviewConsumed,
  onShowSources,
  children,
}: MessageThreadProps) {
  // Keep optimistic and server-materialized user messages in one flat keyed
  // list. The committed message reuses the client's render key, so React keeps
  // the AttachmentCard and its already-decoded image node mounted.
  const displayMessages = messages.map((message) => ({
    message,
    renderKey: messageRenderKeys?.get(message.id) ?? message.id,
    pending: false,
  }));
  if (pendingMessage) {
    displayMessages.push({
      message: pendingMessage,
      renderKey: pendingMessageKey ?? pendingMessage.id,
      pending: true,
    });
  }

  // Horizontal geometry mirrors the composer (px-8 gutter outside a
  // --reading-width box, px-4 on mobile): the max-width absorbs the gutter so
  // the content edges line up with the composer surface.
  return (
    <div className="thread-inner mx-auto flex w-full max-w-[calc(var(--reading-width)+4rem)] flex-1 flex-col gap-[35.2px] px-8 pt-10 pb-6 max-[760px]:px-4 max-[760px]:pt-6 max-[760px]:pb-[18px]">
      {displayMessages.map(({ message, renderKey, pending }) => (
        <Message
          key={renderKey}
          message={message}
          isMobile={isMobile}
          mutateDisabledReason={mutateDisabledReason}
          onEditAndRegenerate={onEditAndRegenerate}
          onRegenerate={onRegenerate}
          legacyUpgradeAvailable={legacyMessageId === message.id}
          onUpgradeLegacy={onUpgradeLegacy}
          onEditUpgradeLegacy={onEditUpgradeLegacy}
          onStartNewConversation={onStartNewConversation}
          onReadAttachment={onReadAttachment}
          localImagePreviews={localImagePreviews}
          // The optimistic view borrows the Blob URL but does not own cleanup.
          // Ownership starts once the server-materialized message takes over.
          onLocalImagePreviewConsumed={pending ? undefined : onLocalImagePreviewConsumed}
          onShowSources={onShowSources}
          pending={pending}
        />
      ))}
      {children}
    </div>
  );
}
