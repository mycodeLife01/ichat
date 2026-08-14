import type { ReactNode } from "react";

import type { MessageResponse, MessageSource } from "../api/types";
import type { FileReadRole } from "../files/types";
import { messageBubble } from "../ui/classes";
import { Message } from "./Message";

type MessageThreadProps = {
  messages: MessageResponse[];
  pendingMessage?: string | null;
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
  // Horizontal geometry mirrors the composer (px-8 gutter outside a
  // --reading-width box, px-4 on mobile): the max-width absorbs the gutter so
  // the content edges line up with the composer surface.
  return (
    <div className="thread-inner mx-auto flex w-full max-w-[calc(var(--reading-width)+4rem)] flex-1 flex-col gap-[35.2px] px-8 pt-10 pb-6 max-[760px]:px-4 max-[760px]:pt-6 max-[760px]:pb-[18px]">
      {messages.map((message) => (
        <Message
          key={message.id}
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
          onLocalImagePreviewConsumed={onLocalImagePreviewConsumed}
          onShowSources={onShowSources}
        />
      ))}
      {pendingMessage && (
        <div
          className="msg user flex scroll-mt-[60px] flex-col items-end gap-1.5"
          data-state="pending"
        >
          <div
            className={`max-w-[70%] ${messageBubble} whitespace-pre-wrap wrap-anywhere`}
            aria-busy="true"
          >
            {pendingMessage}
          </div>
          {/* Reserve the height of the desktop action bar (28px button + mt-1)
              so the server-confirmed message doesn't grow taller and push the
              thinking status down. Mobile user messages have no inline bar. */}
          {!isMobile && <div className="msg-actions mt-1 h-7" aria-hidden="true" />}
        </div>
      )}
      {children}
    </div>
  );
}
