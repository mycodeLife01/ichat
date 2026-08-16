import { createRoot } from "react-dom/client";

import type { ConversationResponse } from "../../src/api/types";
import { Sidebar } from "../../src/conversations/Sidebar";
import "../../src/styles/global.css";

const items: ConversationResponse[] = Array.from({ length: 30 }, (_, index) => {
  const timestamp = new Date(Date.UTC(2026, 7, 16, 12, 0, 0) - index * 60_000).toISOString();
  return {
    id: `sidebar-scroll-${index + 1}`,
    title: `分页历史对话 ${String(index + 1).padStart(2, "0")}`,
    activated_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  };
});

const root = document.getElementById("root");
if (!root) throw new Error("Sidebar scroll fixture root is missing");
createRoot(root).render(
  <div className="app flex h-full bg-bg" data-testid="sidebar-scroll-fixture">
    <Sidebar
      items={items}
      selectedId={items[0].id}
      user={{
        email: "fixture@example.com",
        username: "fixture",
        name: "视觉验收",
        emailVerified: true,
      }}
      isMobile={false}
      collapsed={false}
      mobileOpen={false}
      pendingTitleIds={[]}
      hasMore={false}
      isLoadingMore={false}
      onSelect={() => undefined}
      onNew={() => undefined}
      onLoadMore={() => undefined}
      onRename={() => undefined}
      onRequestShare={() => undefined}
      onRequestDelete={() => undefined}
      onLogout={() => undefined}
      onResendVerification={async () => undefined}
      onUpdateNickname={async () => undefined}
      onChangePassword={async () => undefined}
      onRequestDeletion={async () => undefined}
      onLoadShares={async () => []}
      onRevokeShare={async () => undefined}
      onToast={() => undefined}
      onToggleCollapsed={() => undefined}
      onCloseMobile={() => undefined}
    />
    <main className="min-w-0 flex-1 bg-canvas" aria-label="滚动条视觉验收画布" />
  </div>,
);
