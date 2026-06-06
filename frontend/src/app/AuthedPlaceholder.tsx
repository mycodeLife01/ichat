import { useAuthSession } from "../auth/useAuthSession";

// Temporary authenticated view. Replaced by the chat shell in the next step.
export function AuthedPlaceholder() {
  const { user, logout } = useAuthSession();

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <h1 className="auth-title">iChat</h1>
        <p>已登录：{user?.username}</p>
        <p>聊天界面将在后续步骤接入。</p>
        <button type="button" className="auth-submit" onClick={() => void logout()}>
          退出登录
        </button>
      </section>
    </main>
  );
}
