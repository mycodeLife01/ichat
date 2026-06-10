import type { ReactNode } from "react";

import type { MessageResponse } from "../api/types";
import { Message } from "./Message";

type MessageThreadProps = {
  messages: MessageResponse[];
  isMobile?: boolean;
  mutateDisabledReason?: string | null;
  onEditAndRegenerate?: (messageId: number, content: string) => void;
  onRegenerate?: (messageId: number) => void;
  children?: ReactNode;
};

export function MessageThread({
  messages,
  isMobile = false,
  mutateDisabledReason = null,
  onEditAndRegenerate,
  onRegenerate,
  children,
}: MessageThreadProps) {
  return (
    <div className="thread-inner">
      {messages.map((message) => (
        <Message
          key={message.id}
          message={message}
          isMobile={isMobile}
          mutateDisabledReason={mutateDisabledReason}
          onEditAndRegenerate={onEditAndRegenerate}
          onRegenerate={onRegenerate}
        />
      ))}
      {children}
    </div>
  );
}
