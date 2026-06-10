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

  it("renders the message as a status region", () => {
    render(<Toast toast={{ id: 1, message: "发送失败，请重试" }} onDismiss={() => {}} />);
    const node = screen.getByRole("status");
    expect(node).toHaveTextContent("发送失败，请重试");
    expect(node).toHaveClass("toast");
  });

  it("auto-dismisses after the duration", () => {
    const onDismiss = vi.fn();
    render(<Toast toast={{ id: 1, message: "停止失败，请重试" }} onDismiss={onDismiss} duration={2600} />);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2600));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not fire onDismiss after unmount", () => {
    const onDismiss = vi.fn();
    const { unmount } = render(
      <Toast toast={{ id: 1, message: "x" }} onDismiss={onDismiss} duration={2600} />,
    );
    unmount();
    act(() => vi.advanceTimersByTime(5000));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("re-times when the id changes (the previous timer is cleared)", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast toast={{ id: 1, message: "first" }} onDismiss={onDismiss} duration={2600} />,
    );
    act(() => vi.advanceTimersByTime(2000));
    // A new toast arrives before the first elapsed: the old timer must be cleared.
    rerender(<Toast toast={{ id: 2, message: "second" }} onDismiss={onDismiss} duration={2600} />);
    act(() => vi.advanceTimersByTime(1000)); // would have fired the first (2000+1000>2600)
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1600)); // completes the second's window
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
