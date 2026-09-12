import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "../../src/api/errors";
import { replyQuoteDraftStore } from "../../src/conversations/replyQuoteDraftStore";
import { App } from "../../src/app/App";
import { AppProvider } from "../../src/app/AppProvider";
import { useAppActions, useAppState } from "../../src/app/context";
import { createAuthSession, tokenStore } from "../../src/auth/tokenStore";
import { modelAdminAccessKeyStore } from "../../src/model-admin/accessKeyStore";
import { createFakeServices } from "../../src/test/appHarness";
import { authTokenResponse } from "../../src/test/apiFixtures";
import {
  conversations,
  user,
  models,
  fileCapability,
  answer,
} from "../../../design/src/scenarios/data";
import { getScene } from "../../../design/src/scenarios/registry";
import { createResults } from "../../../design/src/runtime/results";
import { AuthScreen } from "../../src/auth/AuthScreen";
import "../../src/styles/global.css";
const scene = getScene(new URLSearchParams(location.search).get("scene"));
const data = conversations(scene.id === "long");
const result = createResults(scene, () => data);
for (const group of [result.authApi, result.shareApi, result.modelAdminApi]) {
  for (const [key, fn] of Object.entries(group)) {
    Object.assign(group, {
      [key]: async (...args: unknown[]) => {
        try {
          return await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
        } catch (error) {
          const value = error as { status?: number; message?: string };
          throw new ApiError({
            status: value.status ?? 500,
            message: value.message,
          });
        }
      },
    });
  }
}
const identity = { ...user, email_verified: scene.id !== "unverified" };
localStorage.clear();
sessionStorage.clear();
if (scene.group !== "认证")
  tokenStore.save(createAuthSession({ ...authTokenResponse, user: identity }));
if (scene.initial === "quote")
  replyQuoteDraftStore.write(1, "design-chat", {
    source_message_id: "10000000-0000-4000-8000-000000000001",
    excerpt: "设计的价值，是让我们在实现之前看见同一个结果。",
  });
if (scene.initial === "unlocked") modelAdminAccessKeyStore.save("design-demo");
const services = createFakeServices(
  {
    ...result.authApi,
    me: async () => identity,
    login: async (body) => ({
      ...authTokenResponse,
      user: await result.authApi.login(body),
    }),
    register: async (body) => ({
      ...authTokenResponse,
      user: await result.authApi.register(body),
    }),
  },
  {
    list: async (options) =>
      data.slice(
        options?.skip ?? 0,
        (options?.skip ?? 0) + (options?.limit ?? 30),
      ),
    detail: async (id) => data.find((c) => c.id === id) ?? data[0],
  },
  {},
  {
    get: async () => ({
      models,
      files: fileCapability,
      web_search: { enabled: true },
      conversation_search: { enabled: true },
    }),
  },
  {
    ...result.shareApi,
    create: (id, days, attachments) =>
      result.shareApi.create(id, days ?? null, attachments),
    readAttachment: async (token, ref, role) => ({
      ...(await result.shareApi.readAttachment(token, ref, role)),
      expires_at: "2099-01-01T00:00:00Z",
    }),
  },
  {
    readUrl: async (id) => ({
      ...(await result.filesApi.readUrl(id)),
      expires_at: "2099-01-01T00:00:00Z",
    }),
  },
  result.modelAdminApi,
);
function Setup() {
  const { dispatch } = useAppActions();
  const state = useAppState();
  useEffect(() => {
    if (!state.conversationDetail.conversation) return;

    if (scene.initial === "share")
      dispatch({
        type: "ui/openShare",
        dialog: { conversationId: "design-chat" },
      });
    if (scene.initial === "rail")
      dispatch({ type: "ui/toggleSidebarCollapsed" });
    if (
      ["thinking", "tool", "streaming", "failed", "cancelled"].includes(
        scene.initial ?? "",
      )
    )
      dispatch({
        type: "run/restored",
        runId: "design-run",
        conversationId: "design-chat",
        providerName: "deepseek",
        latestSeq: 0,
        draftText: ["streaming", "failed", "cancelled"].includes(scene.initial!)
          ? answer.slice(0, 180)
          : "",
        draftReasoning: "正在分析页面结构与交互状态。",
        draftReasoningSummary: "",
        status:
          scene.initial === "failed"
            ? "failed"
            : scene.initial === "cancelled"
              ? "cancelled"
              : "streaming",
      });
  }, [dispatch, state.conversationDetail.conversation]);
  return null;
}
createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={[scene.route]}>
    <AppProvider services={services}>
      <Setup />
      <Routes>
        <Route path="/login" element={<AuthScreen />} />
        <Route path="/register" element={<AuthScreen />} />
        <Route path="/forgot" element={<AuthScreen />} />
        <Route path="*" element={<App />} />
      </Routes>
    </AppProvider>
  </MemoryRouter>,
);
