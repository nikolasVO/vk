import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(projectDir, ".env");
const profileDir = path.join(projectDir, ".vk-browser-profile");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function loadEnv(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

async function hasVkSession(context) {
  const cookies = await context.cookies(["https://vk.ru", "https://vk.com"]);
  return cookies.some(
    (cookie) =>
      ["remixsid", "remixsid6"].includes(cookie.name) && Boolean(cookie.value),
  );
}

async function main() {
  const env = loadEnv(envPath);
  const groupId = env.VK_GROUP_ID;
  if (!/^\d+$/.test(groupId ?? "")) {
    throw new Error("VK_GROUP_ID не указан в .env");
  }

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());
  await page.goto(`https://vk.ru/club${groupId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  if (await hasVkSession(context)) {
    console.log("Сессия VK уже сохранена в профиле автоматизации.");
    await context.close();
    return;
  }

  console.log("Войдите в VK в открытом окне Chrome.");
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await hasVkSession(context)) {
      console.log("Вход подтверждён. Сессия сохранена локально.");
      await page.waitForTimeout(2000);
      await context.close();
      return;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("Время ожидания входа истекло.");
}

main().catch((error) => {
  console.error(`ОШИБКА: ${error.message}`);
  process.exitCode = 1;
});
