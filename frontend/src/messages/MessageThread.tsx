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
    <div className="thread-inner mx-auto flex w-full max-w-[var(--reading-width)] flex-1 flex-col gap-[35.2px] px-8 pt-10 pb-6 max-[760px]:px-[18px] max-[760px]:pt-6 max-[760px]:pb-[18px]">
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
