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

async function main() {
  const groupId = loadGroupId();
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await page.goto(`https://vk.ru/club${groupId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(8000);
    const candidates = await page.locator("[id], [data-testid]").evaluateAll(
      (elements, expectedGroupId) =>
        elements
          .map((element) => ({
            id: element.id || "",
            testId: element.getAttribute("data-testid") || "",
            text: (element.innerText || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 140),
            images: element.querySelectorAll("img").length,
          }))
          .filter(
            (item) =>
              /post|wall/i.test(`${item.id} ${item.testId}`) ||
              item.id.includes(`-${expectedGroupId}_`),
          )
          .slice(0, 100),
      groupId,
    );
    console.log(JSON.stringify(candidates, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(`ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = 1;
});
