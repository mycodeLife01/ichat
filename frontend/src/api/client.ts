import {
  createAuthSession,
  tokenStore as defaultTokenStore,
  type TokenStore,
} from "../auth/tokenStore";
import { getApiBaseUrl } from "./env";
import { ApiError, getDefaultErrorMessage, getErrorDetail, toApiError } from "./errors";
import type { AuthTokenResponse, SuccessEnvelope } from "./types";

type QueryValue = string | number | boolean | null | undefined;

export type ApiRequestOptions = {
  method?: string;
  body?: unknown;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  auth?: boolean;
  retryOnUnauthorized?: boolean;
};

export type ApiClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  tokenStore?: TokenStore;
  onAuthExpired?: () => void;
};

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenStore: TokenStore;
  private readonly onAuthExpired?: () => void;
  private refreshPromise: Promise<AuthTokenResponse> | null = null;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? getApiBaseUrl();
    // Bind the global fetch to the global object: it is invoked as
    // `this.fetchImpl(...)`, which would otherwise run with `this === ApiClient`
    // and throw "Illegal invocation" in browsers. Injected impls are used as-is.
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.tokenStore = options.tokenStore ?? defaultTokenStore;
    this.onAuthExpired = options.onAuthExpired;
  }

  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    try {
      const response = await this.fetchRaw(path, options);
      const payload = (await response.json()) as SuccessEnvelope<T>;

      if (!payload || typeof payload !== "object" || !("data" in payload)) {
        throw new ApiError({
          status: response.status,
          message: "服务响应格式异常",
          payload,
        });
      }

      return payload.data;
    } catch (error) {
      throw toApiError(error);
    }
  }

  async fetchRaw(path: string, options: ApiRequestOptions = {}): Promise<Response> {
    return this.fetchRawInternal(path, options, false);
  }

  private async fetchRawInternal(
    path: string,
    options: ApiRequestOptions,
    hasRetried: boolean,
  ): Promise<Response> {
    const response = await this.fetchImpl(this.buildUrl(path, options.query), {
      method: options.method ?? "GET",
      headers: this.buildHeaders(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });

    if (
      response.status === 401 &&
      options.auth !== false &&
      options.retryOnUnauthorized !== false &&
      !hasRetried
    ) {
      await this.refreshSession();
      return this.fetchRawInternal(path, options, true);
    }

    if (!response.ok) {
      throw await this.createResponseError(response);
    }

    return response;
  }

  private async refreshSession(): Promise<void> {
    const refreshToken = this.tokenStore.getRefreshToken();

    if (!refreshToken) {
      this.expireAuth();
      throw new ApiError({
        status: 401,
        message: "登录状态已失效，请重新登录",
        isAuthExpired: true,
      });
    }

    try {
      this.refreshPromise ??= this.request<AuthTokenResponse>("/auth/refresh", {
        method: "POST",
        body: { refresh_token: refreshToken },
        auth: false,
        retryOnUnauthorized: false,
      }).finally(() => {
        this.refreshPromise = null;
      });

      const refreshed = await this.refreshPromise;
      this.tokenStore.save(createAuthSession(refreshed));
    } catch (error) {
      this.expireAuth();
      const apiError = toApiError(error);
      throw new ApiError({
        status: apiError.status || 401,
        message: "登录状态已失效，请重新登录",
        detail: apiError.detail,
        payload: apiError.payload,
        isAuthExpired: true,
        cause: error,
      });
    }
  }

  private expireAuth(): void {
    this.tokenStore.clear();
    this.onAuthExpired?.();
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  private buildHeaders(options: ApiRequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (options.auth !== false) {
      const accessToken = this.tokenStore.getAccessToken();
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }
    }

    return headers;
  }

  private async createResponseError(response: Response): Promise<ApiError> {
    const payload = await readJsonSafely(response);
    const detail = getErrorDetail(payload);

    return new ApiError({
      status: response.status,
      message: getDefaultErrorMessage(response.status),
      detail,
      payload,
    });
  }
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

let defaultApiClient: ApiClient | null = null;

export function getDefaultApiClient(): ApiClient {
  defaultApiClient ??= new ApiClient();
  return defaultApiClient;
}
