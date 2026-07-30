#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"

if [[ ! -d node_modules/playwright-core ]]; then
  echo "Устанавливаю компоненты загрузчика..."
  npm install
fi

node vk_browser_publisher.mjs \
  --publish \
  --yes \
  --limit 10 \
  --interval "${VK_PUBLISH_INTERVAL:-60}"

echo
echo "Готово. Нажмите Enter, чтобы закрыть окно."
read
