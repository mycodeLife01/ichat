import { ApiError } from "../api.js";
import { login, register } from "../auth.js";
import { el, toast } from "../ui.js";

export function renderLoginView(container, { onAuthenticated }) {
  let mode = "login"; // "login" | "register"

  function render() {
    container.replaceChildren(build());
  }

  function build() {
    const root = el("div", { class: "h-full min-h-0 w-full overflow-y-auto flex items-center justify-center bg-zinc-50 px-4 py-6 sm:py-8" });
    const card = el("div", {
      class: "w-full max-w-sm bg-white border border-zinc-200 rounded-xl p-5 sm:p-8 shadow-sm",
    });
    const brand = el("h1", { class: "text-2xl font-semibold text-zinc-900 text-center mb-1" }, ["iChat"]);
    const subtitle = el("p", { class: "text-sm text-zinc-500 text-center mb-6" }, ["简洁的 AI 对话测试客户端"]);

    const tabs = el("div", { class: "flex bg-zinc-100 rounded-md p-1 mb-6 text-sm" }, [
      tabButton("登录", "login"),
      tabButton("注册", "register"),
    ]);

    const form = mode === "login" ? buildLoginForm() : buildRegisterForm();

    card.append(brand, subtitle, tabs, form);
    root.append(card);
    return root;
  }

  function tabButton(label, key) {
    const active = mode === key;
    return el("button", {
      type: "button",
      class: `flex-1 py-1.5 rounded ${active ? "bg-white shadow-sm text-zinc-900" : "text-zinc-500"}`,
      onClick: () => { mode = key; render(); },
    }, [label]);
  }

  function field(labelText, inputAttrs) {
    const errorId = `err-${inputAttrs.name}`;
    const input = el("input", {
      ...inputAttrs,
      class: "w-full px-3 py-2 border border-zinc-200 rounded-md text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900",
    });
    const error = el("p", { id: errorId, class: "text-red-600 text-xs mt-1 hidden" });
    return {
      wrapper: el("label", { class: "block mb-4" }, [
        el("span", { class: "block text-xs font-medium text-zinc-600 mb-1" }, [labelText]),
        input,
        error,
      ]),
      input,
      setError: (msg) => {
        if (msg) { error.textContent = msg; error.classList.remove("hidden"); }
        else { error.classList.add("hidden"); }
      },
    };
  }

  function submitButton(label) {
    return el("button", {
      type: "submit",
      class: "w-full bg-zinc-900 hover:bg-zinc-800 text-white text-sm font-medium py-2 rounded-md transition",
    }, [label]);
  }

  function buildLoginForm() {
    const identifier = field("用户名或邮箱", { name: "identifier", type: "text", required: true, autocomplete: "username" });
    const password = field("密码", { name: "password", type: "password", required: true, autocomplete: "current-password", minlength: 8 });
    const form = el("form", { class: "space-y-1" }, [identifier.wrapper, password.wrapper, submitButton("登录")]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      identifier.setError(null); password.setError(null);
      try {
        await login(identifier.input.value.trim(), password.input.value);
        onAuthenticated();
      } catch (err) {
        const message = err instanceof ApiError ? err.detail : "登录失败";
        password.setError(message);
      }
    });
    return form;
  }

  function buildRegisterForm() {
    const username = field("用户名", { name: "username", type: "text", required: true, autocomplete: "username", maxlength: 50 });
    const email = field("邮箱", { name: "email", type: "email", required: true, autocomplete: "email" });
    const password = field("密码（至少 8 位）", { name: "password", type: "password", required: true, autocomplete: "new-password", minlength: 8 });
    const form = el("form", { class: "space-y-1" }, [username.wrapper, email.wrapper, password.wrapper, submitButton("创建账号")]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      [username, email, password].forEach((f) => f.setError(null));
      try {
        await register(username.input.value.trim(), email.input.value.trim(), password.input.value);
        toast("注册成功", "success");
        onAuthenticated();
      } catch (err) {
        const message = err instanceof ApiError ? err.detail : "注册失败";
        password.setError(message);
      }
    });
    return form;
  }

  render();
}
