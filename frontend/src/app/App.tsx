import { AuthScreen } from "../auth/AuthScreen";
import { useAuthSession } from "../auth/useAuthSession";
import { AppShell } from "./AppShell";

export function App() {
  const { bootstrapped, isAuthenticated } = useAuthSession();

  if (!bootstrapped) {
    return null;
  }

  return isAuthenticated ? <AppShell /> : <AuthScreen />;
}
