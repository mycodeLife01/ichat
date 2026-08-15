import type { ComponentPropsWithoutRef } from "react";

function isExternalHttpHref(href: string | undefined) {
  if (!href) return false;

  try {
    const url = new URL(href, window.location.href);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin !== window.location.origin
    );
  } catch {
    return false;
  }
}

export function MarkdownLink({ children, href, title }: ComponentPropsWithoutRef<"a">) {
  const external = isExternalHttpHref(href);

  return (
    <a
      href={href}
      title={title}
      className={external ? "decorated-link" : undefined}
      target={external ? "_new" : undefined}
      rel={external ? "noopener" : undefined}
    >
      {children}
      {external ? (
        <span className="external-link-icon" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor">
            <path d="M14.967 4.338a.66.66 0 0 1 .503.191.66.66 0 0 1 .19.504q.004.033.005.067v8.233a.665.665 0 0 1-1.33 0V6.604l-8.865 8.87a.665.665 0 0 1-.94-.94l8.866-8.869H6.667a.665.665 0 0 1 0-1.33h8.234z" />
          </svg>
        </span>
      ) : null}
    </a>
  );
}
