import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import type { ConversationApi } from "../api/conversations";
import { AppProvider } from "../app/AppProvider";
import type { AuthApi, Services } from "../app/context";
import {
  authTokenResponse,
  conversationDetailResponse,
  conversationResponse,
  sendMessageResponse,
} from "./apiFixtures";

export function createFakeAuthApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    register: async () => authTokenResponse,
    login: async () => authTokenResponse,
    refresh: async () => authTokenResponse,
    logout: async () => ({ status: "ok" }),
    ...overrides,
  };
}

export function createFakeConversationApi(
  overrides: Partial<ConversationApi> = {},
): ConversationApi {
  return {
    list: async () => [],
    create: async () => conversationResponse,
    detail: async () => conversationDetailResponse,
    rename: async () => conversationResponse,
    remove: async () => ({ status: "ok" }),
    sendMessage: async () => sendMessageResponse,
    editAndRegenerate: async () => sendMessageResponse,
    regenerate: async () => sendMessageResponse,
    ...overrides,
  };
}

export function createFakeServices(
  authApi: Partial<AuthApi> = {},
  conversationApi: Partial<ConversationApi> = {},
): Services {
  return {
    authApi: createFakeAuthApi(authApi),
    conversationApi: createFakeConversationApi(conversationApi),
  };
}

export function makeWrapper(services: Services) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AppProvider services={services}>{children}</AppProvider>;
  };
}

export function renderWithApp(
  ui: ReactElement,
  services: Services,
  options?: RenderOptions,
): RenderResult {
  return render(<AppProvider services={services}>{ui}</AppProvider>, options);
}
