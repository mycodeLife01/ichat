import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AttachmentCard } from "./AttachmentCard";
import { PastedTextActionsContext, PastedTextReaderContext } from "./pastedText";
import type { DraftAttachment, FileAttachment } from "./types";

const sentPaste: FileAttachment = {
  id: "file-paste-sent",
  name: "pasted-text-1.txt",
  media_type: "text/plain",
  size_bytes: 40,
  category: "text",
  model_input_kind: "document",
  origin: "paste",
  preview_available: false,
  stats: { line_count: 1200, first_line: "ERROR boot failed" },
};

describe("PastedTextCard", () => {
  it("renders sent pasted text from stats and loads the full text on open", async () => {
    const readText = vi.fn(async () => "ERROR boot failed\nsecond line");
    render(
      <PastedTextReaderContext.Provider value={readText}>
        <AttachmentCard attachment={sentPaste} mode="message" />
      </PastedTextReaderContext.Provider>,
    );

    const card = screen.getByRole("group", { name: "粘贴的文本" });
    expect(card).toHaveClass("w-[320px]");
    expect(screen.getByText("ERROR boot failed")).toBeInTheDocument();
    expect(screen.getByText("粘贴的文本 · 1,200 行")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "查看粘贴的文本" }));

    expect(readText).toHaveBeenCalledWith("file-paste-sent");
    expect(await screen.findByLabelText("文本内容")).toHaveTextContent("second line");
    expect(screen.getByText("2 行 · 29 字符")).toBeInTheDocument();
  });

  it("keeps old attachments without an origin on the file card", () => {
    render(<AttachmentCard attachment={{ ...sentPaste, origin: undefined }} mode="message" />);
    expect(screen.queryByRole("group", { name: "粘贴的文本" })).not.toBeInTheDocument();
  });

  it("shows the text inline in the composer through the expand action", async () => {
    const onExpand = vi.fn();
    const draft: DraftAttachment = {
      client_id: "client-paste",
      upload_id: "upload-paste",
      status: "succeeded",
      error_code: null,
      file: { ...sentPaste, id: "file-paste-draft" },
      name: sentPaste.name,
      media_type: sentPaste.media_type,
      size_bytes: sentPaste.size_bytes,
      category: "text",
      origin: "paste",
    };
    render(
      <PastedTextReaderContext.Provider value={async () => "full text"}>
        <PastedTextActionsContext.Provider value={{ promptChars: 0, onExpand }}>
          <AttachmentCard attachment={draft} mode="composer" />
        </PastedTextActionsContext.Provider>
      </PastedTextReaderContext.Provider>,
    );

    expect(screen.getByRole("group", { name: "粘贴的文本" })).toHaveClass("w-[220px]");
    await userEvent.click(screen.getByRole("button", { name: /在输入框中显示/ }));
    expect(onExpand).toHaveBeenCalledWith("client-paste", "full text");
  });
});
