import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.VK_DATA_DIR || projectDir);
const profileDir = path.join(dataDir, ".vk-browser-profile");
const downloadsDir = path.join(dataDir, ".vk-browser-downloads");
const logsDir = path.join(dataDir, "vk-browser-logs");
const statePath = path.join(dataDir, "browser_publish_state.json");
const lockPath = path.join(dataDir, ".vk-browser-publisher.lock");
const chromePath =
  process.env.CHROME_EXECUTABLE_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

fs.mkdirSync(logsDir, { recursive: true });
const logDate = new Date().toISOString().slice(0, 10);
const logPath = path.join(logsDir, `publisher-${logDate}.log`);
const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);

function logLine(level, args) {
  const rendered = args
    .map((value) =>
      typeof value === "string"
        ? value
        : inspect(value, { depth: 5, breakLength: Infinity }),
    )
    .join(" ");
  fs.appendFileSync(
    logPath,
    `${new Date().toISOString()} ${level} ${rendered}\n`,
    "utf8",
  );
}

console.log = (...args) => {
  originalLog(...args);
  logLine("INFO", args);
};
console.error = (...args) => {
  originalError(...args);
  logLine("ERROR", args);
};

function readEnv() {
  const result = {};
  const envPath = path.join(dataDir, ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(`Не найден файл настроек: ${envPath}`);
  }
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      ["'", '"'].includes(value[0])
    ) {
      value = value.slice(1, -1);
    }
    result[line.slice(0, separator).trim()] = value;
  }
  return result;
}

