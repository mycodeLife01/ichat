import { tokenStore as defaultTokenStore, type TokenStore } from "../auth/tokenStore";
import { getApiBaseUrl } from "./env";
import { ApiError, getDefaultErrorMessage, getErrorDetail, toApiError } from "./errors";
import type { SuccessEnvelope } from "./types";

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

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? getApiBaseUrl();
    this.fetchImpl = options.fetchImpl ?? fetch;
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
    const response = await this.fetchImpl(this.buildUrl(path, options.query), {
      method: options.method ?? "GET",
      headers: this.buildHeaders(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });

    if (!response.ok) {
      throw await this.createResponseError(response);
    }

    return response;
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
