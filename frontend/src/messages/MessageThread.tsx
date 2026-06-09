import type { ReactNode } from "react";

import type { MessageResponse } from "../api/types";
import { Message } from "./Message";

type MessageThreadProps = { messages: MessageResponse[]; children?: ReactNode };

export function MessageThread({ messages, children }: MessageThreadProps) {
  return (
    <div className="thread-inner">
      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
      {children}
    </div>
  );
}
