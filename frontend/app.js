import { getAuth, onAuthChange } from "./auth.js";
import { renderLoginView } from "./views/login.js";
import { renderChatView } from "./views/chat.js";

const root = document.getElementById("app");

function render() {
  const previous = root._chatUnsubscribe;
  if (typeof previous === "function") { previous(); root._chatUnsubscribe = null; }

  const auth = getAuth();
  if (!auth) {
    renderLoginView(root, { onAuthenticated: render });
    return;
  }
  renderChatView(root, { onLoggedOut: render });
}

onAuthChange(render);
render();