function readState() {
  if (!fs.existsSync(statePath)) {
    return { version: 2, published: {}, failed: {} };
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (!state || typeof state.published !== "object") {
    throw new Error(`Некорректный файл состояния: ${statePath}`);
  }
  state.version = 2;
  state.failed =
    state.failed && typeof state.failed === "object" ? state.failed : {};
  return state;
}

function saveState(state) {
  const temporaryPath = `${statePath}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(state, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  fs.renameSync(temporaryPath, statePath);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireLock() {
  if (fs.existsSync(lockPath)) {
    let owner = {};
    try {
      owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      // Повреждённый lock считается устаревшим.
    }
    const startedAt = Date.parse(owner.started_at || "");
    const isRecentForeignLock =
      owner.hostname !== os.hostname() &&
      Number.isFinite(startedAt) &&
      Date.now() - startedAt < 24 * 60 * 60 * 1000;
    if (processIsAlive(Number(owner.pid)) || isRecentForeignLock) {
      throw new Error(
        `Загрузчик уже работает (PID ${owner.pid}, ` +
          `среда ${owner.hostname || "неизвестна"}). Второй запуск отменён.`,
      );
    }
    fs.unlinkSync(lockPath);
  }
  const descriptor = fs.openSync(lockPath, "wx", 0o600);
  fs.writeFileSync(
    descriptor,
    JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      started_at: new Date().toISOString(),
    }),
    "utf8",
  );
  fs.closeSync(descriptor);
}

function releaseLock() {
  if (!fs.existsSync(lockPath)) return;
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (Number(owner.pid) === process.pid) fs.unlinkSync(lockPath);
  } catch {
    // Не удаляем lock, если нельзя доказать, что он принадлежит этому процессу.
  }
}

function loadProducts({ startRow, maxPhotos }) {
  const output = execFileSync(
    "python3",
    [
      path.join(projectDir, "vk_browser_data.py"),
      "--xlsx",
      path.join(dataDir, "res.xlsx"),
      "--start-row",
      String(startRow),
      "--limit",
      "0",
      "--max-photos",
      String(maxPhotos),
    ],
    {
      cwd: projectDir,
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
    },
  );
  return JSON.parse(output);
}

function safeRecordDirectory(recordId) {
  const safe = recordId.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 100);
  return path.join(downloadsDir, safe);
}

function extensionFor(contentType, url) {
  const type = (contentType || "").split(";", 1)[0].toLowerCase();
  if (type === "image/png") return ".png";
  if (type === "image/gif") return ".gif";
  if (type === "image/webp") return ".webp";
  if (type === "image/jpeg") return ".jpg";
  const fromUrl = path.extname(new URL(url).pathname).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(fromUrl)
    ? fromUrl
    : ".jpg";
}

async function downloadImages(product) {
  const productDir = safeRecordDirectory(product.record_id);
  fs.mkdirSync(productDir, { recursive: true });
  const paths = [];
  for (let index = 0; index < product.image_urls.length; index += 1) {
    const url = product.image_urls[index];
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "image/*",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/124 Safari/537.36",
        },
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type") || "";
      if (contentType && !contentType.toLowerCase().startsWith("image/")) {
        throw new Error(`сервер вернул ${contentType}`);
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length === 0 || data.length > 20 * 1024 * 1024) {
        throw new Error(`недопустимый размер ${data.length}`);
      }
      const extension = extensionFor(contentType, url);
      const filePath = path.join(
        productDir,
        `photo_${String(index + 1).padStart(2, "0")}${extension}`,
      );
      fs.writeFileSync(filePath, data);
      paths.push(filePath);
    } catch (error) {
      console.error(`Фото ${index + 1} пропущено: ${error.message}`);
    }
  }
  if (paths.length === 0) {
    throw new Error("Не удалось скачать ни одной фотографии");
  }
  return paths;
}

function cleanupImages(product) {
  const productDir = safeRecordDirectory(product.record_id);
  if (productDir.startsWith(`${downloadsDir}${path.sep}`)) {
    fs.rmSync(productDir, { recursive: true, force: true });
  }
}

async function openComposer(page, groupId) {
  await page.goto(`https://vk.ru/club${groupId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(4000);
  if (/login|auth/i.test(page.url())) {
    throw new Error(
      "Профиль VK не авторизован. Войдите через веб-интерфейс Chromium",
    );
  }
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  const postMenuItem = page.getByText("Пост", { exact: true });
  await postMenuItem.waitFor({ state: "visible", timeout: 15000 });
  await postMenuItem.click();
  const loadingDialog = page.getByRole("dialog", { name: "Форма постинга" });
  await loadingDialog.waitFor({ state: "visible", timeout: 30000 });
  const textBox = page.getByTestId("posting_base_screen_input_message");
  await textBox.waitFor({ state: "visible", timeout: 30000 });
  const dialog = page.getByTestId("posting_modal_box");
  if (!(await dialog.isVisible())) {
    throw new Error("Окно создания поста не появилось");
  }
  return dialog;
}

async function fillComposer(dialog, product, imagePaths) {
  const page = dialog.page();
  const textBox = page.getByTestId("posting_base_screen_input_message");
  const removePhotoButtons = page.getByTestId(
    "posting_attachment_photo_item_remove",
  );
  for (let attempts = 0; attempts < 12; attempts += 1) {
    if ((await removePhotoButtons.count()) === 0) break;
    await removePhotoButtons.first().click();
    await page.waitForTimeout(500);
  }
  if ((await removePhotoButtons.count()) !== 0) {
    throw new Error("Не удалось очистить фотографии из черновика");
  }

  await textBox.fill(product.message);
  const fileInput = page.getByTestId(
    "posting_base_screen_download_from_device",
  );
  await fileInput.setInputFiles(imagePaths);
  const nextButton = page.getByTestId("posting_base_screen_next");
  await nextButton.waitFor({ state: "visible", timeout: 30000 });

  const uploadDeadline = Date.now() + 90000;
  while (
    (await removePhotoButtons.count()) !== imagePaths.length &&
    Date.now() < uploadDeadline
  ) {
    await page.waitForTimeout(1000);
  }
  const uploadedPhotoCount = await removePhotoButtons.count();
  if (uploadedPhotoCount !== imagePaths.length) {
    throw new Error(
      `Загружено фото ${uploadedPhotoCount}, ожидалось ${imagePaths.length}`,
    );
  }
  if (!(await nextButton.isEnabled())) {
    throw new Error("Кнопка «Далее» недоступна после загрузки фото");
  }
  await nextButton.click();
}

async function publishPreparedDialog(page) {
  const publishButton = page
    .getByRole("button", { name: /^(Опубликовать|Разместить)$/ })
    .last();
  await publishButton.waitFor({ state: "visible", timeout: 30000 });
  await publishButton.click();
  await page
    .getByTestId("posting_modal_box")
    .waitFor({ state: "hidden", timeout: 60000 });
}

async function logDialogSummary(dialog) {
  const [text, buttons] = await Promise.all([
    dialog.innerText(),
    dialog.locator("button").allTextContents(),
  ]);
  console.log("Текст финального окна:");
  console.log(text.replace(/\n{3,}/g, "\n\n").slice(0, 4000));
  console.log("Кнопки:", buttons.map((item) => item.trim()).filter(Boolean));
}

function getWallItems(_env, groupId, count = 20) {
  const output = execFileSync(
    "python3",
    [
      path.join(projectDir, "vk_browser_wall.py"),
      "--group-id",
      String(groupId),
      "--count",
      String(count),
    ],
    {
      cwd: projectDir,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60000,
    },
  );
  const wall = JSON.parse(output);
  if (!Array.isArray(wall.items)) {
    throw new Error("VK API вернул ответ без списка постов");
  }
  return wall.items;
}

function normalizePostText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}

