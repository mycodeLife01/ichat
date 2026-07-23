import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Toast } from "./Toast";

describe("Toast", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders nothing when there is no toast", () => {
    const { container } = render(<Toast toast={null} onDismiss={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["neutral", "status"],
    ["success", "status"],
    ["warning", "status"],
    ["error", "alert"],
  ] as const)("renders %s with its live-region role, icon, and message", (tone, role) => {
    const { container } = render(
      <Toast toast={{ id: 1, message: `${tone} message`, tone }} onDismiss={() => {}} />,
    );
    const node = screen.getByRole(role);
    expect(node).toHaveTextContent(`${tone} message`);
    expect(node).toHaveAttribute("data-tone", tone);
    expect(container.querySelector(`[data-toast-icon="${tone}"]`)).toBeInTheDocument();
  });

  it("auto-dismisses after the duration", () => {
    const onDismiss = vi.fn();
    render(
      <Toast
        toast={{ id: 1, message: "停止失败，请重试", tone: "error" }}
        onDismiss={onDismiss}
        duration={2600}
      />,
    );
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2600));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not fire onDismiss after unmount", () => {
    const onDismiss = vi.fn();
    const { unmount } = render(
      <Toast
        toast={{ id: 1, message: "x", tone: "neutral" }}
        onDismiss={onDismiss}
        duration={2600}
      />,
    );
    unmount();
    act(() => vi.advanceTimersByTime(5000));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("re-times when the id changes (the previous timer is cleared)", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast
        toast={{ id: 1, message: "first", tone: "success" }}
        onDismiss={onDismiss}
        duration={2600}
      />,
    );
    act(() => vi.advanceTimersByTime(2000));
    // A new toast arrives before the first elapsed: the old timer must be cleared.
    rerender(
      <Toast
        toast={{ id: 2, message: "second", tone: "success" }}
        onDismiss={onDismiss}
        duration={2600}
      />,
    );
    act(() => vi.advanceTimersByTime(1000)); // would have fired the first (2000+1000>2600)
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1600)); // completes the second's window
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("replaces the rendered node when the id changes so the entry animation replays", () => {
    const { rerender } = render(
      <Toast
        toast={{ id: 1, message: "链接已复制", tone: "success" }}
        onDismiss={() => {}}
      />,
    );
    const first = screen.getByRole("status");

    rerender(
      <Toast
        toast={{ id: 2, message: "链接已复制", tone: "success" }}
        onDismiss={() => {}}
      />,
    );

    expect(screen.getByRole("status")).not.toBe(first);
  });
});
