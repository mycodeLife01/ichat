import { describe, expect, it } from "vitest";

import {
  ApiError,
  getDefaultErrorMessage,
  isAbortError,
  toApiError,
} from "./errors";

describe("ApiError", () => {
  it("stores status, message, detail, and payload", () => {
    const error = new ApiError({
      status: 409,
      message: "当前操作与现有状态冲突，请稍后重试",
      detail: "active run exists",
      payload: { detail: "active run exists" },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
    expect(error.status).toBe(409);
    expect(error.detail).toBe("active run exists");
  });

  it("maps common statuses to Chinese messages", () => {
    expect(getDefaultErrorMessage(401)).toBe("登录状态已失效，请重新登录");
    expect(getDefaultErrorMessage(403)).toBe("没有权限访问该资源");
    expect(getDefaultErrorMessage(404)).toBe("资源不存在或已被删除");
    expect(getDefaultErrorMessage(409)).toBe("当前操作与现有状态冲突，请稍后重试");
    expect(getDefaultErrorMessage(422)).toBe("提交内容不符合要求，请检查后重试");
    expect(getDefaultErrorMessage(500)).toBe("服务暂时不可用，请稍后重试");
  });

  it("keeps abort errors recognizable", () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");

    expect(isAbortError(abort)).toBe(true);
    expect(toApiError(abort).isAbort).toBe(true);
  });
});
