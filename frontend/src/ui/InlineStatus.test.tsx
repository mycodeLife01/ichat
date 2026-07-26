import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InlineStatus, type InlineStatusTone } from "./InlineStatus";

const cases: Array<{
  tone: InlineStatusTone;
  role: "alert" | "status";
  message: string;
}> = [
  { tone: "neutral", role: "status", message: "正在处理" },
  { tone: "success", role: "status", message: "保存成功" },
  { tone: "warning", role: "status", message: "邮箱尚未验证" },
  { tone: "error", role: "alert", message: "保存失败" },
];

describe("InlineStatus", () => {
  it.each(cases)(
    "renders $tone with an icon, copy, and the $role role",
    ({ tone, role, message }) => {
      const { container } = render(<InlineStatus tone={tone}>{message}</InlineStatus>);

      const notice = screen.getByRole(role);
      expect(notice).toHaveTextContent(message);
      expect(notice).toHaveAttribute("data-tone", tone);

      const icon = container.querySelector(`[data-status-icon="${tone}"]`);
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon?.parentElement).toHaveClass("flex", "h-[1.55em]", "items-center");
    },
  );
});
