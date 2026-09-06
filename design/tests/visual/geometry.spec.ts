import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

test("thinking anchor keeps its geometry across reasoning and text phases", async ({
  page,
}, info) => {
  await page.goto("/canvas.html?scene=welcome");
  await page.locator("textarea").fill("检查思考标题的位置");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator(".thinking-label").waitFor();
  await page.evaluate(() =>
    window.postMessage(
      { type: "design:control", action: "pause" },
      location.origin,
    ),
  );
  await page.waitForTimeout(250);
  const samples = [];
  for (let i = 0; i < 6; i++) {
    samples.push(
      await page
        .locator(".thinking-label")
        .last()
        .evaluate((el) => {
          const label = el.getBoundingClientRect();
          const message = el.closest(".msg")!.getBoundingClientRect();
          return { top: label.top - message.top, height: label.height };
        }),
    );
    await page.evaluate(() =>
      window.postMessage(
        { type: "design:control", action: "step" },
        location.origin,
      ),
    );
    await page.waitForTimeout(60);
  }
  await writeFile(
    info.outputPath("thinking-geometry.json"),
    JSON.stringify(samples, null, 2),
  );
  expect(
    Math.max(...samples.map((s) => s.top)) -
      Math.min(...samples.map((s) => s.top)),
  ).toBeLessThanOrEqual(0.1);
  expect(new Set(samples.map((s) => s.height)).size).toBe(1);
});

for (const width of [759, 760, 761])
  test(`composer and sidebar at ${width}px breakpoint`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/canvas.html?scene=chat");
    const rect = await page.locator(".composer").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        bottom: r.bottom,
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      };
    });
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(width);
    expect(rect.scroll).toBe(width);
    if (width <= 760)
      await expect(
        page.getByRole("button", { name: "打开历史" }),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("button", { name: "收起侧栏" }),
      ).toBeVisible();
    await writeFile(
      info.outputPath("layout.json"),
      JSON.stringify(rect, null, 2),
    );
  });
