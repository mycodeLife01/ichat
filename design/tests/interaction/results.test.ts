import { describe, it, expect } from "vitest";
import { createResults } from "../../src/runtime/results";
import { conversations } from "../../src/scenarios/data";
import { getScene, scenes } from "../../src/scenarios/registry";
describe("scene outcomes", () => {
  it("retries a failed operation without failing unrelated initialization", async () => {
    const runtime = createResults(getScene("admin-error"), () =>
      conversations(),
    );
    await expect(
      runtime.modelAdminApi.getCatalog("design-demo"),
    ).resolves.toHaveProperty("models");
    await expect(
      runtime.modelAdminApi.setCatalogEnabled("design-demo", false),
    ).rejects.toThrow();
    await expect(
      runtime.modelAdminApi.setCatalogEnabled("design-demo", false),
    ).resolves.toHaveProperty("database_enabled", false);
  });
  it("freezes the shared content and invalidates only the revoked snapshot", async () => {
    const data = conversations();
    const runtime = createResults(getScene("chat"), () => data);
    const before = await runtime.shareApi.getPublic("design-share");
    data[0].messages[0].content = "edited";
    expect(await runtime.shareApi.getPublic("design-share")).toEqual(before);
    await runtime.shareApi.revoke("design-chat", "design-share");
    await expect(runtime.shareApi.getPublic("design-share")).rejects.toThrow();
  });
  it("has unique stable scene identifiers", () => {
    expect(new Set(scenes.map((s) => s.id)).size).toBe(scenes.length);
    expect(scenes.every((s) => s.source && s.note && s.route)).toBe(true);
  });
});
