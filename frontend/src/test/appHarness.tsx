import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";

import type { ConversationApi } from "../api/conversations";
import type { CapabilitiesApi } from "../api/capabilities";
import type { RunApi } from "../api/runs";
import type { RunEventResponse, RunStreamEvent } from "../api/types";
import { AppProvider } from "../app/AppProvider";
import type { AuthApi, Services } from "../app/context";
import {
  authTokenResponse,
  conversationDetailResponse,
  conversationResponse,
  runStateResponse,
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

export function createFakeCapabilitiesApi(
  overrides: Partial<CapabilitiesApi> = {},
): CapabilitiesApi {
  return {
    get: async () => ({ web_search: { enabled: true } }),
    ...overrides,
  };
}

export async function* fakeStream(
  events: RunEventResponse[],
): AsyncGenerator<RunStreamEvent> {
  for (const data of events) {
    yield { seq: data.seq, type: data.type, data };
  }
}

export function createFakeRunApi(overrides: Partial<RunApi> = {}): RunApi {
  return {
    state: async () => runStateResponse,
    cancel: async () => ({ status: "ok" }),
    streamEvents: () => fakeStream([]),
    ...overrides,
  };
}

export function createFakeServices(
  authApi: Partial<AuthApi> = {},
  conversationApi: Partial<ConversationApi> = {},
  runApi: Partial<RunApi> = {},
  capabilitiesApi: Partial<CapabilitiesApi> = {},
): Services {
  return {
    authApi: createFakeAuthApi(authApi),
    capabilitiesApi: createFakeCapabilitiesApi(capabilitiesApi),
    conversationApi: createFakeConversationApi(conversationApi),
    runApi: createFakeRunApi(runApi),
  };
}

export function makeWrapper(services: Services) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter>
        <AppProvider services={services}>{children}</AppProvider>
      </MemoryRouter>
    );
  };
}

export function renderWithApp(
  ui: ReactElement,
  services: Services,
  options?: RenderOptions,
  initialEntries: string[] = ["/"],
): RenderResult {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AppProvider services={services}>{ui}</AppProvider>
    </MemoryRouter>,
    options,
  );
}
