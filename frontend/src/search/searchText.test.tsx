import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import cases from "../../../tests/fixtures/conversation_search_text_v1.json";
import { Markdown } from "../messages/Markdown";
import { buildVisibleSearchText, rangeForMatch } from "./searchText";

afterEach(cleanup);
describe("shared visible-text contract", () => {
  for (const fixture of cases) {
    it(fixture.name, () => {
      const { container } = render(
        <div data-body>
          {fixture.role === "user" ? (
            fixture.content
          ) : (
            <Markdown
              content={fixture.content}
              sources={fixture.sources?.map((id) => ({
                id,
                url: "https://example.com",
                title: "隐藏来源标题",
              }))}
            />
          )}
        </div>,
      );
      const root = container.querySelector<HTMLElement>("[data-body]")!;
      const projection = buildVisibleSearchText(root);
      expect(projection.text).toBe(fixture.text);
      const start = projection.text.indexOf("中文");
      if (start >= 0)
        expect(rangeForMatch(projection, start, start + 2)?.toString()).toBe(
          "中文",
        );
    });
  }
});
