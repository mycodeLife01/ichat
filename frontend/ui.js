export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function toast(message, level = "info") {
  const root = document.getElementById("toast-root");
  const color = level === "error" ? "bg-red-600" : level === "success" ? "bg-emerald-600" : "bg-zinc-900";
  const node = el("div", {
    class: `${color} text-white text-sm px-3 py-2 rounded-md shadow-md max-w-sm`,
  }, [message]);
  root.appendChild(node);
  setTimeout(() => node.remove(), 3000);
}

export function nearBottom(elem, threshold = 80) {
  return elem.scrollHeight - elem.scrollTop - elem.clientHeight < threshold;
}

export function scrollToBottom(elem) {
  elem.scrollTop = elem.scrollHeight;
}
