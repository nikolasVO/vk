# Импорт товаров из `res.xlsx` в магазин VK

Основной сценарий проекта — массовое добавление строк Excel именно как
карточек товаров VK, а не как записей на стене.

Для каждого товара передаются:

- название;
- цена в рублях;
- описание;
- до пяти фотографий по ссылкам из столбца `Картинки`;
- бренд и размер, если они заполнены.

Вся рабочая логика запускается в Docker. Авторизация VK хранится в постоянном
профиле Chromium, а сам файл после отправки обрабатывается внутри VK — держать
контейнер запущенным до окончания импорта не нужно.

## Файлы и состояние

- `res.xlsx` — исходный каталог;
- `.env` — настройки сообщества;
- `.docker-chromium-config/` — сохранённый вход в VK;
- `vk_market_existing.json` — снимок уже существующих карточек;
- `vk_market_products.yml` — подготовленный импорт;
- `vk_market_validation.csv` — отчёт по строкам;
- `vk_market_import_state.json` — защита от повторной отправки одного файла.

Сгенерированные файлы и секреты исключены из Git.

## Настройки `.env`

Минимально нужны:

```dotenv
VK_GROUP_ID=230722098
VK_CHROMIUM_HTTPS_PORT=3002
```

`VK_GROUP_ID` — числовой ID сообщества без `club` и без минуса. Пользовательский
access token для импорта через интерфейс VK не нужен: используется сохранённая
сессия администратора в Chromium.

## Первый запуск и вход в VK

```bash
docker compose build publisher
docker compose up -d chromium
```

Откройте `https://localhost:3002` (или порт из
`VK_CHROMIUM_HTTPS_PORT`), разрешите переход с самоподписанным сертификатом и
войдите в VK под администратором сообщества. Вход сохранится после перезапуска.

На сервере не открывайте порт Chromium в интернет. Создайте SSH-туннель:

```bash
ssh -L 3002:127.0.0.1:3002 user@server
```

Затем откройте на своём компьютере `https://localhost:3002`.

## Массовый импорт товаров

Сначала получите список существующих карточек. Это защищает от дубликатов:

```bash
docker compose run --rm --entrypoint node publisher \
  /app/vk_market_existing.mjs
```

Создайте YML:

```bash
docker compose run --rm --entrypoint python3 publisher \
  /app/vk_market_feed.py
```

Проверка, что VK принимает файл, без запуска импорта:

```bash
docker compose run --rm --entrypoint node publisher \
  /app/vk_market_import.mjs \
  --upload --file vk_market_products.yml
```

Отправка файла в VK:

```bash
docker compose run --rm --entrypoint node publisher \
  /app/vk_market_import.mjs \
  --upload --file vk_market_products.yml --yes
```

После сообщения `Импорт отправлен` контейнер можно закрыть: VK продолжит
обработку файла самостоятельно. Тот же файл нельзя случайно отправить повторно.
Для намеренного повторного импорта существует флаг `--force`.

Ограничить число новых товаров, например первыми 100:

```bash
docker compose run --rm --entrypoint python3 publisher \
  /app/vk_market_feed.py --limit 100
```

После этого отправьте созданный YML обычной командой импорта.

## Проверки и ограничения

- строки без названия, цены или фото не попадают в YML;
- при пустом описании используется название;
- HTML в описании преобразуется в обычный текст;
- фотографии берутся по прямым ссылкам из Excel;
- в YML добавляется до пяти фото на карточку;
- бренд и размер передаются как свойства и дублируются в описании;
- уже существующие товары исключаются по названию и цене;
- итоговый YML проверяется на лимит 8 МБ;
- все решения по строкам записываются в `vk_market_validation.csv`.

## Старый режим публикации на стену

Старая логика сохранена, но вынесена в отдельный профиль `wall` и по умолчанию
не запускается:

```bash
docker compose --profile wall up -d publisher-all
```

Остановить её:

```bash
docker compose --profile wall stop publisher-all
```

Этот режим не нужен для импорта товаров и оставлен только для совместимости.

## Проверка проекта

```bash
python3 -m unittest -v
node --check vk_market_existing.mjs
node --check vk_market_import.mjs
node --check vk_market_verify.mjs
docker compose config --quiet
```

Не публикуйте `.env`, `.docker-chromium-config/`, файлы состояния и отчёты в
открытом репозитории.
