import type { MessageResponse } from "../api/types";
import { Message } from "./Message";

type MessageThreadProps = { messages: MessageResponse[] };

export function MessageThread({ messages }: MessageThreadProps) {
  return (
    <div className="thread-inner">
      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
    </div>
  );
}
