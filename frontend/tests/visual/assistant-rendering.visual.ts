import { expect, test } from "@playwright/test";

// The `.visual.ts` suffix keeps this browser test outside Vitest discovery.

test("loads every assistant-rendering surface and writes diagnostic artifacts", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/visual/assistant-rendering.html");

  const fixture = page.getByTestId("assistant-rendering-fixture");
  const finalMessage = page.getByTestId("final-message");
  await expect(fixture).toBeVisible();
  await expect(finalMessage.getByRole("heading", { level: 1, name: /一级标题/ })).toBeVisible();
  await expect(finalMessage.getByRole("heading", { level: 2, name: /二级标题/ })).toBeVisible();
  await expect(finalMessage.getByRole("heading", { level: 3, name: /三级标题/ })).toBeVisible();
  await expect(finalMessage.getByRole("heading", { level: 4, name: /四级标题/ })).toBeVisible();
  await expect(finalMessage.getByRole("heading", { level: 5, name: /五级标题/ })).toBeVisible();
  await expect(finalMessage.getByRole("heading", { level: 6, name: /六级标题/ })).toBeVisible();
  await expect(finalMessage.locator("blockquote").first()).toBeVisible();
  await expect(finalMessage.locator("del")).toBeVisible();
  await expect(finalMessage.locator('input[type="checkbox"]')).toHaveCount(3);
  await expect(finalMessage.locator("table")).toBeVisible();
  await expect(finalMessage.locator(".katex")).not.toHaveCount(0);
  const citations = finalMessage.getByRole("button", { name: "查看 1 个引用来源" });
  await expect(citations).toHaveCount(2);
  await expect(citations.first()).toBeVisible();
  await expect(finalMessage.locator("pre")).not.toHaveCount(0);
  await expect(finalMessage.getByRole("link", { name: "OpenAI" })).toBeVisible();
  await expect(finalMessage.getByRole("link", { name: "站内帮助" })).toBeVisible();

  const prefixes = page.locator("[data-streaming-prefix]");
  await expect(prefixes).toHaveCount(6);
  for (const prefix of await prefixes.all()) {
    await expect(prefix.locator(".md")).toBeVisible();
  }

  await expect(
    page.locator('[data-thinking-state="collapsed"] [role="button"]'),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.locator('[data-thinking-state="expanded"] [role="button"]'),
  ).toHaveAttribute("aria-expanded", "true");

  const successfulCopy = page.locator('[data-copy-scenario="success"]');
  await successfulCopy.getByRole("button", { name: "复制代码" }).click();
  await expect(successfulCopy.locator('[role="status"]')).toHaveAttribute("data-state", "success");
  await expect(successfulCopy.getByRole("button", { name: "已复制" })).toBeVisible();

  const failedCopy = page.locator('[data-copy-scenario="failure"]');
  await failedCopy.getByRole("button", { name: "复制代码" }).click();
  await expect(failedCopy.locator('[role="status"]')).toHaveAttribute("data-state", "failure");

  const geometry = await page.evaluate(() => {
    const rectOf = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x,
        width: rect.width,
        height: rect.height,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        overflowX: style.overflowX,
      };
    };

    return {
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
        devicePixelRatio: window.devicePixelRatio,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        prefersLight: window.matchMedia("(prefers-color-scheme: light)").matches,
      },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      },
      thread: rectOf('[data-testid="final-message"] .thread-inner'),
      markdown: rectOf('[data-testid="final-message"] .md'),
      code: rectOf('[data-testid="final-message"] pre'),
      table: rectOf('[data-testid="final-message"] table'),
    };
  });

  expect(geometry.document.scrollWidth).toBeLessThanOrEqual(geometry.document.clientWidth);
  expect(geometry.markdown?.width ?? 0).toBeGreaterThan(0);
  expect(geometry.markdown?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    geometry.viewport.width,
  );
  expect(geometry.viewport.devicePixelRatio).toBe(1);
  expect(geometry.viewport.prefersLight).toBe(true);

  await testInfo.attach("assistant-rendering-geometry", {
    body: JSON.stringify(geometry, null, 2),
    contentType: "application/json",
  });

  const screenshotPath = testInfo.outputPath("assistant-rendering.png");
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  });
  await testInfo.attach("assistant-rendering-diagnostic", {
    path: screenshotPath,
    contentType: "image/png",
  });
});
