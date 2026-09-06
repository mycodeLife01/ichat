import { useMemo, useRef, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { DesignProvider, useDesignActions } from "../runtime/context";
import { createResults } from "../runtime/results";
import { getScene } from "../scenarios/registry";
import { conversations as makeConversations, user } from "../scenarios/data";
import { AuthScreen } from "../auth/AuthScreen";
import { VerifyEmailPage } from "../auth/VerifyEmailPage";
import { ResetPasswordPage } from "../auth/ResetPasswordPage";
import { ConfirmAccountDeletionPage } from "../auth/ConfirmAccountDeletionPage";
import { SharePage } from "../messages/SharePage";
import { ModelAdminPage } from "../model-admin/ModelAdminPage";
import { modelAdminAccessKeyStore } from "../model-admin/accessKeyStore";
import { ChatPage } from "./ChatPage";
import { ComponentsPage } from "./ComponentsPage";
import "../styles/global.css";
import { applyProposal } from "../proposals/registry";
const params = new URLSearchParams(location.search);
const scene = getScene(params.get("scene"));
applyProposal(params.get("proposal"));
if (scene.initial === "unlocked") modelAdminAccessKeyStore.save("design-demo");
function Canvas() {
  const [conversations, setConversations] = useState(() =>
    makeConversations(scene.id === "long"),
  );
  const ref = useRef(conversations);
  ref.current = conversations;
  const services = useMemo(() => createResults(scene, () => ref.current), []);
  useEffect(() => () => services.dispose(), [services]);
  useEffect(() => {
    const control = (event: MessageEvent) => {
      if (
        event.origin === location.origin &&
        event.data?.type === "design:control" &&
        event.data.action === "release"
      )
        services.outcomes.release();
    };
    window.addEventListener("message", control);
    return () => window.removeEventListener("message", control);
  }, [services]);
  return (
    <DesignProvider
      services={services}
      initialUser={
        scene.group === "认证"
          ? null
          : { ...user, email_verified: scene.id !== "unverified" }
      }
    >
      <MemoryRouter
        initialEntries={[
          params.get("token")
            ? `/share/${encodeURIComponent(params.get("token")!)}`
            : scene.route,
        ]}
      >
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route
            path="/confirm-account-deletion"
            element={<ConfirmAccountDeletionPage />}
          />
          <Route path="/share/:token" element={<SharePage />} />
          <Route path="/model-admin" element={<ModelAdminPage />} />
          <Route path="/components" element={<ComponentsPage />} />
          <Route
            path="*"
            element={
              <Gate>
                <ChatPage
                  scene={scene}
                  conversations={conversations}
                  onConversations={setConversations}
                />
              </Gate>
            }
          />
        </Routes>
      </MemoryRouter>
    </DesignProvider>
  );
}
function Gate({ children }: { children: React.ReactNode }) {
  const { user } = useDesignActions();
  const navigate = useNavigate();
  useEffect(() => {
    if (user && ["/login", "/register", "/forgot"].includes(scene.route))
      navigate("/");
  }, [user, navigate]);
  return user ? (
    children
  ) : (
    <AuthScreen
      initialMode={
        scene.id === "register"
          ? "register"
          : scene.id === "forgot"
            ? "forgot"
            : "login"
      }
    />
  );
}
createRoot(document.getElementById("root")!).render(<Canvas />);
