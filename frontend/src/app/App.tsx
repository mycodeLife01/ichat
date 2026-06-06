import { AuthScreen } from "../auth/AuthScreen";
import { useAuthSession } from "../auth/useAuthSession";
import { AuthedPlaceholder } from "./AuthedPlaceholder";

export function App() {
  const { bootstrapped, isAuthenticated } = useAuthSession();

  if (!bootstrapped) {
    return null;
  }

  return isAuthenticated ? <AuthedPlaceholder /> : <AuthScreen />;
}
