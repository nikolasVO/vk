# Docker-публикация `res.xlsx` в VK

Вся рабочая система запускается через Docker Compose:

- `chromium` — постоянный Chromium с веб-интерфейсом и сохранённой VK-сессией;
- `publisher` — одноразовая публикация заданного количества товаров;
- `publisher-all` — фоновая обработка всего остатка с перезапуском после
  перезагрузки Docker или сервера.

Код, Node.js и Python находятся в образе `publisher`. На хосте остаются только
данные и состояние:

- `.env`;
- `res.xlsx`;
- `browser_publish_state.json`;
- `.docker-chromium-config/` — профиль и авторизация Chromium;
- `vk-browser-logs/`.

## Подготовка

```bash
cd /path/to/vk
docker compose build publisher
docker compose up -d chromium
```

Веб-интерфейс Chromium доступен только локально:

```text
https://localhost:3001
```

Если порт занят, укажите другой в `.env`, например
`VK_CHROMIUM_HTTPS_PORT=3002`, и откройте соответствующий адрес.

Браузер использует самоподписанный сертификат — при первом открытии нужно
разрешить переход. Войдите в VK под администратором сообщества. Сессия
сохранится в `.docker-chromium-config/`.

На удалённом сервере порт не нужно открывать в интернет. Используйте SSH-туннель:

```bash
ssh -L 3001:127.0.0.1:3001 user@server
```

После этого откройте на своём компьютере `https://localhost:3001`.

## Публикация

Следующие 100 товаров:

```bash
docker compose run --rm publisher \
  --publish --yes --limit 100 --interval 60
```

Произвольное количество:

```bash
docker compose run --rm publisher \
  --publish --yes --limit 25 --interval 90
```

Все оставшиеся товары в фоне:

```bash
docker compose --profile all up -d --build publisher-all
```

Просмотр фоновых логов:

```bash
docker compose logs -f publisher-all
```

Остановка:

```bash
docker compose stop publisher-all
```

Повторный запуск безопасен: загрузчик читает `browser_publish_state.json` и
продолжает с первой ещё не опубликованной строки.

## Статус

Проверка авторизации и прав администратора без создания поста:

```bash
docker compose run --rm --entrypoint node publisher \
  /app/vk_browser_session_transfer.mjs --check
```

Сводка по строкам и журналу:

```bash
docker compose run --rm --entrypoint python3 publisher \
  /app/vk_browser_status.py
```

Состояние контейнеров:

```bash
docker compose ps
```

## Перенос на сервер

Перед копированием сохранённого профиля остановите Chromium, чтобы файлы
профиля не менялись во время переноса:

```bash
docker compose stop chromium
```

Скопируйте папку проекта вместе с:

```text
Dockerfile
compose.yaml
.dockerignore
.env
res.xlsx
browser_publish_state.json
.docker-chromium-config/
*.py
*.mjs
package.json
package-lock.json
```

Затем на сервере:

```bash
docker compose build publisher
docker compose up -d chromium
docker compose --profile all up -d publisher-all
```

Если профиль `.docker-chromium-config/` не переносился или VK запросил новый
вход, подключитесь через SSH-туннель и войдите заново.

Для хранения данных в отдельном каталоге можно задать:

```bash
export VK_DATA_PATH=/srv/vk-publisher/data
export VK_CHROME_CONFIG_PATH=/srv/vk-publisher/chromium
docker compose --profile all up -d publisher-all
```

В `VK_DATA_PATH` должны находиться `.env`, `res.xlsx` и
`browser_publish_state.json`.

## Формат поста

```text
Описание:
...

Название: ...

Бренд: ...          ← если заполнен в Excel

Размер: ...         ← если заполнен в Excel
```

В пост добавляется до 10 фотографий. Строки без фотографий пропускаются.
HTML-разметка описания преобразуется в обычный текст.

## Надёжность

- Прогресс сохраняется после каждого товара.
- Перед повтором неоднозначная операция сверяется со стеной.
- Одновременный запуск двух загрузчиков блокируется.
- Повторяющиеся строки Excel считаются разными записями.
- Временные фотографии удаляются после обработки.
- Ошибка отдельного товара записывается в журнал; обработка продолжается.
- `publisher-all` возобновляет работу после перезапуска сервера.

Не публикуйте `.env`, `.docker-chromium-config/` и
`browser_publish_state.json` в открытом репозитории.
