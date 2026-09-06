import { test, expect } from "@playwright/test";
test("send, stop, retry, and preserve a conversation draft", async ({
  page,
}) => {
  await page.goto("/canvas.html?scene=chat");
  await page.locator("textarea").fill("新的设计需求");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeVisible();
  await page.locator("textarea").fill("停止后继续设计");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".msg.user")).toHaveCount(3);
});
test("failed send retains input and the retry succeeds", async ({ page }) => {
  await page.goto("/canvas.html?scene=send-error");
  await page.locator("textarea").fill("保留我的草稿");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("textarea")).toHaveValue("保留我的草稿");
  await expect(
    page.getByText("发送失败，请重试", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toBeVisible();
});
test("search accepts text, clears, selects, and closes", async ({ page }) => {
  await page.goto("/canvas.html?scene=search");
  const input = page.getByRole("combobox", { name: "搜索历史对话" });
  await expect(input).toBeFocused();
  await input.fill("数据库");
  await expect(page.getByRole("option").first()).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).not.toBeVisible();
});
test("account changes nickname and navigates password form", async ({
  page,
}) => {
  await page.goto("/canvas.html?scene=account");
  await page.getByRole("textbox", { name: "昵称" }).fill("新的昵称");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "昵称" })).toHaveValue(
    "新的昵称",
  );
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  await expect(
    page.getByPlaceholder("当前密码", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭账号" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
test("authentication validates and enters the workspace", async ({ page }) => {
  await page.goto("/canvas.html?scene=login");
  await page.getByRole("textbox", { name: "用户名或邮箱" }).fill("designer");
  await page
    .getByRole("textbox", { name: "密码", exact: true })
    .fill("design-demo");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".composer")).toBeVisible();
});
test("attachment selection uses local content and removal", async ({
  page,
}) => {
  await page.goto("/canvas.html?scene=welcome");
  await page.getByLabel("选择附件").setInputFiles({
    name: "sample.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Local design document"),
  });
  await expect(
    page.getByText("sample.txt", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove attachment" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove attachment" }).first().click();
  await expect(page.getByText("sample.txt", { exact: true })).not.toBeVisible();
});
test("candidate is isolated and reset clears the canvas", async ({ page }) => {
  await page.goto("/?scene=welcome");
  const frame = page.frameLocator("iframe");
  await frame.locator("textarea").fill("临时草稿");
  await page.getByRole("button", { name: "重置", exact: true }).click();
  await expect(frame.locator("textarea")).toHaveValue("");
  const radius = await frame
    .locator(".composer")
    .evaluate((el) => getComputedStyle(el).borderRadius);
  await page.getByLabel("设计版本").selectOption("example-composer");
  await expect(frame.locator(".composer")).toHaveCSS("border-radius", "20px");
  await page.getByLabel("设计版本").selectOption("current");
  await expect(frame.locator(".composer")).toHaveCSS("border-radius", radius);
});
test("source selection creates a quote and removal restores composer", async ({
  page,
}) => {
  await page.goto("/canvas.html?scene=chat");
  await page.locator(".thread-region").evaluate((e) => {
    e.scrollTop = 0;
  });
  await page.waitForTimeout(350); // Let the scroll dismissal settle before selecting text.
  const source = page.locator("[data-reply-quote-message-id]").first();
  await source.evaluate((el) => {
    const text = el.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByRole("button", { name: "询问Piko" })).toBeVisible();
  await page.getByRole("button", { name: "询问Piko" }).click();
  await expect(
    page.locator(".composer").getByRole("button", { name: "取消引用" }),
  ).toBeVisible();
});
