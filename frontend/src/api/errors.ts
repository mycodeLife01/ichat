type ApiErrorOptions = {
  status: number;
  message?: string;
  detail?: unknown;
  payload?: unknown;
  code?: string;
  legacyMessageId?: string | null;
  isAuthExpired?: boolean;
  isAbort?: boolean;
  cause?: unknown;
};

export class ApiError extends Error {
  readonly status: number;
  readonly detail?: unknown;
  readonly payload?: unknown;
  readonly code?: string;
  readonly legacyMessageId?: string | null;
  readonly isAuthExpired: boolean;
  readonly isAbort: boolean;

  constructor(options: ApiErrorOptions) {
    super(options.message ?? getDefaultErrorMessage(options.status), {
      cause: options.cause,
    });
    this.name = "ApiError";
    this.status = options.status;
    this.detail = options.detail;
    this.payload = options.payload;
    this.code = options.code;
    this.legacyMessageId = options.legacyMessageId ?? null;
    this.isAuthExpired = options.isAuthExpired ?? false;
    this.isAbort = options.isAbort ?? false;
  }
}

export function getDefaultErrorMessage(status: number): string {
  if (status === 401) return "登录状态已失效，请重新登录";
  if (status === 403) return "没有权限访问该资源";
  if (status === 404) return "资源不存在或已被删除";
  if (status === 409) return "当前操作与现有状态冲突，请稍后重试";
  if (status === 422) return "提交内容不符合要求，请检查后重试";
  if (status === 429) return "操作过于频繁，请稍后再试";
  if (status >= 500) return "服务暂时不可用，请稍后重试";
  return "请求失败，请稍后重试";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (isAbortError(error)) {
    return new ApiError({
      status: 0,
      message: "请求已取消",
      isAbort: true,
      cause: error,
    });
  }

  return new ApiError({
    status: 0,
    message: "网络连接失败，请检查后重试",
    cause: error,
  });
}

export function getErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as Record<string, unknown>;
  if (typeof value.code === "string" && value.code !== "") return value.code;
  if (value.detail && typeof value.detail === "object") {
    const detail = value.detail as Record<string, unknown>;
    if (typeof detail.code === "string" && detail.code !== "") return detail.code;
  }
  return undefined;
}

export function getLegacyMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.legacy_message_id === "string") return value.legacy_message_id;
  if (value.detail && typeof value.detail === "object") {
    const detail = value.detail as Record<string, unknown>;
    if (typeof detail.legacy_message_id === "string") return detail.legacy_message_id;
  }
  return null;
}

export function getErrorDetail(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "detail" in payload) {
    return (payload as { detail: unknown }).detail;
  }

  return undefined;
}
