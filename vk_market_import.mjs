import crypto from "node:crypto";
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

function normalize(value) {
  return (value || "")
    .normalize("NFKC")
    .replace(/[\p{C}\p{Z}\s]+/gu, "")
    .toLowerCase();
}

async function findVisibleControl(page, expected, { exact = false } = {}) {
  const expectedParts = (Array.isArray(expected) ? expected : [expected]).map(
    normalize,
  );
  const controls = page.locator(
    'a, button, [role="button"], [role="link"], [role="menuitem"]',
  );
  const index = await controls.evaluateAll(
    (elements, { wanted, exactMatch }) => {
      const compact = (value) =>
        (value || "")
          .normalize("NFKC")
          .replace(/[\p{C}\p{Z}\s]+/gu, "")
          .toLowerCase();
      return elements.findIndex((element) => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        if (
          style.visibility === "hidden" ||
          style.display === "none" ||
          box.width <= 0 ||
          box.height <= 0
        ) {
          return false;
        }
        const texts = [
          element.innerText,
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
        ]
          .filter(Boolean)
          .map(compact);
        const text = texts.join("");
        return exactMatch
          ? wanted.some((part) => texts.includes(part))
          : wanted.every((part) => text.includes(part));
      });
    },
    { wanted: expectedParts, exactMatch: exact },
  );
  return index >= 0 ? controls.nth(index) : null;
}

async function waitForVisibleControl(
  page,
  expected,
  options = {},
  timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const control = await findVisibleControl(page, expected, options);
    if (control) return control;
    await page.waitForTimeout(500);
  }
  return null;
}

async function findVisibleFileInput(page) {
  const inputs = page.locator('input[type="file"]');
  const index = await inputs.evaluateAll((elements) =>
    elements.findIndex((element) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        box.width > 0 &&
        box.height > 0
      );
    }),
  );
  return index >= 0 ? inputs.nth(index) : null;
}

