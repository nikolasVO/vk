import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.VK_DATA_DIR || projectDir);

function readGroupId() {
  const text = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  const match = text.match(
    /^\s*VK_GROUP_ID\s*=\s*["']?(\d+)["']?\s*$/m,
  );
  if (!match) throw new Error("VK_GROUP_ID не найден");
  return match[1];
}

function normalize(value) {
  return (value || "")
    .normalize("NFKC")
    .replace(/[\p{C}\p{Z}\s]+/gu, "")
    .toLowerCase();
}

async function findVisibleControl(page, expected) {
  const controls = page.locator(
    'button, [role="button"], [role="menuitem"], a',
  );
  const wanted = normalize(expected);
  const index = await controls.evaluateAll((elements, text) => {
    const compact = (value) =>
      (value || "")
        .normalize("NFKC")
        .replace(/[\p{C}\p{Z}\s]+/gu, "")
        .toLowerCase();
    return elements.findIndex((element) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const values = [
        element.innerText,
        element.textContent,
        element.getAttribute("aria-label"),
      ]
        .filter(Boolean)
        .map(compact);
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        box.width > 0 &&
        box.height > 0 &&
        values.some((value) => value === text)
      );
    });
  }, wanted);
  return index >= 0 ? controls.nth(index) : null;
}

async function deletePost(
  page,
  groupId,
  postId,
  shouldDelete,
  useNewestPost,
) {
  await page.goto(`https://vk.ru/club${groupId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(6000);

  let actions = null;
  const actionDeadline = Date.now() + 30000;
  while (!actions && Date.now() < actionDeadline) {
    const postLink = page
      .locator(`a[href*="wall-${groupId}_${postId}"]`)
      .last();
    if ((await postLink.count()) === 0) {
      if (useNewestPost) {
        const newestActions = page
          .locator('[data-testid="post_context_menu_toggle"]')
          .first();
        if ((await newestActions.count()) > 0) {
          await newestActions.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(500);
          if (await newestActions.isVisible().catch(() => false)) {
            actions = newestActions;
            console.log(
              `VK скрыл permalink wall-${groupId}_${postId}; используется верхняя запись в ленте.`,
            );
            break;
          }
        }
      }
      await page.evaluate(() => window.scrollBy(0, 500));
      await page.waitForTimeout(500);
      continue;
    }
    await postLink.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
    if (!(await postLink.isVisible().catch(() => false))) continue;
    const postRoot = postLink.locator(
      'xpath=ancestor::*[.//*[@data-testid="post_context_menu_toggle"]][1]',
    );
    const testIdAction = postRoot
      .locator('[data-testid="post_context_menu_toggle"]')
      .first();
    if (await testIdAction.isVisible().catch(() => false)) {
      actions = testIdAction;
      break;
    }
    if (!actions) await page.waitForTimeout(500);
  }
  if (!actions) {
    const screenshotPath = path.join(
      dataDir,
      `vk_post_${postId}_delete_failed.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: false });
    const controls = await page
      .locator('button, [role="button"], [aria-label]')
      .evaluateAll((elements) =>
        elements
          .filter((element) => {
            const style = window.getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return (
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              box.width > 0 &&
              box.height > 0 &&
              box.top < 260
            );
          })
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            text: (element.innerText || element.textContent || "")
              .replace(/\s+/g, " ")
              .trim(),
            aria: element.getAttribute("aria-label"),
            title: element.getAttribute("title"),
            testId: element.getAttribute("data-testid"),
            className:
              typeof element.className === "string"
                ? element.className.slice(0, 180)
                : "",
            x: Math.round(element.getBoundingClientRect().x),
            y: Math.round(element.getBoundingClientRect().y),
            width: Math.round(element.getBoundingClientRect().width),
            height: Math.round(element.getBoundingClientRect().height),
          })),
      );
    console.log(`Кнопки страницы: ${JSON.stringify(controls, null, 2)}`);
    throw new Error(
      `У wall-${groupId}_${postId} не найдена кнопка действий; снимок ${screenshotPath}`,
    );
  }
  await actions.click();
  await page.waitForTimeout(1000);

  const deleteControl =
    (await findVisibleControl(page, "Удалить запись")) ||
    (await findVisibleControl(page, "Удалить пост")) ||
    (await findVisibleControl(page, "Удалить"));
  if (!deleteControl) {
    const screenshotPath = path.join(
      dataDir,
      `vk_post_${postId}_menu.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: false });
    const menuText = await page
      .locator('[role="menu"], [role="menuitem"], [data-testid*="menu"]')
      .allInnerTexts()
      .catch(() => []);
    console.log(`Текст меню: ${JSON.stringify(menuText)}`);
    throw new Error(
      `В меню wall-${groupId}_${postId} не найден пункт удаления; снимок ${screenshotPath}`,
    );
  }
  if (!shouldDelete) {
    console.log(
      `Запись wall-${groupId}_${postId} найдена и доступна для удаления.`,
    );
    return false;
  }

  await deleteControl.click();
  await page.waitForTimeout(1200);
  const confirm = await findVisibleControl(page, "Удалить");
  if (confirm) {
    await confirm.click();
    await page.waitForTimeout(1200);
  }
  console.log(`Запись wall-${groupId}_${postId} удалена.`);
  return true;
}

function markDeleted(groupId, postIds) {
  const statePath = path.join(dataDir, "browser_publish_state.json");
  if (!fs.existsSync(statePath)) return;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const published = state.published || {};
  const wanted = new Set(postIds.map(Number));
  for (const [key, value] of Object.entries(published)) {
    if (
      key.startsWith(`group:${groupId}:`) &&
      wanted.has(Number(value?.post_id))
    ) {
      value.deleted_at = new Date().toISOString();
    }
  }
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      "post-ids": { type: "string" },
      delete: { type: "boolean", default: false },
      newest: { type: "boolean", default: false },
    },
  });
  const postIds = (values["post-ids"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!postIds.length || postIds.some((value) => !/^\d+$/.test(value))) {
    throw new Error("Укажите --post-ids 233,234,235");
  }

  const groupId = readGroupId();
  const browser = await chromium.connectOverCDP(
    process.env.BROWSER_CDP_URL || "http://127.0.0.1:9222",
    { timeout: 60000 },
  );
  const context = browser.contexts()[0];
  if (!context) throw new Error("Docker Chromium не вернул профиль");
  const page = await context.newPage();
  try {
    const orderedPostIds = values.newest
      ? [...postIds].sort((left, right) => Number(right) - Number(left))
      : postIds;
    for (const postId of orderedPostIds) {
      await deletePost(
        page,
        groupId,
        postId,
        values.delete,
        values.newest,
      );
    }
    if (values.delete) markDeleted(groupId, postIds);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = 1;
});
