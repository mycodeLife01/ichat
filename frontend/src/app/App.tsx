import { Route, Routes } from "react-router-dom";

import { AuthScreen } from "../auth/AuthScreen";
import { useAuthSession } from "../auth/useAuthSession";
import { SharePage } from "../messages/SharePage";
import { AppShell } from "./AppShell";

export function App() {
  return (
    <Routes>
      {/* Public, login-free read-only snapshot. Kept outside AuthGate so an
          anonymous visitor never waits on (or is gated by) auth bootstrap. */}
      <Route path="/share/:token" element={<SharePage />} />
      <Route path="*" element={<AuthGate />} />
    </Routes>
  );
}

// The authed app: a single catch-all so AppShell stays mounted across `/` and
// `/c/:publicId` (it parses the path via useLocation, not a <Route> match).
function AuthGate() {
  const { bootstrapped, isAuthenticated } = useAuthSession();

  if (!bootstrapped) {
    return null;
  }

  return isAuthenticated ? <AppShell /> : <AuthScreen />;
}
