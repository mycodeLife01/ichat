import { getAuth, onAuthChange } from "./auth.js";
import { renderLoginView } from "./views/login.js";

const root = document.getElementById("app");

function render() {
  const auth = getAuth();
  if (!auth) {
    renderLoginView(root, { onAuthenticated: render });
    return;
  }
  // Chat view 会在 Task 5 接入，先放占位。
  root.replaceChildren(Object.assign(document.createElement("div"), {
    className: "h-full flex items-center justify-center text-zinc-500",
    textContent: `已登录为 ${auth.user.username}（chat view 即将接入）`,
  }));
}

onAuthChange(render);
render();
