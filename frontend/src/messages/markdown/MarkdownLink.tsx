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
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
    >
      {children}
    </a>
  );
}
