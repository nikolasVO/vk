#!/bin/sh
set -eu

limit="${1:-}"

case "$limit" in
  "")
    ;;
  *[!0-9]*)
    echo "Использование: ./import_market.sh [количество_товаров]" >&2
    exit 2
    ;;
esac

if docker compose --profile market ps --status running --services |
  grep -qx "market-import"; then
  echo "Пакетный импорт уже работает."
  echo "Прогресс: docker compose --profile market logs -f market-import"
  exit 0
fi

docker compose build publisher
docker compose up -d chromium

docker compose run --rm --entrypoint node publisher \
  /app/vk_market_existing.mjs

VK_MARKET_TOTAL_LIMIT="${limit:-0}" \
  docker compose --profile market up -d --force-recreate market-import

echo "Пакетный импорт запущен в фоне партиями по 100 товаров."
echo "Не выполняйте 'docker compose stop chromium' до уведомления VK."
echo "Прогресс: docker compose --profile market logs -f market-import"
