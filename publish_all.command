#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"

if [[ ! -d node_modules/playwright-core ]]; then
  echo "Устанавливаю компоненты загрузчика..."
  npm install
fi

echo "Публикация товаров из res.xlsx запущена."
echo "Повторный запуск продолжит с первой ещё не опубликованной строки."
echo "Для остановки нажмите Ctrl+C."
echo

node vk_browser_publisher.mjs \
  --publish \
  --yes \
  --all \
  --interval "${VK_PUBLISH_INTERVAL:-60}"

echo
echo "Работа завершена. Нажмите Enter, чтобы закрыть окно."
read
