import type { ReactNode } from "react";

import type {
  MessageResponse,
  MessageSource,
  ReplyQuote,
  ReplyQuoteDraft,
} from "../api/types";
import type { FileReadRole } from "../files/types";
import { Message } from "./Message";
import { ReplyQuoteSelectionAction } from "./ReplyQuoteSelectionAction";
import { useReplyQuoteSelection } from "./useReplyQuoteSelection";

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
  conversationId?: string | null;
  onReplyQuote?: (replyQuote: ReplyQuoteDraft) => void;
  onReplyQuoteError?: (message: string) => void;
  onRevealReplyQuote?: (replyQuote: ReplyQuote) => void;
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
  conversationId = null,
  onReplyQuote,
  onReplyQuoteError,
  onRevealReplyQuote,
  children,
}: MessageThreadProps) {
  const { candidate, dismiss } = useReplyQuoteSelection(conversationId);
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

  // Desktop absorbs the fixed px-8 gutters around the shared 768px assistant
  // column. In the live mobile scrollport, viewport width compensates for a
  // classic scrollbar consuming inline space, keeping both content edges on
  // the same 16px gutters as the Composer. Other MessageThread hosts retain
  // their own containing-block width.
  return (
    <>
    <div className="thread-inner mx-auto flex w-full max-w-[calc(var(--assistant-content-width)+64px)] flex-1 flex-col gap-[35.2px] px-8 pt-10 pb-6 max-[760px]:[.thread-region_&]:w-screen max-[760px]:px-4 max-[760px]:pt-6 max-[760px]:pb-[18px]">
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
          onRevealReplyQuote={onRevealReplyQuote}
          pending={pending}
        />
      ))}
      {children}
    </div>
    {candidate && onReplyQuote && (
      <ReplyQuoteSelectionAction
        candidate={candidate}
        onSelect={(selected) => {
          if (Array.from(selected.excerpt).length > 4000) {
            onReplyQuoteError?.("Select no more than 4,000 characters to quote.");
            dismiss();
            return;
          }
          onReplyQuote({
            source_message_id: selected.sourceMessageId,
            excerpt: selected.excerpt,
            source_anchor: selected.sourceAnchor,
          });
          window.getSelection()?.removeAllRanges();
          dismiss();
        }}
      />
    )}
    </>
  );
}
