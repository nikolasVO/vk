import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.VK_DATA_DIR || projectDir);
const profileDir = path.join(dataDir, ".vk-browser-profile");
const transferPath = path.join(dataDir, ".vk-browser-session-transfer.json");
const chromePath =
  process.env.CHROME_EXECUTABLE_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function hasVkCookie(cookies) {
  return cookies.some(
    (cookie) =>
      ["remixsid", "remixsid6"].includes(cookie.name) && Boolean(cookie.value),
  );
}

function readGroupId() {
  if (/^\d+$/.test(process.env.VK_GROUP_ID ?? "")) {
    return process.env.VK_GROUP_ID;
  }
  const envPath = path.join(dataDir, ".env");
  if (fs.existsSync(envPath)) {
    const match = fs
      .readFileSync(envPath, "utf8")
      .match(/^\s*VK_GROUP_ID\s*=\s*["']?(\d+)["']?\s*$/m);
    if (match) return match[1];
  }
  throw new Error("VK_GROUP_ID не указан в окружении или /data/.env");
}

async function connectToDockerChromium() {
  const cdpUrl = process.env.BROWSER_CDP_URL?.trim();
  if (!cdpUrl) throw new Error("BROWSER_CDP_URL не задан");
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 60000 });
  const context = browser.contexts()[0];
  if (!context) {
    browser._shouldCloseConnectionOnClose = true;
    await browser.close().catch(() => {});
    throw new Error("Docker Chromium не вернул профиль");
  }
  return { browser, context };
}

async function disconnectFromDockerChromium(browser, page) {
  await page?.close().catch(() => {});
  // Для connectOverCDP это закрывает только WebSocket Playwright.
  // Сам постоянно работающий Chromium остаётся запущенным.
  await browser.close().catch(() => {});
}

async function exportSession() {
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: true,
  });
  try {
    const cookies = await context.cookies(["https://vk.ru", "https://vk.com"]);
    if (!hasVkCookie(cookies)) {
      throw new Error("В локальном профиле не найдена авторизованная сессия VK");
    }
    const state = await context.storageState();
    fs.writeFileSync(
      transferPath,
      `${JSON.stringify(state)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    console.log("Сессия VK подготовлена для переноса в Docker.");
  } finally {
    await context.close();
  }
}

async function importSession() {
  if (!fs.existsSync(transferPath)) {
    throw new Error(`Не найден файл переноса: ${transferPath}`);
  }
  const state = JSON.parse(fs.readFileSync(transferPath, "utf8"));
  if (!Array.isArray(state.cookies) || !hasVkCookie(state.cookies)) {
    throw new Error("В файле переноса нет сессии VK");
  }

  const { browser, context } = await connectToDockerChromium();
  const page = await context.newPage();
  try {
    await context.addCookies(state.cookies);
    await page.goto("https://vk.ru/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(3000);
    const cookies = await context.cookies(["https://vk.ru", "https://vk.com"]);
    if (!hasVkCookie(cookies)) {
      throw new Error("Chromium не сохранил импортированную сессию");
    }
    fs.unlinkSync(transferPath);
    console.log("Сессия VK перенесена в Docker и сохранена в /config.");
  } finally {
    await disconnectFromDockerChromium(browser, page);
  }
}

async function checkSession() {
  const groupId = readGroupId();
  const { browser, context } = await connectToDockerChromium();
  const page = await context.newPage();
  try {
    await page.goto(`https://vk.ru/club${groupId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(4000);
    const cookies = await context.cookies(["https://vk.ru", "https://vk.com"]);
    if (!hasVkCookie(cookies) || /login|auth/i.test(page.url())) {
      throw new Error("Docker Chromium не авторизован в VK");
    }
    const createButton = page
      .locator("button:visible")
      .filter({ hasText: "Создать" })
      .last();
    if (!(await createButton.isVisible())) {
      const controls = await page
        .locator('button, [role="button"], a')
        .evaluateAll((elements) =>
          elements
            .filter((element) => {
              const style = window.getComputedStyle(element);
              const box = element.getBoundingClientRect();
              return (
                style.visibility !== "hidden" &&
                style.display !== "none" &&
                box.width > 0 &&
                box.height > 0
              );
            })
            .slice(0, 120)
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              text: (element.innerText || element.textContent || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 160),
              ariaLabel: element.getAttribute("aria-label"),
              title: element.getAttribute("title"),
              href: element.getAttribute("href"),
            })),
        );
      const screenshotPath = path.join(dataDir, "vk_admin_check.png");
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.error(
        `Доступные элементы управления:\n${JSON.stringify(controls, null, 2)}`,
      );
      console.error(`Снимок проверки: ${screenshotPath}`);
      throw new Error(
        `В группе ${groupId} не найдена кнопка «Создать»: проверьте права администратора`,
      );
    }
    console.log(
      `Docker Chromium авторизован; управление группой ${groupId} доступно.`,
    );
  } finally {
    await disconnectFromDockerChromium(browser, page);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      export: { type: "boolean", default: false },
      import: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
    },
  });
  const modeCount = [values.export, values.import, values.check].filter(
    Boolean,
  ).length;
  if (modeCount !== 1) {
    throw new Error(
      "Укажите ровно один режим: --export, --import или --check",
    );
  }
  if (values.export) await exportSession();
  else if (values.import) await importSession();
  else await checkSession();
}

main().catch((error) => {
  console.error(`ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = 1;
});
