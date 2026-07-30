import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const profileDir = path.join(projectDir, ".vk-browser-profile");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function loadGroupId() {
  const text = fs.readFileSync(path.join(projectDir, ".env"), "utf8");
  const match = text.match(/^VK_GROUP_ID=(\d+)$/m);
  if (!match) throw new Error("VK_GROUP_ID не найден");
  return match[1];
}

async function describeElements(locator, limit = 100) {
  const count = Math.min(await locator.count(), limit);
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    result.push(
      await item.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type"),
        name: element.getAttribute("name"),
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        testId: element.getAttribute("data-testid"),
        accept: element.getAttribute("accept"),
        multiple: element.hasAttribute("multiple"),
        placeholder: element.getAttribute("placeholder"),
        text: (element.innerText || element.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 180),
        className:
          typeof element.className === "string"
            ? element.className.slice(0, 180)
            : "",
      })),
    );
  }
  return result;
}

async function main() {
  const groupId = loadGroupId();
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: false,
    viewport: { width: 1440, height: 1000 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`https://vk.ru/club${groupId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(5000);
  const createButton = page.getByRole("button", {
    name: "Создать",
    exact: true,
  });
  if (await createButton.isVisible().catch(() => false)) {
    await createButton.click();
    await page.waitForTimeout(1500);
    const postMenuItem = page.getByText("Пост", { exact: true });
    if (await postMenuItem.isVisible().catch(() => false)) {
      await postMenuItem.click();
      await page.waitForTimeout(8000);
    }
  }

  console.log("title", await page.title());
  console.log("url", page.url());
  console.log(
    "buttons",
    JSON.stringify(await describeElements(page.locator("button")), null, 2),
  );
  console.log(
    "inputs",
    JSON.stringify(await describeElements(page.locator("input")), null, 2),
  );
  console.log(
    "editables",
    JSON.stringify(
      await describeElements(page.locator('[contenteditable="true"]')),
      null,
      2,
    ),
  );
  console.log(
    "textareas",
    JSON.stringify(await describeElements(page.locator("textarea")), null, 2),
  );
  console.log(
    "dialogs",
    JSON.stringify(
      await describeElements(page.locator('[role="dialog"]')),
      null,
      2,
    ),
  );
  await page.screenshot({
    path: path.join(projectDir, "vk_group_inspect.png"),
    fullPage: false,
  });
  await context.close();
}

main().catch((error) => {
  console.error(`ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = 1;
});
