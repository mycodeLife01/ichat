import { expect, test } from "@playwright/test";

test("keeps an overflowing conversation history scrollbar inside clipping boundaries", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Desktop sidebar behavior");
  await page.goto("/tests/visual/sidebar-scroll.html");

  const history = page.getByTestId("conversation-history");
  await expect(history).toBeVisible();

  const surfaceColors = await page.evaluate(() => ({
    page: getComputedStyle(document.body).backgroundColor,
    sidebar: getComputedStyle(document.querySelector("aside")!).backgroundColor,
    sidebarWidth: getComputedStyle(document.querySelector("aside")!).width,
    card: getComputedStyle(document.querySelector('[data-testid="card-surface"]')!).backgroundColor,
  }));
  expect(surfaceColors).toEqual({
    page: "rgb(252, 252, 252)",
    sidebar: "rgb(252, 252, 252)",
    sidebarWidth: "260px",
    card: "rgb(255, 255, 255)",
  });

  const accountGeometry = await page
    .getByRole("button", { name: "打开个人中心" })
    .evaluate((element) => {
      const button = element.getBoundingClientRect();
      const regionElement = element.parentElement;
      const region = regionElement?.getBoundingClientRect();
      const regionStyle = regionElement && getComputedStyle(regionElement);
      const sidebar = element.closest("aside")?.getBoundingClientRect();
      const avatar = element.firstElementChild?.getBoundingClientRect();
      return {
        button: { left: button.left, right: button.right, top: button.top, height: button.height },
        region: region && { top: region.top, bottom: region.bottom, height: region.height },
        sidebar: sidebar && { left: sidebar.left, right: sidebar.right, bottom: sidebar.bottom },
        avatarLeft: avatar?.left,
        regionBorderTop: regionStyle?.borderTopWidth,
      };
    });
  expect(accountGeometry.button.height).toBeCloseTo(52, 1);
  expect(accountGeometry.region?.height).toBeCloseTo(67, 1);
  expect(accountGeometry.regionBorderTop).toBe("1px");
  expect(accountGeometry.button.left - (accountGeometry.sidebar?.left ?? Number.NaN)).toBeCloseTo(
    6,
    1,
  );
  expect((accountGeometry.sidebar?.right ?? Number.NaN) - accountGeometry.button.right).toBeCloseTo(
    6,
    1,
  );
  expect(accountGeometry.button.top - (accountGeometry.region?.top ?? Number.NaN)).toBeCloseTo(
    9,
    1,
  );
  expect(
    (accountGeometry.region?.bottom ?? Number.NaN) -
      (accountGeometry.button.top + accountGeometry.button.height),
  ).toBeCloseTo(6, 1);
  expect(
    (accountGeometry.avatarLeft ?? Number.NaN) -
      (accountGeometry.sidebar?.left ?? Number.NaN),
  ).toBeCloseTo(14, 1);
  expect(accountGeometry.region?.bottom).toBeCloseTo(
    accountGeometry.sidebar?.bottom ?? Number.NaN,
    1,
  );

  const geometry = await history.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Conversation history must be an HTML element");
    }
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const borderInline =
      Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
    const scrollbarWidth = element.offsetWidth - element.clientWidth - borderInline;
    const sidebarBounds = element.closest("aside")?.getBoundingClientRect();
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
      scrollbarColor: style.scrollbarColor,
      scrollbarSizing: style.scrollbarWidth,
      sidebarTop: sidebarBounds?.top,
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
  expect(geometry.y).toBeCloseTo(geometry.sidebarTop ?? Number.NaN, 1);
  expect(geometry.scrollbarWidth).toBeGreaterThan(0);
  expect(geometry.scrollbarSizing).toBe("auto");
  expect(geometry.scrollbarColor).toBe("rgba(0, 0, 0, 0.1) rgba(0, 0, 0, 0)");
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
  await expect.poll(() => history.evaluate((element) => getComputedStyle(element).scrollbarColor))
    .toBe("rgba(0, 0, 0, 0.2) rgba(0, 0, 0, 0)");
  await page.mouse.wheel(0, 200);

  await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});
