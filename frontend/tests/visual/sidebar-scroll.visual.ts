import { expect, test } from "@playwright/test";

test("keeps an overflowing conversation history scrollbar inside clipping boundaries", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Desktop sidebar behavior");
  await page.goto("/tests/visual/sidebar-scroll.html");

  const history = page.getByTestId("conversation-history");
  await expect(history).toBeVisible();

  const typography = await page.evaluate(() => {
    const signature = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        letterSpacing: style.letterSpacing,
        color: style.color,
        transform: style.transform,
        whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow,
        box: { width: rect.width, height: rect.height },
      };
    };
    const sidebar = document.querySelector(".sidebar-desktop");
    const deepestText = (text: string) =>
      Array.from(sidebar?.querySelectorAll<HTMLElement>("*") ?? []).find(
        (element) =>
          element.textContent?.trim() === text &&
          !Array.from(element.children).some((child) => child.textContent?.trim() === text),
      );
    return {
      root: signature(".sidebar-desktop"),
      wordmark: signature(".sidebar-desktop .wordmark"),
      section: (() => {
        const element = deepestText("聊天");
        if (!element) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          fontWeight: style.fontWeight,
          letterSpacing: style.letterSpacing,
          color: style.color,
          transform: style.transform,
          whiteSpace: style.whiteSpace,
          textOverflow: style.textOverflow,
          box: { width: rect.width, height: rect.height },
        };
      })(),
      firstRow: signature(".sidebar-desktop .history-row span"),
    };
  });
  await testInfo.attach("sidebar-typography-baseline", {
    body: JSON.stringify(typography, null, 2),
    contentType: "application/json",
  });

  const normalizedUiFont =
    "-apple-system-body, ui-sans-serif, -apple-system, system-ui, Segoe UI, Helvetica, Apple Color Emoji, Arial, sans-serif, Segoe UI Emoji, Segoe UI Symbol";
  const normalizeFont = (value: string | undefined) => (value ?? "").replaceAll('"', "");
  expect(normalizeFont(typography.root?.fontFamily)).toBe(normalizedUiFont);
  expect(normalizeFont(typography.wordmark?.fontFamily)).toBe(normalizedUiFont);
  expect(typography.wordmark).toMatchObject({
    fontSize: "18px",
    lineHeight: "24px",
    fontWeight: "600",
    letterSpacing: "-0.27px",
    color: "rgb(13, 13, 13)",
    transform: "matrix(1.04, 0, 0, 0.9, 0, 0)",
  });
  expect(typography.firstRow).toMatchObject({
    fontSize: "14px",
    lineHeight: "20px",
    fontWeight: "400",
    color: "rgb(13, 13, 13)",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  });
  expect(typography.section).toMatchObject({
    fontSize: "14px",
    lineHeight: "20px",
    fontWeight: "500",
    color: "rgb(143, 143, 143)",
    whiteSpace: "nowrap",
  });
  if (process.platform === "darwin") {
    expect(typography.wordmark?.box.width).toBeCloseTo(44.75, 1);
    expect(typography.wordmark?.box.height).toBeCloseTo(21.6, 1);
  }

  const geometry = await history.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const scrollbarWidthCss = getComputedStyle(element, "::-webkit-scrollbar").width;
    const parsedScrollbarWidth = Number.parseFloat(scrollbarWidthCss);
    const scrollbarWidth = Number.isFinite(parsedScrollbarWidth)
      ? parsedScrollbarWidth
      : Math.max(0, bounds.width - element.clientWidth);
    const clippingAncestors = [];
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (!["auto", "clip", "hidden", "scroll"].includes(style.overflowX)) continue;
      const ancestorBounds = ancestor.getBoundingClientRect();
      clippingAncestors.push({
        className: ancestor.className,
        left: ancestorBounds.left,
        right: ancestorBounds.right,
        overflowX: style.overflowX,
      });
    }
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      scrollbarWidth,
      scrollbarWidthCss,
      scrollbarLane: {
        left: bounds.right - scrollbarWidth,
        right: bounds.right,
      },
      clippingAncestors,
    };
  });
  await testInfo.attach("sidebar-scroll-geometry", {
    body: JSON.stringify(geometry, null, 2),
    contentType: "application/json",
  });

  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.scrollTop).toBe(0);
  expect(geometry.scrollbarWidth).toBeGreaterThanOrEqual(0);
  if (geometry.scrollbarWidth === 0) {
    expect(geometry.scrollbarWidthCss).toBe("auto");
  }
  expect(geometry.clippingAncestors.length).toBeGreaterThan(0);
  for (const ancestor of geometry.clippingAncestors) {
    expect(
      geometry.scrollbarLane.left,
      `Scrollbar lane escapes the left edge of ${ancestor.className}`,
    ).toBeGreaterThanOrEqual(ancestor.left - 0.5);
    expect(
      geometry.scrollbarLane.right,
      `Scrollbar lane escapes the right edge of ${ancestor.className}`,
    ).toBeLessThanOrEqual(ancestor.right + 0.5);
  }

  await page.mouse.move(geometry.x + geometry.width / 2, geometry.y + geometry.height / 2);
  await page.mouse.wheel(0, 200);

  await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});
