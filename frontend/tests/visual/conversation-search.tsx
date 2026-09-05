import { useEffect } from "react";
import { useAppActions } from "../../src/app/context";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AppProvider } from "../../src/app/AppProvider";
import { AppShell } from "../../src/app/AppShell";
import { ApiError } from "../../src/api/errors";
import { createAuthSession, tokenStore } from "../../src/auth/tokenStore";
import { authTokenResponse } from "../../src/test/apiFixtures";
import {
  createFakeServices,
  createFakeCapabilitiesApi,
} from "../../src/test/appHarness";
import { searchTextHash } from "../../src/search/searchText";
import "../../src/styles/global.css";

const now = new Date().toISOString();
const conversation = {
  id: "history-0",
  title: "历史搜索验收",
  created_at: now,
  updated_at: now,
  activated_at: now,
};
const content =
  "😀前文 **重点**内容和`跨节点`文字。\n\n" +
  Array.from(
    { length: 40 },
    (_, i) => `第 ${i + 1} 段较长的历史内容用于验证搜索后的滚动位置。`,
  ).join("\n\n");
const text =
  "😀前文 重点内容和跨节点文字。 " +
  Array.from(
    { length: 40 },
    (_, i) => `第 ${i + 1} 段较长的历史内容用于验证搜索后的滚动位置。`,
  ).join(" ");
const quote = "引用正文 ".repeat(100) + "😀引用哨兵";
const services = createFakeServices(
  { me: async () => authTokenResponse.user },
  {
    list: async () => [conversation],
    detail: async (id) => {
      if (id === "gone")
        throw new ApiError({ status: 404, message: "Missing" });
      return {
        ...conversation,
        id,
        messages: [
          {
            id: "user-original",
            conversation_id: id,
            role: "user",
            content: "请整理历史内容",
            reasoning: null,
            metadata: null,
            position: 1,
            created_at: now,
            run_id: null,
          },
          {
            id: "assistant-target",
            conversation_id: id,
            role: "assistant",
            content,
            reasoning: null,
            metadata: null,
            position: 2,
            created_at: now,
            run_id: null,
          },
          {
            id: "quote-target",
            conversation_id: id,
            role: "user",
            content: "收到",
            reasoning: null,
            metadata: null,
            position: 3,
            created_at: now,
            run_id: null,
            reply_quote: {
              excerpt: quote,
              source_message_id: "assistant-target",
              source_anchor: null,
            },
          },
        ],
      };
    },
    search: async ({ q, cursor }, signal) => {
      await new Promise((resolve) =>
        setTimeout(resolve, q === "慢" ? 700 : 35),
      );
      if (signal?.aborted) throw new Error("Aborted");
      if (q === "失败") throw new Error("Unavailable");
      if (q === "无结果") return { items: [], next_cursor: null };
      const start = Number(cursor || 0);
      const query = q || "重点";
      const isQuote = q === "引用哨兵";
      const sourceText = isQuote ? quote : text;
      const match = sourceText.indexOf(query);
      const hash = await searchTextHash(sourceText);
      return {
        items: Array.from(
          { length: q ? Math.min(30, 65 - start) : 10 },
          (_, i) => ({
            conversation_id: q === "失效" ? "gone" : `history-${start + i}`,
            title: `历史搜索验收 ${start + i + 1}`,
            updated_at: new Date(
              Date.now() - (start + i) * 86400000,
            ).toISOString(),
            title_match: null,
            snippet: q
              ? {
                  text: "😀前文 重点内容和跨节点文字。",
                  match: { start: 5, end: 7 },
                  truncated_before: false,
                  truncated_after: true,
                }
              : null,
            target:
              match >= 0 && q
                ? {
                    message_id: isQuote ? "quote-target" : "assistant-target",
                    field: isQuote
                      ? ("reply_quote" as const)
                      : ("body" as const),
                    start: match,
                    end: match + query.length,
                    projection_version: 1,
                    projection_hash: hash,
                  }
                : null,
          }),
        ),
        next_cursor: q && start + 30 < 65 ? String(start + 30) : null,
      };
    },
  },
  {},
  {
    get: async () => ({
      ...(await createFakeCapabilitiesApi().get()),
      conversation_search: { enabled: true },
    }),
  },
);
// eslint-disable-next-line react-refresh/only-export-components
function StreamControls() {
  const { dispatch, stateRef } = useAppActions();
  useEffect(() => {
    Object.assign(window, {
      pushSearchStream: () => {
        const conversationId = stateRef.current.conversationIndex.selectedId;
        if (!conversationId) return;
        dispatch({
          type: "run/started",
          runId: "stream-fixture",
          conversationId,
        });
        dispatch({
          type: "run/textDelta",
          seq: 1,
          text: "新增流式正文\n\n".repeat(100),
        });
      },
    });
  }, [dispatch, stateRef]);
  return null;
}
tokenStore.save(createAuthSession(authTokenResponse));
window.history.replaceState({}, "", "/c/history-0");
createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <AppProvider services={services}>
      <AppShell />
      <StreamControls />
    </AppProvider>
  </BrowserRouter>,
);
