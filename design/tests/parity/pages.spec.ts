import { test, expect, type Page } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { writeFile } from "node:fs/promises";
const ids = [
  "chat",
  "rail",
  "sources",
  "account",
  "my-shares",
  "welcome",
  "long",
  "unverified",
  "quote",
  "share-dialog",
  "share",
  "share-invalid",
  "login",
  "register",
  "forgot",
  "verify",
  "verify-invalid",
  "reset",
  "reset-invalid",
  "delete-account",
  "delete-invalid",
  "admin",
  "admin-gate",
  "thinking",
  "streaming",
  "failed",
  "cancelled",
];
async function settle(page: Page) {
  await page.locator("#root").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.evaluate(async () => {
    const thread = document.querySelector(".thread-region");
    if (thread) thread.scrollTop = thread.scrollHeight;
  });
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      if (a.effect?.getTiming().iterations === Infinity) {
        a.pause();
        a.currentTime = 0;
      } else a.finish();
    }
  });
  await page.waitForTimeout(100);
}
for (const id of ids)
  test(`${id} source parity`, async ({ browser }, info) => {
    const options = {
      ...info.project.use,
      ...info.project.use.contextOptions,
      baseURL: undefined,
    };
    const a = await browser.newPage(options);
    const b = await browser.newPage(options);
    for (const p of [a, b]) {
      p.setDefaultTimeout(6000);
      if (["login", "register", "forgot"].includes(id))
        await p.addInitScript(() =>
          Object.defineProperty(performance, "now", { value: () => 1000 }),
        );
      else await p.clock.setFixedTime(new Date("2026-09-06T02:00:00Z"));
      await p.route("https://www.google.com/s2/**", (route) =>
        route.fulfill({
          path: "public/assets/favicon.png",
          contentType: "image/png",
        }),
      );
    }
    await a.goto(
      `http://127.0.0.1:5183/tests/design-reference/index.html?scene=${id}`,
    );
    await b.goto(`http://127.0.0.1:5182/canvas.html?scene=${id}`);
    if (id === "register")
      await a.getByRole("tab", { name: "注册", exact: true }).first().click();
    if (id === "forgot")
      await a.getByRole("button", { name: "忘记密码？", exact: true }).click();
    if (["account", "my-shares"].includes(id)) {
      if (info.project.name === "mobile")
        await a.getByRole("button", { name: "打开历史", exact: true }).click();
      await a.getByRole("button", { name: "打开个人中心" }).click();
      await a
        .getByRole(info.project.name === "mobile" ? "button" : "menuitem", {
          name: id === "account" ? "账号" : "我的分享",
          exact: true,
        })
        .click();
    }
    if (id === "sources")
      await a.getByRole("button", { name: "查看 1 个来源" }).click();
    await settle(a);
    await settle(b);
    for (const [name, page] of [
      ["source", a],
      ["design", b],
    ] as const) {
      await writeFile(
        info.outputPath(`${name}-layout.json`),
        JSON.stringify(
          await page.evaluate(() =>
            [...document.querySelectorAll("img")].map((el) => ({
              src: el.src,
              rect: el.getBoundingClientRect().toJSON(),
              parents: [el.parentElement, el.parentElement?.parentElement].map(
                (p) => ({
                  rect: p?.getBoundingClientRect().toJSON(),
                  class: p?.className,
                }),
              ),
              scroll: document.querySelector(".thread-region")?.scrollTop,
            })),
          ),
          null,
          2,
        ),
      );
    }
    const before = await a.screenshot({ path: info.outputPath("source.png") });
    const after = await b.screenshot({ path: info.outputPath("design.png") });
    const left = PNG.sync.read(before);
    const right = PNG.sync.read(after);
    expect({ width: right.width, height: right.height }).toEqual({
      width: left.width,
      height: left.height,
    });
    const diff = new PNG({ width: left.width, height: left.height });
    const diffOptions = { threshold: 0.05, includeAA: true };
    const count = pixelmatch(
      left.data,
      right.data,
      diff.data,
      left.width,
      left.height,
      diffOptions,
    );
    let rawCount = 0;
    for (let i = 0; i < left.data.length; i += 4)
      if ([0, 1, 2, 3].some((k) => left.data[i + k] !== right.data[i + k]))
        rawCount++;
    await writeFile(info.outputPath("diff.png"), PNG.sync.write(diff));
    await writeFile(
      info.outputPath("metrics.json"),
      JSON.stringify(
        {
          pixels: count,
          rawPixels: rawCount,
          total: left.width * left.height,
          ...diffOptions,
        },
        null,
        2,
      ),
    );
    await a.close();
    await b.close();
    expect(
      count,
      "Different pixels; inspect source/design/diff artifacts",
    ).toBe(0);
  });
