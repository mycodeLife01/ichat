import {
  createContext,
  useContext,
  useMemo,
  useCallback,
  useState,
  type ReactNode,
} from "react";
import type { AuthUserResponse } from "../api/types";
import type { ToastState, ToastTone } from "../ui/state";
import type { DesignResults } from "./results";
import { Toast } from "../ui/Toast";
type Action =
  | { type: "ui/showToast"; message: string; tone: ToastTone }
  | { type: "app/reset" };
type Runtime = {
  services: DesignResults;
  dispatch: (action: Action) => void;
  user: AuthUserResponse | null;
  setUser: (u: AuthUserResponse | null) => void;
};
const Context = createContext<Runtime | null>(null);
export function DesignProvider({
  services,
  initialUser,
  children,
}: {
  services: DesignResults;
  initialUser: AuthUserResponse | null;
  children: ReactNode;
}) {
  const [user, setUser] = useState(initialUser);
  const [toast, setToast] = useState<ToastState>(null);
  const dispatch = useCallback((action: Action) => {
    if (action.type === "app/reset") setUser(null);
    else
      setToast((t) => ({
        id: (t?.id ?? 0) + 1,
        message: action.message,
        tone: action.tone,
      }));
  }, []);
  const value = useMemo(
    () => ({ services, dispatch, user, setUser }),
    [services, dispatch, user],
  );
  return (
    <Context.Provider value={value}>
      {children}
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </Context.Provider>
  );
}
export function useDesignActions() {
  const value = useContext(Context);
  if (!value) throw new Error("DesignProvider is required");
  return value;
}
