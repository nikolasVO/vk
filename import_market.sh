#!/bin/sh
set -eu

feed_file="${VK_MARKET_FEED_FILE:-vk_market_products.yml}"
limit="${1:-}"

case "$limit" in
  "")
    ;;
  *[!0-9]*)
    echo "Использование: ./import_market.sh [количество_товаров]" >&2
    exit 2
    ;;
esac

docker compose build publisher
docker compose up -d chromium

docker compose run --rm --entrypoint node publisher \
  /app/vk_market_existing.mjs

if [ -n "$limit" ]; then
  docker compose run --rm --entrypoint python3 publisher \
    /app/vk_market_feed.py --limit "$limit" --output "$feed_file"
else
  docker compose run --rm --entrypoint python3 publisher \
    /app/vk_market_feed.py --output "$feed_file"
fi

docker compose run --rm --entrypoint node publisher \
  /app/vk_market_import.mjs --upload --file "$feed_file" --yes

echo "Файл отправлен. Дальнейший импорт и загрузку фотографий выполняет VK."
