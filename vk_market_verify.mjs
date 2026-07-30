import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.VK_DATA_DIR || projectDir);
const cdpUrl =
  process.env.BROWSER_CDP_URL?.trim() || "http://127.0.0.1:9222";

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
    },
  });
  if (!values.url) throw new Error("Укажите --url карточки товара");
  const target = new URL(values.url);
  if (!["vk.ru", "www.vk.ru", "vk.com", "www.vk.com"].includes(target.host)) {
    throw new Error("Разрешены только ссылки на VK");
  }

  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 60000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Docker Chromium не вернул профиль");
  const page = await context.newPage();
  try {
    await page.goto(target.href, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(6000);
    const screenshotPath = path.join(
      dataDir,
      "vk_market_product_verify.png",
    );
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const title =
      (await page
        .locator('meta[property="og:title"]')
        .getAttribute("content")
        .catch(() => "")) || (await page.title());
    const bodyText = (await page.locator("body").innerText())
      .replace(/\s+/g, " ")
      .trim();
    const visibleImages = await page.locator("img").evaluateAll((elements) =>
      elements
        .filter((image) => {
          const box = image.getBoundingClientRect();
          const style = window.getComputedStyle(image);
          return (
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            box.width >= 70 &&
            box.height >= 70
          );
        })
        .map((image) => ({
          src: image.currentSrc || image.src,
          alt: image.alt,
          width: Math.round(image.getBoundingClientRect().width),
          height: Math.round(image.getBoundingClientRect().height),
        })),
    );
    const uniqueImages = [
      ...new Map(
        visibleImages
          .filter((image) => image.src)
          .map((image) => [image.src, image]),
      ).values(),
    ];
    const result = {
      version: 1,
      url: page.url(),
      title,
      text: bodyText.slice(0, 10000),
      visible_images: uniqueImages,
      checked_at: new Date().toISOString(),
    };
    const outputPath = path.join(dataDir, "vk_market_product_verify.json");
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(`Карточка: ${page.url()}`);
    console.log(`Заголовок: ${title}`);
    console.log(`Видимых изображений >= 70 px: ${uniqueImages.length}`);
    console.log(`Проверка: ${outputPath}`);
    console.log(`Снимок: ${screenshotPath}`);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = 1;
});