async function dumpPage(page, label) {
  const screenshotPath = path.join(dataDir, `vk_market_${label}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  const controls = await page
    .locator(
      'a, button, [role="button"], [role="link"], [role="menuitem"], input',
    )
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
        .slice(0, 180)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: (element.innerText || element.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 180),
          ariaLabel: element.getAttribute("aria-label"),
          title: element.getAttribute("title"),
          href: element.getAttribute("href"),
          type: element.getAttribute("type"),
          accept: element.getAttribute("accept"),
        })),
    );
  console.log(`Этап ${label}: ${page.url()}`);
  console.log(JSON.stringify(controls, null, 2));
  console.log(`Снимок: ${screenshotPath}`);
}

async function openImportDialog(page, groupId) {
  const productsUrl =
    `https://vk.ru/club${groupId}?act=market_group_items`;
  let addProduct = null;
  let accessDenied = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(productsUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(4000);
    if (/login|auth/i.test(page.url())) {
      throw new Error("Docker Chromium не авторизован в VK");
    }
    const bodyText = await page.locator("body").innerText().catch(() => "");
    accessDenied = /Ошибка доступа|Access denied/i.test(bodyText);
    if (accessDenied) {
      console.error(
        `VK временно закрыл раздел импорта, попытка ${attempt}/3`,
      );
      if (attempt < 3) await page.waitForTimeout(attempt * 5000);
      continue;
    }
    addProduct = await waitForVisibleControl(
      page,
      "Добавить товар",
      {},
      15000,
    );
    if (addProduct) break;
    console.error(
      `VK не открыл раздел товаров, попытка ${attempt}/3: ${page.url()}`,
    );
    if (attempt < 3) {
      await page.waitForTimeout(attempt * 5000);
    }
  }
  if (!addProduct) {
    if (accessDenied) {
      const screenshotPath = path.join(
        dataDir,
        "vk_market_access_denied.png",
      );
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.error(`Снимок Access denied: ${screenshotPath}`);
    } else {
      await dumpPage(page, "market_page_unavailable");
    }
    throw new Error(
      accessDenied
        ? "VK вернул Access denied для административного раздела товаров"
        : "VK не открыл прямой раздел товаров после трёх попыток",
    );
  }
  await addProduct.click();
  await page.waitForTimeout(1000);

  const fromFile = await waitForVisibleControl(
    page,
    "Из файла",
    {},
    10000,
  );
  if (!fromFile) {
    await dumpPage(page, "add_product_menu");
    throw new Error("Не найден пункт «Из файла»");
  }
  await fromFile.click();
  await page.waitForTimeout(2500);
}

async function main() {
  const { values } = parseArgs({
    options: {
      inspect: { type: "boolean", default: false },
      upload: { type: "boolean", default: false },
      file: { type: "string" },
      yes: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
  });
  const modeCount = [values.inspect, values.upload].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error("Укажите один режим: --inspect или --upload");
  }
  if (values.upload && !values.file) {
    throw new Error("Для --upload укажите --file");
  }

  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 60000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Docker Chromium не вернул профиль");
  const page = await context.newPage();
  let keepPageOpen = false;
  try {
    try {
      await openImportDialog(page, readGroupId());
    } catch (error) {
      error.exitCode = 75;
      throw error;
    }
    if (values.inspect) {
      await dumpPage(page, "import_dialog");
      return;
    }
    if (values.upload) {
      const inputPath = path.resolve(
        path.isAbsolute(values.file)
          ? values.file
          : path.join(dataDir, values.file),
      );
      if (!fs.existsSync(inputPath)) {
        throw new Error(`Файл импорта не найден: ${inputPath}`);
      }
      if (!/\.(?:yml|xml|csv|xlsx)$/i.test(inputPath)) {
        throw new Error("VK принимает только YML, XML, CSV или XLSX");
      }

      const fileData = fs.readFileSync(inputPath);
      const sha256 = crypto.createHash("sha256").update(fileData).digest("hex");
      const statePath = path.join(dataDir, "vk_market_import_state.json");
      const state = fs.existsSync(statePath)
        ? JSON.parse(fs.readFileSync(statePath, "utf8"))
        : {};
      const groupId = readGroupId();
      if (
        !values.force &&
        state.group_id === groupId &&
        state.sha256 === sha256 &&
        ["submitted", "uploading_in_browser"].includes(state.status)
      ) {
        throw new Error(
          "Этот файл уже был отправлен в VK. Для осознанного повтора добавьте --force",
        );
      }

      const fileInput = await findVisibleFileInput(page);
      if (!fileInput) {
        await dumpPage(page, "file_input_missing");
        throw new Error("В форме VK не найдено поле загрузки файла");
      }
      const extension = path.extname(inputPath).toLowerCase();
      const mimeType =
        extension === ".xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : extension === ".csv"
            ? "text/csv"
            : extension === ".yml"
              ? "application/x-yaml"
              : "text/xml";
      console.log(
        `Поле файла: accept=${
          (await fileInput.getAttribute("accept")) || "не задан"
        }, имя=${path.basename(inputPath)}, mime=${mimeType}`,
      );
      await fileInput.setInputFiles({
        name: path.basename(inputPath),
        mimeType,
        buffer: fileData,
      });
      await page.waitForTimeout(3000);

      const submit = await waitForVisibleControl(
        page,
        "Добавить товары",
        { exact: true },
        15000,
      );
      if (!submit || !(await submit.isEnabled().catch(() => false))) {
        await dumpPage(page, "file_rejected");
        throw new Error("VK не принял файл или не активировал кнопку импорта");
      }
      const readyScreenshot = path.join(
        dataDir,
        "vk_market_upload_ready.png",
      );
      await page.screenshot({ path: readyScreenshot, fullPage: false });
      if (!values.yes) {
        console.log(`Файл принят формой VK: ${inputPath}`);
        console.log(`Проверка: ${readyScreenshot}`);
        console.log("Для запуска импорта добавьте --yes.");
        return;
      }

      const runId = crypto.randomUUID();
      await page.evaluate((id) => {
        window.name = `vk-market-import-${id}`;
      }, runId);
      await submit.click();
      keepPageOpen = true;
      fs.writeFileSync(
        statePath,
        `${JSON.stringify(
          {
            version: 1,
            group_id: groupId,
            file: path.basename(inputPath),
            bytes: fileData.length,
            sha256,
            run_id: runId,
            submitted_at: new Date().toISOString(),
            status: "uploading_in_browser",
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await page.waitForTimeout(6000);
      const resultScreenshot = path.join(
        dataDir,
        "vk_market_upload_submitted.png",
      );
      await page.screenshot({ path: resultScreenshot, fullPage: false });
      const notices = await page
        .locator('[role="alert"], [role="status"], [class*="Snackbar"]')
        .allInnerTexts()
        .catch(() => []);
      console.log(`Импорт запущен в сообществе ${groupId}.`);
      if (notices.length) {
        console.log(
          `Сообщение VK: ${notices.join(" | ").replace(/\s+/g, " ").trim()}`,
        );
      }
      console.log(`Состояние: ${statePath}`);
      console.log(`Снимок: ${resultScreenshot}`);
      console.log(
        "Вкладка оставлена открытой в Docker Chromium. " +
          "Не останавливайте контейнер chromium до уведомления VK.",
      );
      return;
    }
  } finally {
    if (!keepPageOpen) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = error.exitCode || 1;
});
