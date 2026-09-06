import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

test("avatar crop uploads locally and returns to account", async ({ page }) => {
  await page.goto("/canvas.html?scene=account");
  await page
    .getByLabel("上传头像图片")
    .setInputFiles("public/assets/favicon.png");
  await expect(
    page.getByText("The image must be at least 128×128 pixels.", {
      exact: true,
    }),
  ).toBeVisible();
  const sample = new PNG({ width: 256, height: 256 });
  sample.data.fill(128);
  for (let i = 3; i < sample.data.length; i += 4) sample.data[i] = 255;
  await page.getByLabel("上传头像图片").setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: PNG.sync.write(sample),
  });
  await expect(page.getByLabel("头像裁剪区域")).toBeVisible();
  await page.getByRole("button", { name: "确认并上传", exact: true }).click();
  await expect(page.getByLabel("头像裁剪区域")).not.toBeVisible();
  await expect(page.locator('img[src^="blob:"]').first()).toBeVisible();
});

test("share snapshot can be created, opened, and revoked", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/canvas.html?scene=share-dialog");
  await page.getByRole("button", { name: "创建链接", exact: true }).click();
  await expect(page.getByRole("button", { name: "撤销链接" })).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain("/share/design-share-");
  const shared = await context.newPage();
  await shared.goto(link);
  await expect(
    shared.getByRole("heading", { name: "从一个清晰的界面开始" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "撤销链接" }).click();
  await expect(
    page.getByRole("button", { name: "创建链接", exact: true }),
  ).toBeVisible();
  await shared.reload();
  await expect(
    shared.getByRole("heading", { name: "从一个清晰的界面开始" }),
  ).not.toBeVisible();
});

test("model editor saves local catalog and lock returns to access gate", async ({
  page,
}) => {
  await page.goto("/canvas.html?scene=admin");
  await page
    .getByRole("button", { name: "编辑模型 DeepSeek", exact: true })
    .click();
  await page.getByLabel("显示名称", { exact: true }).fill("Design model");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑模型 Design model", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "锁定模型管理控制台" }).click();
  await expect(page.getByLabel("固定访问密钥", { exact: true })).toBeVisible();
});

test("history navigation preserves the current composer draft", async ({
  page,
}, info) => {
  await page.goto("/canvas.html?scene=chat");
  await page.locator("textarea").fill("留在原会话中的草稿");
  if (info.project.name === "mobile")
    await page.getByRole("button", { name: "打开历史" }).click();
  await page
    .getByRole("button", { name: "数据库连接与索引 · 1", exact: true })
    .click();
  await expect(page.locator("textarea")).toHaveValue("");
  if (info.project.name === "mobile")
    await page.getByRole("button", { name: "打开历史" }).click();
  await page.getByRole("button", { name: "从设计到实现", exact: true }).click();
  await expect(page.locator("textarea")).toHaveValue("留在原会话中的草稿");
});

test("fit preview preserves the actual canvas viewport", async ({ page }) => {
  await page.goto("/?scene=welcome&width=1440&height=900");
  const frame = page.frameLocator("iframe");
  await expect
    .poll(() => frame.locator("body").evaluate(() => innerWidth))
    .toBe(1440);
  await page.getByRole("button", { name: "100%", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 0, 0)",
  );
  await expect
    .poll(() => frame.locator("body").evaluate(() => innerWidth))
    .toBe(1440);
});
