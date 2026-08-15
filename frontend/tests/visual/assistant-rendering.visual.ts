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
        fontWeight: style.fontWeight,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderLeftWidth: style.borderLeftWidth,
        borderTopWidth: style.borderTopWidth,
        borderRadius: style.borderRadius,
        marginTop: style.marginTop,
        marginRight: style.marginRight,
        marginBottom: style.marginBottom,
        marginLeft: style.marginLeft,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        overflowX: style.overflowX,
        overflowWrap: style.overflowWrap,
      };
    };

    const rootStyle = getComputedStyle(document.documentElement);

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
      tokens: {
        readingWidth: rootStyle.getPropertyValue("--reading-width").trim(),
        assistantContentWidth: rootStyle
          .getPropertyValue("--assistant-content-width")
          .trim(),
      },
      thread: rectOf('[data-testid="final-message"] .thread-inner'),
      assistantContent: rectOf('[data-testid="final-message"] .assistant-content'),
      markdown: rectOf('[data-testid="final-message"] .assistant-markdown'),
      h1: rectOf('[data-testid="final-message"] .assistant-markdown h1'),
      h2: rectOf('[data-testid="final-message"] .assistant-markdown h2'),
      h3: rectOf('[data-testid="final-message"] .assistant-markdown h3'),
      h4: rectOf('[data-testid="final-message"] .assistant-markdown h4'),
      h5: rectOf('[data-testid="final-message"] .assistant-markdown h5'),
      h6: rectOf('[data-testid="final-message"] .assistant-markdown h6'),
      paragraph: rectOf('[data-testid="final-message"] .assistant-markdown > p'),
      inlineCode: rectOf('[data-testid="final-message"] .assistant-markdown p code'),
      blockquote: rectOf('[data-testid="final-message"] .assistant-markdown blockquote'),
      list: rectOf(
        '[data-testid="final-message"] .assistant-markdown ul:not(.contains-task-list)',
      ),
      rule: rectOf('[data-testid="final-message"] .assistant-markdown hr'),
      code: rectOf('[data-testid="final-message"] pre'),
      table: rectOf('[data-testid="final-message"] table'),
    };
  });

  const expectPx = (value: number | string | undefined, expected: number) => {
    const actual = typeof value === "number" ? value : Number.parseFloat(value ?? "NaN");
    expect(actual).toBeCloseTo(expected, 1);
  };

  expect(geometry.document.scrollWidth).toBeLessThanOrEqual(geometry.document.clientWidth);
  expect(geometry.tokens.readingWidth).toBe("820px");
  expect(geometry.tokens.assistantContentWidth).toBe("768px");
  expect(geometry.markdown?.width ?? 0).toBeGreaterThan(0);
  expect(geometry.markdown?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    geometry.viewport.width,
  );
  expectPx(geometry.markdown?.fontSize, 16);
  expectPx(geometry.markdown?.lineHeight, 26);
  expect(geometry.markdown?.fontWeight).toBe("400");
  expect(geometry.markdown?.color).toBe("rgb(13, 13, 13)");
  expect(geometry.markdown?.overflowWrap).toBe("anywhere");

  expectPx(geometry.h1?.fontSize, 24);
  expectPx(geometry.h1?.lineHeight, 32);
  expect(geometry.h1?.fontWeight).toBe("600");
  expectPx(geometry.h1?.marginBottom, 8);
  expectPx(geometry.h2?.fontSize, 20);
  expectPx(geometry.h2?.lineHeight, 28);
  expect(geometry.h2?.fontWeight).toBe("600");
  expectPx(geometry.h2?.marginTop, 16);
  expectPx(geometry.h2?.marginBottom, 4);
  expectPx(geometry.h3?.fontSize, 18);
  expectPx(geometry.h3?.lineHeight, 28);
  expect(geometry.h3?.fontWeight).toBe("600");
  expectPx(geometry.h3?.marginTop, 16);
  expectPx(geometry.h3?.marginBottom, 4);
  expectPx(geometry.h4?.fontSize, 16);
  expectPx(geometry.h4?.lineHeight, 24);
  expect(geometry.h4?.fontWeight).toBe("600");
  expectPx(geometry.h4?.marginTop, 16);
  expectPx(geometry.h5?.fontSize, 16);
  expectPx(geometry.h5?.lineHeight, 26);
  expect(geometry.h5?.fontWeight).toBe("600");
  expectPx(geometry.h5?.marginTop, 0);
  expectPx(geometry.h6?.fontSize, 16);
  expectPx(geometry.h6?.lineHeight, 26);
  expect(geometry.h6?.fontWeight).toBe("400");
  expectPx(geometry.h6?.marginTop, 0);

  expectPx(geometry.paragraph?.fontSize, 16);
  expectPx(geometry.paragraph?.lineHeight, 26);
  expectPx(geometry.paragraph?.marginBottom, 4);
  expectPx(geometry.inlineCode?.fontSize, 14);
  expectPx(geometry.inlineCode?.lineHeight, 26);
  expect(geometry.inlineCode?.fontWeight).toBe("500");
  expect(geometry.inlineCode?.backgroundColor).toBe("rgb(236, 236, 236)");
  expectPx(geometry.inlineCode?.borderTopWidth, 0);
  expectPx(geometry.inlineCode?.borderRadius, 4);
  expectPx(geometry.inlineCode?.paddingTop, 2.4);
  expectPx(geometry.inlineCode?.paddingRight, 4.8);

  expectPx(geometry.blockquote?.lineHeight, 24);
  expectPx(geometry.blockquote?.marginLeft, 0);
  expectPx(geometry.blockquote?.marginRight, 0);
  expectPx(geometry.blockquote?.paddingTop, 8);
  expectPx(geometry.blockquote?.paddingRight, 0);
  expectPx(geometry.blockquote?.paddingBottom, 8);
  expectPx(geometry.blockquote?.paddingLeft, 24);
  expectPx(geometry.list?.paddingLeft, 26);
  expectPx(geometry.rule?.marginTop, 28);
  expectPx(geometry.rule?.marginBottom, 28);

  if (geometry.viewport.width > 760) {
    expectPx(geometry.assistantContent?.width, 768);
    expectPx(geometry.markdown?.width, 768);
  } else {
    expect(geometry.assistantContent?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      geometry.viewport.width - 32,
    );
  }
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
