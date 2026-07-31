#!/bin/sh
set -eu

if docker compose --profile market ps --status running --services |
  grep -qx "market-import"; then
  echo "Основной импорт ещё работает. Повтор пока не запущен."
  echo "Дождитесь строки 'Готово' и снова выполните: ./retry_market_errors.sh"
  exit 0
fi

docker compose build publisher
docker compose up -d chromium

docker compose run --rm --entrypoint python3 publisher \
  /app/vk_market_retry_ids.py

retry_stamp="$(date +%Y%m%d_%H%M%S)"
VK_MARKET_BATCH_SIZE="${VK_MARKET_RETRY_BATCH_SIZE:-10}" \
VK_MARKET_START_OFFSET=0 \
VK_MARKET_TOTAL_LIMIT=0 \
VK_MARKET_RETRIES="${VK_MARKET_RETRY_ATTEMPTS:-2}" \
VK_MARKET_ONLY_IDS_FILE=vk_market_retry_ids.txt \
VK_MARKET_INCLUDE_EXISTING=1 \
VK_MARKET_FILE_PREFIX="vk_market_retry_${retry_stamp}" \
  docker compose --profile market up -d --force-recreate market-import

echo "Повтор проблемных товаров запущен в фоне партиями по ${VK_MARKET_RETRY_BATCH_SIZE:-10}."
echo "Уже добавленные товары VK пропустит по их постоянным ID."
echo "Прогресс: docker compose --profile market logs -f market-import"
