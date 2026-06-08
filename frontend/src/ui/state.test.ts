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

  it("resets on app/reset", () => {
    const dirty = uiReducer(initialUiState, { type: "ui/toggleMobileSidebar" });
    expect(uiReducer(dirty, { type: "app/reset" })).toEqual(initialUiState);
  });
});
