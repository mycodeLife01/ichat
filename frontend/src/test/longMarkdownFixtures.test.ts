import { describe, expect, it } from "vitest";

import {
  createLongMarkdownFixture,
  sanitizedRealDeltaTrace,
} from "./longMarkdownFixtures";

describe("long Markdown performance fixtures", () => {
  it.each([10_000, 20_000, 50_000])(
    "creates an exact deterministic %i-character rich document",
    (targetLength) => {
      const first = createLongMarkdownFixture(targetLength);
      const second = createLongMarkdownFixture(targetLength);

      expect(first).toBe(second);
      expect(first).toHaveLength(targetLength);
      expect(first).toContain("```typescript");
      expect(first).toContain("| Surface | State |");
      expect(first).toContain("\\[");
      expect(first).toContain("[1]");
    },
  );

  it("reconstructs the documented real run as monotonic sanitized cumulative prefixes", () => {
    expect(sanitizedRealDeltaTrace.sourceRunId).toBe(1487);
    expect(sanitizedRealDeltaTrace.prefixes).toHaveLength(128);
    expect(sanitizedRealDeltaTrace.finalText).toHaveLength(174);

    let previous = "";
    for (const prefix of sanitizedRealDeltaTrace.prefixes) {
      expect(prefix.startsWith(previous)).toBe(true);
      previous = prefix;
    }
    expect(previous).toBe(sanitizedRealDeltaTrace.finalText);
  });
});