function matchingPost(items, pending) {
  const expectedText = normalizePostText(pending.message);
  const preparedAt = Math.floor(Date.parse(pending.prepared_at) / 1000);
  return items.find((post) => {
    if (Number.isFinite(preparedAt) && post.date < preparedAt - 30) {
      return false;
    }
    if (normalizePostText(post.text) !== expectedText) return false;
    const photoCount = Array.isArray(post.attachments)
      ? post.attachments.filter((attachment) => attachment.type === "photo")
          .length
      : 0;
    return photoCount === pending.image_count;
  });
}

function stateKeyForProduct(statePrefix, product) {
  return `${statePrefix}row:${product.row_number}:${product.record_id}`;
}

function productWasPublished(state, statePrefix, product) {
  if (state.published[stateKeyForProduct(statePrefix, product)]) return true;

  // Совместимость с первыми тестовыми запусками, когда ключ состоял только
  // из артикула. Номер строки позволяет публиковать повторяющиеся товары.
  const legacyEntry = state.published[`${statePrefix}${product.record_id}`];
  return Boolean(legacyEntry && legacyEntry.row === product.row_number);
}

async function verifyPending(env, groupId, pending, attempts = 6) {
  let lastItems = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastItems = await getWallItems(env, groupId);
    const post = matchingPost(lastItems, pending);
    if (post) return post;
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  return null;
}

function finalizePublished(state, pending, post = null) {
  state.published[pending.state_key] = {
    row: pending.row,
    article: pending.article,
    published_at: new Date().toISOString(),
    method: "browser",
    ...(post?.id ? { post_id: post.id } : {}),
  };
  delete state.failed[pending.state_key];
  delete state.pending;
  saveState(state);
}

async function reconcilePending(env, groupId, state) {
  if (!state.pending) return;
  const pending = state.pending;
  console.log(
    `Проверяю незавершённую публикацию: строка ${pending.row}, ${pending.record_id}`,
  );
  const post = await verifyPending(env, groupId, pending);
  if (post) {
    finalizePublished(state, pending, post);
    console.log(`Пост уже присутствует на стене (ID ${post.id}); журнал восстановлен.`);
    return;
  }
  delete state.pending;
  saveState(state);
  console.log(
    "Незавершённый пост на стене не найден; строка будет отправлена заново.",
  );
}

async function recoverAfterError(env, groupId, state, stateKey) {
  if (!state.pending || state.pending.state_key !== stateKey) return false;
  const pending = state.pending;
  let post;
  try {
    post = await verifyPending(env, groupId, pending);
  } catch (error) {
    throw new Error(
      `Не удалось определить результат на стене (${error.message}). ` +
        "Работа остановлена, чтобы не создать дубликат.",
    );
  }
  if (post) {
    finalizePublished(state, pending, post);
    console.log(`Публикация подтверждена на стене (ID ${post.id}).`);
    return true;
  }
  delete state.pending;
  saveState(state);
  return false;
}

async function processProduct({
  page,
  env,
  groupId,
  state,
  statePrefix,
  product,
  publish,
  retries,
}) {
  const stateKey = stateKeyForProduct(statePrefix, product);
  let lastError;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      console.log(
        `Строка ${product.row_number}, ${product.record_id}` +
          (attempt > 1 ? ` — попытка ${attempt}/${retries + 1}` : ""),
      );
      const imagePaths = await downloadImages(product);
      console.log(`Скачано фото: ${imagePaths.length}`);
      const dialog = await openComposer(page, groupId);
      await fillComposer(dialog, product, imagePaths);

      if (!publish) {
        await logDialogSummary(dialog);
        await page.screenshot({
          path: path.join(dataDir, "vk_browser_probe.png"),
          fullPage: false,
        });
        console.log(
          "Пробный режим: публикации не было. Скриншот: vk_browser_probe.png",
        );
        return "preview";
      }

      state.pending = {
        state_key: stateKey,
        record_id: product.record_id,
        row: product.row_number,
        article: product.article,
        message: product.message,
        image_count: imagePaths.length,
        prepared_at: new Date().toISOString(),
      };
      saveState(state);

      await publishPreparedDialog(page);
      let post = null;
      try {
        post = await verifyPending(env, groupId, state.pending, 3);
      } catch (error) {
        console.error(
          `Предупреждение: пост размещён, но API-проверка недоступна: ${error.message}`,
        );
      }
      finalizePublished(state, state.pending, post);
      cleanupImages(product);
      console.log(
        post?.id
          ? `Опубликовано и проверено на стене (ID ${post.id}).`
          : "Опубликовано через браузер.",
      );
      return "published";
    } catch (error) {
      lastError = error;
      console.error(
        `Ошибка строки ${product.row_number}: ${error.message}`,
      );
      const recovered = await recoverAfterError(
        env,
        groupId,
        state,
        stateKey,
      );
      if (recovered) {
        cleanupImages(product);
        return "published";
      }
      if (attempt <= retries) {
        const delay = Math.min(15 * 2 ** (attempt - 1), 120);
        console.log(`Повтор через ${delay} сек.`);
        await page.waitForTimeout(delay * 1000);
      }
    }
  }

  state.failed[stateKey] = {
    row: product.row_number,
    article: product.article,
    failed_at: new Date().toISOString(),
    error: lastError?.message || "неизвестная ошибка",
  };
  saveState(state);
  cleanupImages(product);
  return "failed";
}

