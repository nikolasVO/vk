import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.VK_DATA_DIR || projectDir);
const cdpUrl =
  process.env.BROWSER_CDP_URL?.trim() || "http://127.0.0.1:9222";

function readGroupId() {
  if (/^\d+$/.test(process.env.VK_GROUP_ID ?? "")) {
    return process.env.VK_GROUP_ID;
  }
  const envText = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  const match = envText.match(
    /^\s*VK_GROUP_ID\s*=\s*["']?(\d+)["']?\s*$/m,
  );
  if (!match) throw new Error("VK_GROUP_ID не найден");
  return match[1];
}

async function main() {
  const groupId = readGroupId();
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 60000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Docker Chromium не вернул профиль");
  const page = await context.newPage();
  const items = new Map();
  try {
    await page.goto(`https://vk.ru/club${groupId}?act=market_group_items`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(5000);
    if (/login|auth/i.test(page.url())) {
      throw new Error("Docker Chromium не авторизован в VK");
    }

    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      let unchanged = 0;
      for (let attempt = 0; attempt < 40 && unchanged < 5; attempt += 1) {
        const visibleItems = await page
          .locator('a[href*="/market/product/"]')
          .evaluateAll((elements) =>
            elements.map((element) => {
              let row = element;
              for (
                let level = 0;
                level < 10 && row.parentElement;
                level += 1
              ) {
                const parent = row.parentElement;
                const productLinks = parent.querySelectorAll(
                  'a[href*="/market/product/"]',
                );
                if (productLinks.length > 1) break;
                row = parent;
              }
              return {
                href: element.href,
                title: (element.innerText || element.textContent || "")
                  .replace(/\s+/g, " ")
                  .trim(),
                inputValues: [...row.querySelectorAll("input")]
                  .map((input) => input.value)
                  .filter(Boolean),
                rowText: (row.innerText || row.textContent || "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 600),
              };
            }),
          );
        const previousSize = items.size;
        for (const item of visibleItems) {
          if (item.href && item.title) items.set(item.href, item);
        }
        unchanged = items.size === previousSize ? unchanged + 1 : 0;

        await page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          for (const element of document.querySelectorAll("*")) {
            const style = window.getComputedStyle(element);
            if (
              /(auto|scroll)/.test(style.overflowY) &&
              element.scrollHeight > element.clientHeight + 80
            ) {
              element.scrollTop = element.scrollHeight;
            }
          }
        });
        await page.waitForTimeout(750);
      }

      const expectedNextPage = String(pageNumber + 1);
      const controls = page.locator('button, [role="button"]');
      const nextIndex = await controls.evaluateAll(
        (elements, expected) =>
          elements.findIndex((element) => {
            const style = window.getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return (
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              box.width > 0 &&
              box.height > 0 &&
              (element.innerText || element.textContent || "").trim() ===
                expected
            );
          }),
        expectedNextPage,
      );
      if (nextIndex < 0) break;
      await controls.nth(nextIndex).click();
      await page.waitForTimeout(2500);
    }

    const result = {
      version: 1,
      group_id: groupId,
      fetched_at: new Date().toISOString(),
      items: [...items.values()].map((item) => ({
        url: item.href,
        title: item.title,
        input_values: item.inputValues,
        row_text: item.rowText,
      })),
    };
    const outputPath = path.join(dataDir, "vk_market_existing.json");
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await page.screenshot({
      path: path.join(dataDir, "vk_market_existing.png"),
      fullPage: false,
    });
    console.log(`Найдено существующих карточек: ${items.size}`);
    console.log(`Список: ${outputPath}`);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = 1;
});
