import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAppState } from "../app/context";
import { shareLinkResponse } from "../test/apiFixtures";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { useQuickShare } from "./useQuickShare";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

function useQuickShareProbe() {
  return { quickShare: useQuickShare(), ui: useAppState().ui };
}

function setClipboard(value: Partial<Clipboard> | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

function setExecCommand(value: (command: string) => boolean) {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else delete (navigator as { clipboard?: Clipboard }).clipboard;
  if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
  else delete (document as { execCommand?: typeof document.execCommand }).execCommand;
});

describe("useQuickShare", () => {
  it("copies through the insecure-context fallback instead of reporting failure", async () => {
    setClipboard(undefined);
    const execCommand = vi.fn(() => true);
    setExecCommand(execCommand);
    const services = createFakeServices({}, {}, {}, {}, {
      list: async () => [shareLinkResponse],
    });
    const { result } = renderHook(useQuickShareProbe, { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.quickShare("conversation-1", false);
    });

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(result.current.ui.toast).toMatchObject({
      message: "公开链接已复制到剪贴板",
      tone: "success",
    });
  });

  it("keeps the one-click flow and reports failure when every copy path is unavailable", async () => {
    setClipboard(undefined);
    setExecCommand(() => false);
    const services = createFakeServices({}, {}, {}, {}, {
      list: async () => [shareLinkResponse],
    });
    const { result } = renderHook(useQuickShareProbe, { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.quickShare("conversation-1", false);
    });

    expect(result.current.ui.shareDialog).toBeNull();
    expect(result.current.ui.toast).toMatchObject({
      message: "复制失败",
      tone: "error",
    });
  });

  it.each([false, true])("starts a deferred write before resolving the link (create: %s)", async (createNew) => {
    let itemData: Record<string, string | Blob | PromiseLike<string | Blob>> | undefined;
    class ClipboardItemStub {
      constructor(items: Record<string, string | Blob | PromiseLike<string | Blob>>) {
        itemData = items;
      }
    }
    vi.stubGlobal("ClipboardItem", ClipboardItemStub);

    let resolveList!: (value: (typeof shareLinkResponse)[]) => void;
    const list = vi.fn(
      () =>
        new Promise<(typeof shareLinkResponse)[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const write = vi.fn(async () => {
      await itemData?.["text/plain"];
    });
    setClipboard({ write, writeText: vi.fn() } as Partial<Clipboard>);
    const create = vi.fn(async () => shareLinkResponse);
    const services = createFakeServices({}, {}, {}, {}, { list, create });
    const { result } = renderHook(useQuickShareProbe, { wrapper: makeWrapper(services) });

    let shareResult!: Promise<void>;
    act(() => {
      shareResult = result.current.quickShare("conversation-1", false);
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(result.current.ui.toast).toBeNull();
    resolveList(createNew ? [] : [shareLinkResponse]);
    await act(async () => {
      await shareResult;
    });

    expect(create).toHaveBeenCalledTimes(createNew ? 1 : 0);
    if (createNew) expect(create).toHaveBeenCalledWith("conversation-1", null, undefined);
    expect(result.current.ui.shareDialog).toBeNull();
    expect(result.current.ui.toast).toMatchObject({
      message: "公开链接已复制到剪贴板",
      tone: "success",
    });
  });

  it.each(["list", "create"] as const)("reports a %s error without copying", async (failure) => {
    const writeText = vi.fn();
    setClipboard({ writeText });
    const services = createFakeServices({}, {}, {}, {}, {
      list: async () => {
        if (failure === "list") throw new Error("Request failed");
        return [];
      },
      create: async () => { throw new Error("Request failed"); },
    });
    const { result } = renderHook(useQuickShareProbe, { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.quickShare("conversation-1", false);
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(result.current.ui.shareDialog).toBeNull();
    expect(result.current.ui.toast).toMatchObject({ message: "创建分享失败", tone: "error" });
  });
});
