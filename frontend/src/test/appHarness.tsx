import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";

import type { ConversationApi } from "../api/conversations";
import type { CapabilitiesApi } from "../api/capabilities";
import type { FilesApi } from "../api/files";
import type { RunApi } from "../api/runs";
import type { ShareApi } from "../api/share";
import type { RunEventResponse, RunStreamEvent } from "../api/types";
import { AppProvider } from "../app/AppProvider";
import type { AuthApi, Services } from "../app/context";
import {
  authTokenResponse,
  conversationDetailResponse,
  conversationResponse,
  runStateResponse,
  sendMessageResponse,
  shareLinkResponse,
} from "./apiFixtures";

export function createFakeAuthApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    register: async () => authTokenResponse,
    login: async () => authTokenResponse,
    refresh: async () => authTokenResponse,
    logout: async () => ({ status: "ok" }),
    me: async () => authTokenResponse.user,
    verifyEmail: async () => ({ status: "ok" }),
    resendVerificationEmail: async () => ({ status: "ok" }),
    requestPasswordReset: async () => ({ status: "ok" }),
    resetPassword: async () => ({ status: "ok" }),
    updateProfile: async (nickname) => ({ ...authTokenResponse.user, nickname }),
    changePassword: async () => ({ status: "ok" }),
    requestAccountDeletion: async () => ({ status: "ok" }),
    confirmAccountDeletion: async () => ({ status: "ok" }),
    ...overrides,
  };
}

export function createFakeConversationApi(
  overrides: Partial<ConversationApi> = {},
): ConversationApi {
  return {
    list: async () => [],
    create: async () => conversationResponse,
    createWithMessage: async () => ({
      conversation: conversationResponse,
      ...sendMessageResponse,
    }),
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
    get: async () => ({
      web_search: { enabled: true },
      models: [
        {
          id: "deepseek-v4-flash",
          provider: "deepseek",
          label: "deepseek-v4-flash",
          thinking_levels: ["low", "high", "max"],
          default: true,
          supports_image_input: false,
        },
      ],
    }),
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

export function createFakeFilesApi(overrides: Partial<FilesApi> = {}): FilesApi {
  return {
    createUpload: async () => ({
      upload_id: "upload-1",
      upload_url: "https://uploads.example.test/upload-1",
      upload_headers: { "Content-Type": "text/plain" },
      upload_url_expires_at: "2026-08-01T10:05:00Z",
      session_expires_at: "2026-08-01T10:30:00Z",
    }),
    confirm: async () => ({
      upload_id: "upload-1",
      status: "succeeded",
      error_code: null,
      file: {
        id: "file-1",
        name: "example.txt",
        media_type: "text/plain",
        size_bytes: 7,
        category: "text",
        model_input_kind: "document",
        warning: [],
        preview_available: false,
      },
    }),
    status: async () => [],
    cancel: async (uploadId) => ({
      upload_id: uploadId,
      status: "cancelled",
      error_code: null,
      file: null,
    }),
    cancelMany: async (uploadIds) =>
      uploadIds.map((uploadId) => ({
        upload_id: uploadId,
        status: "cancelled" as const,
        error_code: null,
        file: null,
      })),
    readUrl: async () => ({
      url: "https://downloads.example.test/file",
      expires_at: "2026-08-01T10:05:00Z",
    }),
    ...overrides,
  };
}

export function createFakeShareApi(overrides: Partial<ShareApi> = {}): ShareApi {
  return {
    create: async () => shareLinkResponse,
    list: async () => [shareLinkResponse],
    listMine: async () => [],
    revoke: async () => ({ status: "ok" }),
    getPublic: async () => ({
      title: conversationResponse.title,
      messages: [],
      created_at: conversationResponse.created_at,
    }),
    readAttachment: async () => ({
      url: "https://cdn.example.com/shared-preview.png",
      expires_at: "2026-08-14T10:05:00Z",
    }),
    ...overrides,
  };
}

export function createFakeServices(
  authApi: Partial<AuthApi> = {},
  conversationApi: Partial<ConversationApi> = {},
  runApi: Partial<RunApi> = {},
  capabilitiesApi: Partial<CapabilitiesApi> = {},
  shareApi: Partial<ShareApi> = {},
  filesApi: Partial<FilesApi> = {},
): Services {
  return {
    authApi: createFakeAuthApi(authApi),
    capabilitiesApi: createFakeCapabilitiesApi(capabilitiesApi),
    conversationApi: createFakeConversationApi(conversationApi),
    filesApi: createFakeFilesApi(filesApi),
    runApi: createFakeRunApi(runApi),
    shareApi: createFakeShareApi(shareApi),
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
