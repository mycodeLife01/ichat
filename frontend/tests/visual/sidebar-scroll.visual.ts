import { expect, test } from "@playwright/test";

test("keeps an overflowing conversation history scrollbar inside clipping boundaries", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Desktop sidebar behavior");
  await page.goto("/tests/visual/sidebar-scroll.html");

  const history = page.getByTestId("conversation-history");
  await expect(history).toBeVisible();

  const geometry = await history.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const scrollbarWidth = Number.parseFloat(
      getComputedStyle(element, "::-webkit-scrollbar").width,
    );
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
  expect(geometry.scrollbarWidth).toBeGreaterThan(0);
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
