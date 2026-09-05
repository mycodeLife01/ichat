import { MessageThread } from "../../src/messages/MessageThread";
import type { MessageResponse } from "../../src/api/types";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Markdown } from "../../src/messages/Markdown";
import { buildVisibleSearchText } from "../../src/search/searchText";
import type { MessageSource } from "../../src/api/types";
import "../../src/styles/global.css";
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
Object.assign(window, {
  renderSearchFixture: (
    content: string,
    role: string,
    sources?: MessageSource[],
  ) => {
    flushSync(() =>
      root.render(
        <div>
          {role === "user" ? (
            content
          ) : (
            <Markdown content={content} sources={sources} />
          )}
        </div>,
      ),
    );
    return buildVisibleSearchText(rootElement).text;
  },
});

Object.assign(window, {
  renderSearchThread: async (messages: MessageResponse[]) => {
    const start = performance.now();
    flushSync(() =>
      root.render(
        <div style={{ height: 900, overflow: "auto" }}>
          <MessageThread messages={messages} />
        </div>,
      ),
    );
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    return {
      render_ms: performance.now() - start,
      messages: document.querySelectorAll(".msg").length,
    };
  },
});
