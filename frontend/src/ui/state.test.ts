import { describe, expect, it } from "vitest";

import { initialUiState, uiReducer } from "./state";

describe("uiReducer", () => {
  it("toggles the mobile sidebar", () => {
    const open = uiReducer(initialUiState, { type: "ui/toggleMobileSidebar" });
    expect(open.mobileSidebarOpen).toBe(true);
  });

  it("sets the mobile sidebar explicitly", () => {
    const open = uiReducer(initialUiState, { type: "ui/setMobileSidebar", open: true });
    expect(open.mobileSidebarOpen).toBe(true);
    const closed = uiReducer(open, { type: "ui/setMobileSidebar", open: false });
    expect(closed.mobileSidebarOpen).toBe(false);
  });

  it("toggles the desktop sidebar collapse", () => {
    const collapsed = uiReducer(initialUiState, { type: "ui/toggleSidebarCollapsed" });
    expect(collapsed.sidebarCollapsed).toBe(true);
  });

  it("opens and closes the confirm dialog", () => {
    const open = uiReducer(initialUiState, {
      type: "ui/openConfirm",
      dialog: { kind: "deleteConversation", conversationId: 7 },
    });
    expect(open.confirmDialog).toEqual({ kind: "deleteConversation", conversationId: 7 });
    const closed = uiReducer(open, { type: "ui/closeConfirm" });
    expect(closed.confirmDialog).toBeNull();
  });

  it("shows a toast with a monotonic id so repeats re-animate", () => {
    const first = uiReducer(initialUiState, { type: "ui/showToast", message: "发送失败，请重试" });
    expect(first.toast).toEqual({ id: 1, message: "发送失败，请重试" });
    // Same message again must produce a new id (the component remounts on id change).
    const second = uiReducer(first, { type: "ui/showToast", message: "发送失败，请重试" });
    expect(second.toast).toEqual({ id: 2, message: "发送失败，请重试" });
  });

  it("hides the toast", () => {
    const shown = uiReducer(initialUiState, { type: "ui/showToast", message: "停止失败，请重试" });
    const hidden = uiReducer(shown, { type: "ui/hideToast" });
    expect(hidden.toast).toBeNull();
  });

  it("resets on app/reset", () => {
    const dirty = uiReducer(initialUiState, { type: "ui/toggleMobileSidebar" });
    expect(uiReducer(dirty, { type: "app/reset" })).toEqual(initialUiState);
  });

  it("clears the toast on app/reset", () => {
    const shown = uiReducer(initialUiState, { type: "ui/showToast", message: "操作失败，请重试" });
    expect(uiReducer(shown, { type: "app/reset" }).toast).toBeNull();
  });
});
