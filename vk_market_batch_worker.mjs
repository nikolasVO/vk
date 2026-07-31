import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.VK_DATA_DIR || projectDir);
const cdpUrl =
  process.env.BROWSER_CDP_URL?.trim() || "http://127.0.0.1:9222";
const statePath = path.join(dataDir, "vk_market_import_state.json");
const skippedPath = path.join(
  dataDir,
  "vk_market_skipped_batches.jsonl",
);

function positiveInteger(value, name, { allowZero = false } = {}) {
  const number = Number.parseInt(value, 10);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(number) || number < minimum) {
    throw new Error(`${name} должен быть целым числом не меньше ${minimum}`);
  }
  return number;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: "/app",
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Команда завершилась с кодом ${result.status}: ${command} ${args.join(" ")}`,
    );
  }
}

function readState() {
  if (!fs.existsSync(statePath)) return {};
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function updateState(values) {
  const state = { ...readState(), ...values };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function recordSkippedBatch({
  file,
  report,
  offset,
  size,
  attempts,
  reason,
  result = null,
}) {
  const record = {
    skipped_at: new Date().toISOString(),
    file,
    report,
    offset,
    size,
    attempts,
    reason,
    result,
  };
  fs.appendFileSync(skippedPath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.error(`Партия записана для разбора: ${skippedPath}`);
}

function countOffers(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return (text.match(/<offer\b/g) || []).length;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function inspectPage(page) {
  const body = (await page.locator("body").innerText().catch(() => ""))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ");

  const progressMatches = [
    ...body.matchAll(/Добавлено\s+(\d+)\s+из\s+(\d+)\s+товар/gi),
  ];
  if (progressMatches.length) {
    const match = progressMatches.at(-1);
    const imported = Number(match[1]);
    const total = Number(match[2]);
    return {
      status: imported >= total ? "completed" : "running",
      imported,
      total,
      message: `Добавлено ${imported} из ${total}`,
    };
  }

  const queuedMatches = [
    ...body.matchAll(/(\d+)\s+товар\w*\s+добавятся через несколько минут/gi),
  ];
  if (queuedMatches.length) {
    const total = Number(queuedMatches.at(-1)[1]);
    return {
      status: "running",
      imported: 0,
      total,
      message: `${total} товаров поставлены в очередь`,
    };
  }

  if (
    /Добавление товаров/i.test(body) &&
    /(Загруженный файл|Загружается)/i.test(body)
  ) {
    return { status: "running", message: "Файл загружается" };
  }

  if (/В файле нет товаров/i.test(body)) {
    return {
      status: "completed",
      imported: 0,
      total: 0,
      message: "В файле нет новых товаров; существующие ID пропущены",
    };
  }

  if (/Не удалось загрузить файл/i.test(body)) {
    return { status: "failed", message: "VK не удалось загрузить файл" };
  }

  const partialMatches = [
    ...body.matchAll(
      /Не удалось добавить\s+(\d+)\s+из\s+(\d+)\s+товар/gi,
    ),
  ];
  if (partialMatches.length) {
    const match = partialMatches.at(-1);
    const failed = Number(match[1]);
    const total = Number(match[2]);
    return {
      status: "partial",
      imported: total - failed,
      failed,
      total,
      message: `Добавлено ${total - failed} из ${total}; ошибок: ${failed}`,
    };
  }

  const completedMatches = [
    ...body.matchAll(
      /(\d+)\s+из\s+(\d+)\s+товар[\s\S]{0,80}?импортирован/gi,
    ),
  ];
  if (completedMatches.length) {
    const match = completedMatches.at(-1);
    return {
      status: "completed",
      imported: Number(match[1]),
      total: Number(match[2]),
      message: `${match[1]} из ${match[2]} импортировано`,
    };
  }

  return { status: "unknown", message: "Статус VK пока не определён" };
}

async function findImportPage(context, runId, allowAnyRunning) {
  const candidates = context
    .pages()
    .filter((page) => page.url().includes("act=market_group_items"));

  if (runId) {
    for (const page of candidates) {
      const name = await page.evaluate(() => window.name).catch(() => "");
      if (name === `vk-market-import-${runId}`) return page;
    }
  }

  if (allowAnyRunning) {
    for (const page of candidates) {
      const status = await inspectPage(page);
      if (status.status === "running") return page;
    }
  }
  return null;
}

async function waitForImport({
  runId,
  allowAnyRunning = false,
  expectedTotal = 0,
  pollSeconds,
  timeoutHours,
  stallMinutes,
}) {
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 60000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Docker Chromium не вернул профиль");
  const deadline = Date.now() + timeoutHours * 60 * 60 * 1000;
  const terminalGraceDeadline = Date.now() + 45_000;
  let lastMessage = "";
  let missingChecks = 0;
  let lastProgressAt = Date.now();
  let lastProgressKey = "";
  try {
    while (Date.now() < deadline) {
      const page = await findImportPage(context, runId, allowAnyRunning);
      if (!page) {
        missingChecks += 1;
        if (missingChecks >= 5) {
          return {
            status: "failed",
            message: "Вкладка импорта исчезла из Chromium",
          };
        }
      } else {
        missingChecks = 0;
        const result = await inspectPage(page);
        const terminal = ["completed", "partial", "failed"].includes(
          result.status,
        );
        const staleTotal =
          expectedTotal > 0 &&
          Number.isInteger(result.total) &&
          result.total > expectedTotal;
        if (
          terminal &&
          (Date.now() < terminalGraceDeadline || staleTotal)
        ) {
          const waitingMessage = staleTotal
            ? `Игнорируется старый результат ${result.total}; ` +
              `текущая партия: ${expectedTotal}`
            : "Ожидается результат текущей партии";
          if (waitingMessage !== lastMessage) {
            console.log(`[VK] ${waitingMessage}`);
            lastMessage = waitingMessage;
          }
          await sleep(pollSeconds * 1000);
          continue;
        }
        const progressKey = [
          result.status,
          result.imported ?? "",
          result.total ?? "",
          result.message,
        ].join(":");
        if (result.status === "running" && progressKey !== lastProgressKey) {
          lastProgressKey = progressKey;
          lastProgressAt = Date.now();
        }
        if (
          !terminal &&
          Date.now() - lastProgressAt >= stallMinutes * 60 * 1000
        ) {
          const screenshotPath = path.join(
            dataDir,
            "vk_market_batch_stalled.png",
          );
          await page
            .screenshot({ path: screenshotPath, fullPage: false })
            .catch(() => {});
          await page.close().catch(() => {});
          return {
            status: "failed",
            message:
              `Нет прогресса импорта ${stallMinutes} мин.; ` +
              "зависшая партия пропущена",
          };
        }
        if (result.message !== lastMessage) {
          console.log(`[VK] ${result.message}`);
          lastMessage = result.message;
        }
        if (["completed", "partial", "failed"].includes(result.status)) {
          const screenshotPath = path.join(
            dataDir,
            `vk_market_batch_${result.status}.png`,
          );
          await page
            .screenshot({ path: screenshotPath, fullPage: false })
            .catch(() => {});
          await page.close().catch(() => {});
          return result;
        }
      }
      await sleep(pollSeconds * 1000);
    }
    return {
      status: "failed",
      message: `Превышено время ожидания ${timeoutHours} ч.`,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function waitForAllCurrentImports({
  pollSeconds,
  timeoutHours,
  stallMinutes,
}) {
  while (true) {
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 60000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Docker Chromium не вернул профиль");
    let runningCount = 0;
    try {
      for (const page of context
        .pages()
        .filter((item) => item.url().includes("act=market_group_items"))) {
        const result = await inspectPage(page);
        if (result.status === "running") runningCount += 1;
      }
    } finally {
      await browser.close().catch(() => {});
    }
    if (runningCount === 0) return;
    console.log(`Активных импортов в Chromium: ${runningCount}.`);
    const current = await waitForImport({
      allowAnyRunning: true,
      pollSeconds,
      timeoutHours,
      stallMinutes,
    });
    if (current.status !== "completed") {
      throw new Error(`Текущая партия не завершена: ${current.message}`);
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "batch-size": { type: "string", default: "100" },
      "start-offset": { type: "string", default: "0" },
      "total-limit": { type: "string", default: "0" },
      "poll-seconds": { type: "string", default: "30" },
      "timeout-hours": { type: "string", default: "12" },
      "stall-minutes": { type: "string", default: "20" },
      retries: { type: "string", default: "3" },
      "wait-current": { type: "string", default: "0" },
      "only-ids": { type: "string", default: "" },
      "include-existing": { type: "string", default: "0" },
      "file-prefix": { type: "string", default: "vk_market" },
    },
  });
  const batchSize = positiveInteger(values["batch-size"], "--batch-size");
  const startOffset = positiveInteger(
    values["start-offset"],
    "--start-offset",
    { allowZero: true },
  );
  const totalLimit = positiveInteger(
    values["total-limit"],
    "--total-limit",
    { allowZero: true },
  );
  const pollSeconds = positiveInteger(
    values["poll-seconds"],
    "--poll-seconds",
  );
  const timeoutHours = positiveInteger(
    values["timeout-hours"],
    "--timeout-hours",
  );
  const stallMinutes = positiveInteger(
    values["stall-minutes"],
    "--stall-minutes",
  );
  const retries = positiveInteger(values.retries, "--retries");
  const onlyIds = values["only-ids"].trim();
  const filePrefix = values["file-prefix"].trim();

  if (!/^[A-Za-z0-9_.-]+$/.test(filePrefix)) {
    throw new Error(
      "--file-prefix может содержать только буквы, цифры, точку, _ и -",
    );
  }
  if (!['0', '1'].includes(values["include-existing"])) {
    throw new Error("--include-existing должен быть 0 или 1");
  }
  const feedOptions = [];
  if (onlyIds) feedOptions.push("--only-ids", onlyIds);
  if (values["include-existing"] === "1") {
    feedOptions.push("--include-existing");
  }

  if (!["0", "1"].includes(values["wait-current"])) {
    throw new Error("--wait-current должен быть 0 или 1");
  }
  if (values["wait-current"] === "1") {
    console.log("Ожидается завершение уже запущенных партий...");
    await waitForAllCurrentImports({
      pollSeconds,
      timeoutHours,
      stallMinutes,
    });
  }

  const fullFeedName = `${filePrefix}_products.yml`;
  const fullReportName = `${filePrefix}_validation.csv`;
  const fullFeedPath = path.join(dataDir, fullFeedName);
  const fullArgs = [
    "/app/vk_market_feed.py",
    "--output",
    fullFeedName,
    "--report",
    fullReportName,
    ...feedOptions,
  ];
  if (totalLimit) fullArgs.push("--limit", String(totalLimit));
  run("python3", fullArgs);
  const total = countOffers(fullFeedPath);
  if (startOffset >= total) {
    console.log(`Все ${total} подготовленных товаров уже обработаны.`);
    return;
  }

  console.log(
    `Фоновая очередь: ${total - startOffset} товаров, ` +
      `партии по ${batchSize}, начальное смещение ${startOffset}.`,
  );
  for (let offset = startOffset; offset < total; offset += batchSize) {
    const currentSize = Math.min(batchSize, total - offset);
    const batchNumber = Math.floor(offset / batchSize) + 1;
    const totalBatches = Math.ceil(total / batchSize);
    const fileName =
      `${filePrefix}_batch_${String(offset).padStart(5, "0")}.yml`;
    const reportName =
      `${filePrefix}_batch_${String(offset).padStart(5, "0")}.csv`;
    console.log(
      `\n[Партия ${batchNumber}/${totalBatches}] ` +
        `${currentSize} товаров, смещение ${offset}`,
    );
    run("python3", [
      "/app/vk_market_feed.py",
      "--offset",
      String(offset),
      "--limit",
      String(currentSize),
      "--output",
      fileName,
      "--report",
      reportName,
      ...feedOptions,
    ]);

    let completed = false;
    let attempt = 0;
    let failureStreak = 0;
    while (!completed) {
      attempt += 1;
      console.log(`Отправка в VK, попытка ${attempt}...`);
      const importArgs = [
        "/app/vk_market_import.mjs",
        "--upload",
        "--file",
        fileName,
        "--yes",
      ];
      if (attempt > 1) importArgs.push("--force");
      try {
        run("node", importArgs);
      } catch (error) {
        failureStreak += 1;
        if (failureStreak >= retries) {
          recordSkippedBatch({
            file: fileName,
            report: reportName,
            offset,
            size: currentSize,
            attempts: attempt,
            reason: `не удалось открыть импорт: ${error.message}`,
          });
          completed = true;
          break;
        }
        const delay = Math.min(30 * 2 ** (failureStreak - 1), 300);
        console.error(
          `Не удалось открыть импорт: ${error.message}. ` +
            `Новая попытка через ${delay} сек.`,
        );
        await sleep(delay * 1000);
        continue;
      }
      const state = readState();
      const result = await waitForImport({
        runId: state.run_id,
        expectedTotal: currentSize,
        pollSeconds,
        timeoutHours,
        stallMinutes,
      });
      updateState({
        status: result.status,
        finished_at: new Date().toISOString(),
        result,
      });
      if (result.status === "completed") {
        completed = true;
        break;
      }
      if (result.status === "partial") {
        console.error(
          `VK отклонил ${result.failed} из ${result.total}. ` +
            "Проблемные товары оставлены для последующего разбора.",
        );
        recordSkippedBatch({
          file: fileName,
          report: reportName,
          offset,
          size: currentSize,
          attempts: attempt,
          reason: `VK отклонил ${result.failed} из ${result.total}`,
          result,
        });
        completed = true;
        break;
      }
      console.error(`Партия не принята: ${result.message}`);
      failureStreak += 1;
      if (failureStreak >= retries) {
        recordSkippedBatch({
          file: fileName,
          report: reportName,
          offset,
          size: currentSize,
          attempts: attempt,
          reason: result.message,
          result,
        });
        completed = true;
        break;
      }
      const delay = Math.min(30 * 2 ** (failureStreak - 1), 300);
      console.error(
        `Временная ошибка VK. Повтор этой же партии через ${delay} сек.`,
      );
      await sleep(delay * 1000);
    }
  }
  console.log(`Готово: все ${total - startOffset} товаров отправлены партиями.`);
}

main().catch((error) => {
  console.error(`ОШИБКА WORKER: ${error.stack || error.message}`);
  process.exitCode = 1;
});
