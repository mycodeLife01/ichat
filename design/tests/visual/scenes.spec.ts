import { test, expect } from "@playwright/test";
import { scenes } from "../../src/scenarios/registry";
for (const scene of scenes) {
  test(`${scene.id} renders without API or overflow`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    const external: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (
        !["127.0.0.1", "localhost"].includes(u.hostname) &&
        u.protocol.startsWith("http")
      ) {
        external.push(u.href);
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(`/canvas.html?scene=${scene.id}`);
    await expect(page.locator("#root")).not.toBeEmpty();
    await page.waitForTimeout(450);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`${scene.id}.png`) });
  });
}