async function openAutomationSession(headless) {
  const cdpUrl = process.env.BROWSER_CDP_URL?.trim();
  if (cdpUrl) {
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 60000 });
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error(`Chromium по адресу ${cdpUrl} не вернул профиль`);
    }
    const page = await context.newPage();
    return {
      context,
      page,
      close: async () => {
        await page.close().catch(() => {});
        // Для connectOverCDP закрывается клиентское WebSocket-соединение.
        // Постоянный Chromium с профилем продолжает работать.
        await browser.close().catch(() => {});
      },
    };
  }

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless,
    viewport: { width: 1440, height: 1000 },
  });
  return {
    context,
    page: context.pages()[0] ?? (await context.newPage()),
    close: () => context.close(),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      publish: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      headless: { type: "boolean", default: false },
      limit: { type: "string" },
      interval: { type: "string", default: "60" },
      retries: { type: "string", default: "3" },
      "start-row": { type: "string", default: "2" },
      "max-photos": { type: "string", default: "10" },
      "stop-on-error": { type: "boolean", default: false },
    },
  });

  if (values.all && values.limit !== undefined) {
    throw new Error("Используйте либо --all, либо --limit N");
  }
  const limit =
    values.limit === undefined ? 1 : Number.parseInt(values.limit, 10);
  const intervalSeconds = Number.parseFloat(values.interval);
  const retries = Number.parseInt(values.retries, 10);
  const startRow = Number.parseInt(values["start-row"], 10);
  const maxPhotos = Number.parseInt(values["max-photos"], 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Некорректный --limit");
  }
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new Error("Некорректный --interval");
  }
  if (!Number.isInteger(retries) || retries < 0 || retries > 20) {
    throw new Error("Некорректный --retries (допустимо 0–20)");
  }
  if (!Number.isInteger(startRow) || startRow < 2) {
    throw new Error("Некорректный --start-row");
  }
  if (!Number.isInteger(maxPhotos) || maxPhotos < 1 || maxPhotos > 10) {
    throw new Error("Некорректный --max-photos (допустимо 1–10)");
  }
  if (values.publish && (values.all || limit > 1) && !values.yes) {
    throw new Error("Для нескольких записей добавьте --yes");
  }

  acquireLock();
  process.once("exit", releaseLock);

  const env = readEnv();
  const groupId = env.VK_GROUP_ID;
  if (!/^\d+$/.test(groupId ?? "")) {
    throw new Error("VK_GROUP_ID не указан в .env");
  }

  const state = readState();
  await reconcilePending(env, groupId, state);
  const statePrefix = `group:${groupId}:`;
  const allNewProducts = loadProducts({ startRow, maxPhotos }).filter(
    (product) => !productWasPublished(state, statePrefix, product),
  );
  const products = values.all
    ? allNewProducts
    : allNewProducts.slice(0, limit);

  if (products.length === 0) {
    console.log("Новых записей для браузерной публикации нет.");
    return;
  }

  console.log(
    `К отправке: ${products.length}. Интервал: ${intervalSeconds} сек. ` +
      `Журнал: ${logPath}`,
  );
  fs.mkdirSync(downloadsDir, { recursive: true });
  const session = await openAutomationSession(values.headless);
  const { page } = session;
  let successful = 0;
  let failed = 0;

  try {
    for (let index = 0; index < products.length; index += 1) {
      console.log(`[${index + 1}/${products.length}]`);
      const result = await processProduct({
        page,
        env,
        groupId,
        state,
        statePrefix,
        product: products[index],
        publish: values.publish,
        retries,
      });
      if (result === "preview") return;
      if (result === "published") successful += 1;
      if (result === "failed") {
        failed += 1;
        if (values["stop-on-error"]) {
          throw new Error("Остановка после первой неисправимой ошибки");
        }
      }

      if (
        index + 1 < products.length &&
        intervalSeconds > 0 &&
        result === "published"
      ) {
        console.log(`Пауза ${intervalSeconds} сек.`);
        await page.waitForTimeout(intervalSeconds * 1000);
      }
    }
  } finally {
    await session.close();
  }

  console.log(
    `Готово. Опубликовано: ${successful}; ошибок: ${failed}; ` +
      `всего в журнале: ${Object.keys(state.published).length}.`,
  );
  if (failed > 0) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(`ОШИБКА: ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    releaseLock();
  });
