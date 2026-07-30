import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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

async function main() {
  const { values } = parseArgs({
    options: {
      "post-id": { type: "string" },
      delete: { type: "boolean", default: false },
    },
  });
  if (!/^\d+$/.test(values["post-id"] ?? "")) {
    throw new Error("Укажите числовой --post-id");
  }

  const groupId = loadGroupId();
  const postId = values["post-id"];
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: false,
    viewport: { width: 1440, height: 1000 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(`https://vk.ru/wall-${groupId}_${postId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(6000);

    const candidateButtons = page.locator(
      [
        'button[aria-label*="Действ"]',
        'button[aria-label*="действ"]',
        '[role="button"][aria-label*="Действ"]',
        '[role="button"][aria-label*="действ"]',
        '[data-testid*="action"]',
        '[data-testid*="menu"]',
      ].join(","),
    );
    const candidates = [];
    for (let index = 0; index < (await candidateButtons.count()); index += 1) {
      const item = candidateButtons.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      candidates.push(
        await item.evaluate((element) => ({
          tag: element.tagName,
          ariaLabel: element.getAttribute("aria-label"),
          testId: element.getAttribute("data-testid"),
          text: (element.innerText || element.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120),
          className:
            typeof element.className === "string"
              ? element.className.slice(0, 180)
              : "",
        })),
      );
    }

    const actionButton = page
      .locator(
        [
          'button[aria-label*="Действия с записью"]',
          '[role="button"][aria-label*="Действия с записью"]',
          '[data-testid*="post"][data-testid*="menu"]',
        ].join(","),
      )
      .first();
    if (!(await actionButton.isVisible().catch(() => false))) {
      console.log("Кандидаты кнопок:", JSON.stringify(candidates, null, 2));
      await page.screenshot({
        path: path.join(projectDir, `vk_post_${postId}_inspect.png`),
        fullPage: false,
      });
      throw new Error(
        `Не найдена кнопка действий; сохранён vk_post_${postId}_inspect.png`,
      );
    }

    await actionButton.click();
    await page.waitForTimeout(1200);
    const deleteItem = page.getByText(/^Удалить(?: (?:запись|пост))?$/i).last();
    if (!(await deleteItem.isVisible().catch(() => false))) {
      console.log(
        "Видимый текст страницы после меню:",
        (await page.locator("body").innerText()).slice(-4000),
      );
      throw new Error("В меню не найден пункт удаления");
    }

    if (!values.delete) {
      console.log("Пункт удаления найден. Для удаления добавьте --delete.");
      return;
    }

    await deleteItem.click();
    await page.waitForTimeout(1500);
    const confirmButton = page
      .getByRole("button", { name: /^Удалить$/i })
      .last();
    if (await confirmButton.isVisible().catch(() => false)) {
      await confirmButton.click();
    }
    await page.waitForTimeout(4000);
    console.log(`Запись wall-${groupId}_${postId} удалена через браузер.`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(`ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = 1;
});
