#!/usr/bin/env python3
"""Публикация товаров из XLSX на стене сообщества VK.

Скрипт использует только стандартную библиотеку Python. Для реальной публикации
нужен пользовательский access token VK: методы загрузки фото и wall.post в
актуальной схеме VK API доступны с пользовательской авторизацией.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import mimetypes
import os
import random
import re
import sys
import tempfile
import time
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterator, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from xml.etree.ElementTree import iterparse
from zipfile import BadZipFile, ZipFile


API_BASE = "https://api.vk.com/method/"
VK_ID_TOKEN_URL = "https://id.vk.ru/oauth2/auth"
DEFAULT_API_VERSION = "5.199"
DEFAULT_INTERVAL_SECONDS = 900.0
DEFAULT_TIMEOUT_SECONDS = 45.0
DEFAULT_STATE_FILE = "publish_state.json"
DEFAULT_REPORT_FILE = "validation_report.csv"
MAX_VK_PHOTOS = 10
MAX_IMAGE_BYTES = 20 * 1024 * 1024
XML_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

BRAND_COLUMNS = ("Бренд", "Бренд в одежде и обуви")
SIZE_COLUMNS = (
    "Размер",
    "Российский размер",
    "Размер производителя",
    "Размеры",
)


class PublisherError(RuntimeError):
    """Базовая ошибка публикации."""


class WorkbookError(PublisherError):
    """Ошибка чтения XLSX."""


class VkApiError(PublisherError):
    """Ошибка, которую вернул VK API."""

    def __init__(self, method: str, code: int, message: str):
        self.method = method
        self.code = code
        self.api_message = message
        super().__init__(f"VK API {method}: ошибка {code}: {message}")

    @property
    def is_fatal(self) -> bool:
        # Авторизация, права доступа или несовместимый тип токена.
        return self.code in {5, 7, 15, 27}


class HttpRequestError(PublisherError):
    """Ошибка HTTP-запроса."""


class _DescriptionParser(HTMLParser):
    BLOCK_TAGS = {
        "br",
        "div",
        "p",
        "section",
        "article",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "ul",
        "ol",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        del attrs
        if tag == "li":
            if not self.parts or not self.parts[-1].endswith("\n"):
                self.parts.append("\n")
            self.parts.append("• ")
        elif tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if (tag in self.BLOCK_TAGS or tag == "li") and (
            not self.parts or not self.parts[-1].endswith("\n")
        ):
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def text(self) -> str:
        return "".join(self.parts)


@dataclass(frozen=True)
class Product:
    row_number: int
    article: str
    description: str
    title: str
    brand: str
    size: str
    image_urls: tuple[str, ...]
    source_url: str

    @property
    def record_id(self) -> str:
        if self.article:
            return f"article:{self.article}"
        digest_source = "\n".join(
            (
                self.title,
                self.description,
                self.brand,
                self.size,
                *self.image_urls,
            )
        )
        digest = hashlib.sha256(digest_source.encode("utf-8")).hexdigest()[:24]
        return f"content:{digest}"

    @property
    def message(self) -> str:
        parts: list[str] = []
        if self.description:
            parts.append(f"Описание:\n{self.description}")
        if self.title:
            parts.append(f"Название: {self.title}")
        if self.brand:
            parts.append(f"Бренд: {self.brand}")
        if self.size:
            parts.append(f"Размер: {self.size}")
        return "\n\n".join(parts)

    @property
    def warnings(self) -> tuple[str, ...]:
        result: list[str] = []
        if not self.description:
            result.append("нет описания")
        if not self.title:
            result.append("нет названия")
        if not self.brand:
            result.append("нет бренда")
        if not self.size:
            result.append("нет размера")
        if not self.image_urls:
            result.append("нет фото")
        if len(self.image_urls) > MAX_VK_PHOTOS:
            result.append(f"фото больше {MAX_VK_PHOTOS}")
        return tuple(result)

    def is_publishable(self, allow_no_photo: bool = False) -> bool:
        return bool(self.message) and (bool(self.image_urls) or allow_no_photo)


def clean_text(value: str) -> str:
    """Удаляет HTML-разметку и нормализует пробелы, сохраняя абзацы."""
    if not value:
        return ""
    parser = _DescriptionParser()
    try:
        parser.feed(value)
        parser.close()
        text = parser.text()
    except Exception:
        text = re.sub(r"<[^>]+>", " ", value)
    text = html.unescape(text).replace("\xa0", " ").replace("\r\n", "\n")
    text = text.replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_image_urls(value: str) -> tuple[str, ...]:
    if not value:
        return ()
    urls = re.findall(r"https?://[^\s,;]+", value)
    result: list[str] = []
    seen: set[str] = set()
    for candidate in urls:
        url = candidate.rstrip(")>.\"'")
        if url and url not in seen:
            seen.add(url)
            result.append(url)
    return tuple(result)


def _column_index(cell_ref: str) -> int:
    match = re.match(r"[A-Z]+", cell_ref)
    if not match:
        raise WorkbookError(f"Некорректный адрес ячейки: {cell_ref}")
    number = 0
    for char in match.group(0):
        number = number * 26 + ord(char) - ord("A") + 1
    return number - 1


def _read_shared_strings(archive: ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    result: list[str] = []
    with archive.open("xl/sharedStrings.xml") as stream:
        for event, element in iterparse(stream, events=("end",)):
            if event == "end" and element.tag == XML_NS + "si":
                result.append(
                    "".join(node.text or "" for node in element.iter(XML_NS + "t"))
                )
                element.clear()
    return result


def _cell_value(cell: Any, shared_strings: Sequence[str]) -> str:
    cell_type = cell.get("t")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.iter(XML_NS + "t"))
    value_node = cell.find(XML_NS + "v")
    if value_node is None or value_node.text is None:
        return ""
    raw_value = value_node.text
    if cell_type == "s":
        try:
            return shared_strings[int(raw_value)]
        except (ValueError, IndexError) as exc:
            raise WorkbookError("Некорректная таблица общих строк XLSX") from exc
    if cell_type == "b":
        return "TRUE" if raw_value == "1" else "FALSE"
    return raw_value


def iter_xlsx_rows(path: Path) -> Iterator[tuple[int, dict[str, str]]]:
    """Читает первый лист XLSX в потоковом режиме без openpyxl."""
    try:
        with ZipFile(path) as archive:
            worksheet_names = sorted(
                name
                for name in archive.namelist()
                if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)
            )
            if not worksheet_names:
                raise WorkbookError("В XLSX не найден ни один лист")
            shared_strings = _read_shared_strings(archive)
            headers: dict[int, str] | None = None
            with archive.open(worksheet_names[0]) as stream:
                for event, element in iterparse(stream, events=("end",)):
                    if event != "end" or element.tag != XML_NS + "row":
                        continue
                    row_number = int(element.get("r", "0"))
                    cells = {
                        _column_index(cell.get("r", "")): _cell_value(
                            cell, shared_strings
                        ).strip()
                        for cell in element.findall(XML_NS + "c")
                    }
                    element.clear()
                    if headers is None:
                        headers = cells
                        continue
                    row: dict[str, str] = {}
                    for index, value in cells.items():
                        header = headers.get(index, "")
                        if header and (value or header not in row):
                            row[header] = value
                    yield row_number, row
    except FileNotFoundError as exc:
        raise WorkbookError(f"Файл не найден: {path}") from exc
    except BadZipFile as exc:
        raise WorkbookError(f"Файл не является корректным XLSX: {path}") from exc


def _first_value(row: dict[str, str], columns: Sequence[str]) -> str:
    for column in columns:
        value = clean_text(row.get(column, ""))
        if value:
            return value
    return ""


def _size_value(row: dict[str, str]) -> str:
    values: list[str] = []
    seen: set[str] = set()
    for column in SIZE_COLUMNS:
        value = clean_text(row.get(column, ""))
        comparable = value.casefold()
        if value and comparable not in seen:
            seen.add(comparable)
            values.append(value)
    return " / ".join(values)


def row_to_product(row_number: int, row: dict[str, str]) -> Product:
    # "Тип" — аккуратный fallback для строк с пустым "Наименованием".
    title = _first_value(row, ("Наименование", "Тип"))
    return Product(
        row_number=row_number,
        article=clean_text(row.get("Артикул", "")),
        description=clean_text(row.get("Описание", "")),
        title=title,
        brand=_first_value(row, BRAND_COLUMNS),
        size=_size_value(row),
        image_urls=extract_image_urls(row.get("Картинки", "")),
        source_url=clean_text(row.get("Ссылка", "")),
    )


def load_products(path: Path, start_row: int = 2) -> list[Product]:
    return [
        row_to_product(row_number, row)
        for row_number, row in iter_xlsx_rows(path)
        if row_number >= start_row
    ]


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


def _update_env_values(path: Path, values: dict[str, str]) -> None:
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    remaining = dict(values)
    updated: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            updated.append(line)
            continue
        key = line.split("=", 1)[0].strip()
        if key in remaining:
            updated.append(f"{key}={remaining.pop(key)}")
        else:
            updated.append(line)
    for key, value in remaining.items():
        updated.append(f"{key}={value}")
    path.write_text("\n".join(updated) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _json_request(
    request: Request,
    *,
    timeout: float,
    retries: int = 4,
    action: str,
) -> Any:
    for attempt in range(retries + 1):
        try:
            with urlopen(request, timeout=timeout) as response:
                payload = response.read()
            try:
                return json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise HttpRequestError(
                    f"{action}: сервер вернул некорректный JSON"
                ) from exc
        except HTTPError as exc:
            transient = exc.code == 429 or 500 <= exc.code < 600
            if transient and attempt < retries:
                time.sleep(min(2**attempt + random.random(), 20))
                continue
            raise HttpRequestError(f"{action}: HTTP {exc.code}") from exc
        except (URLError, TimeoutError) as exc:
            if attempt < retries:
                time.sleep(min(2**attempt + random.random(), 20))
                continue
            reason = getattr(exc, "reason", exc)
            raise HttpRequestError(f"{action}: {reason}") from exc
    raise AssertionError("Недостижимый код")


class VkTokenManager:
    """Возвращает актуальный токен и обновляет пару токенов VK ID."""

    def __init__(self, env_path: Path, timeout: float):
        self._env_path = env_path
        self._timeout = timeout
        self._access_token = os.environ.get("VK_ACCESS_TOKEN", "").strip()
        self._refresh_token = os.environ.get("VK_REFRESH_TOKEN", "").strip()
        self._client_id = os.environ.get("VK_CLIENT_ID", "").strip()
        self._device_id = os.environ.get("VK_DEVICE_ID", "").strip()
        self._service_token = os.environ.get("VK_SERVICE_TOKEN", "").strip()
        try:
            self._expires_at = int(
                os.environ.get("VK_TOKEN_EXPIRES_AT", "0") or "0"
            )
        except ValueError:
            self._expires_at = 0

    @property
    def can_refresh(self) -> bool:
        return bool(self._refresh_token and self._client_id and self._device_id)

    def get_access_token(self) -> str:
        expires_soon = self._expires_at and self._expires_at <= time.time() + 120
        if self.can_refresh and (not self._access_token or expires_soon):
            self.refresh()
        if not self._access_token:
            raise PublisherError(
                "Сначала выполните локальную авторизацию: python3 vk_auth.py"
            )
        return self._access_token

    def refresh(self) -> str:
        if not self.can_refresh:
            raise PublisherError(
                "Токен истёк, а данных для обновления нет. "
                "Повторите: python3 vk_auth.py"
            )
        state = uuid.uuid4().hex
        params: dict[str, str] = {
            "grant_type": "refresh_token",
            "refresh_token": self._refresh_token,
            "client_id": self._client_id,
            "device_id": self._device_id,
            "state": state,
        }
        if self._service_token:
            params["service_token"] = self._service_token
        request = Request(
            VK_ID_TOKEN_URL,
            data=urlencode(params).encode("utf-8"),
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "vk-xlsx-publisher/1.0",
            },
            method="POST",
        )
        result = _json_request(
            request,
            timeout=self._timeout,
            retries=3,
            action="обновление токена VK ID",
        )
        if not isinstance(result, dict):
            raise PublisherError("VK ID вернул неожиданный ответ")
        if result.get("error"):
            description = result.get("error_description") or result["error"]
            raise PublisherError(f"Не удалось обновить токен VK ID: {description}")
        access_token = str(result.get("access_token", ""))
        refresh_token = str(result.get("refresh_token", ""))
        if not access_token or not refresh_token:
            raise PublisherError("VK ID не вернул новую пару токенов")
        self._access_token = access_token
        self._refresh_token = refresh_token
        self._expires_at = int(time.time()) + int(result.get("expires_in", 3600))
        values = {
            "VK_ACCESS_TOKEN": self._access_token,
            "VK_REFRESH_TOKEN": self._refresh_token,
            "VK_TOKEN_EXPIRES_AT": str(self._expires_at),
            "VK_TOKEN_SCOPE": str(
                result.get("scope", os.environ.get("VK_TOKEN_SCOPE", ""))
            ),
        }
        _update_env_values(self._env_path, values)
        for key, value in values.items():
            os.environ[key] = value
        print("Пользовательский токен VK ID автоматически обновлён.")
        return self._access_token


class StaticTokenManager:
    """Неистекающий ключ сообщества."""

    def __init__(self, token: str):
        self._token = token

    @property
    def can_refresh(self) -> bool:
        return False

    def get_access_token(self) -> str:
        if not self._token:
            raise PublisherError("Ключ сообщества пуст")
        return self._token

    def refresh(self) -> str:
        raise PublisherError("Ключ сообщества нельзя обновить через VK ID")


class VkClient:
    def __init__(
        self,
        token_manager: VkTokenManager | StaticTokenManager,
        api_version: str,
        timeout: float,
    ):
        self._token_manager = token_manager
        self._api_version = api_version
        self._timeout = timeout

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        auth_refreshed = False
        for attempt in range(7):
            request_params: dict[str, Any] = {
                "access_token": self._token_manager.get_access_token(),
                "v": self._api_version,
            }
            if params:
                request_params.update(params)
            encoded_params: dict[str, str | int | float] = {}
            for key, value in request_params.items():
                if value is None:
                    continue
                if isinstance(value, bool):
                    encoded_params[key] = 1 if value else 0
                elif isinstance(value, (list, tuple)):
                    encoded_params[key] = ",".join(str(item) for item in value)
                else:
                    encoded_params[key] = value
            data = urlencode(encoded_params).encode("utf-8")
            request = Request(
                API_BASE + method,
                data=data,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "vk-xlsx-publisher/1.0",
                },
                method="POST",
            )
            result = _json_request(
                request,
                timeout=self._timeout,
                retries=3,
                action=f"запрос {method}",
            )
            if not isinstance(result, dict):
                raise HttpRequestError(f"VK API {method}: неожиданный ответ")
            if "error" not in result:
                if "response" not in result:
                    raise HttpRequestError(f"VK API {method}: ответ без response")
                return result["response"]

            error = result.get("error") or {}
            code = int(error.get("error_code", -1))
            message = str(error.get("error_msg", "неизвестная ошибка"))
            if code == 5 and self._token_manager.can_refresh and not auth_refreshed:
                self._token_manager.refresh()
                auth_refreshed = True
                continue
            if code in {6, 9, 10} and attempt < 6:
                base_delay = 3 if code == 6 else 10
                time.sleep(min(base_delay * (2**attempt) + random.random(), 60))
                continue
            raise VkApiError(method, code, message)
        raise AssertionError("Недостижимый код")

    def upload_binary(
        self, upload_url: str, image_data: bytes, mime_type: str, filename: str
    ) -> dict[str, Any]:
        boundary = f"----vkXlsxPublisher{uuid.uuid4().hex}"
        body = bytearray()
        body.extend(f"--{boundary}\r\n".encode("ascii"))
        body.extend(
            (
                'Content-Disposition: form-data; name="photo"; '
                f'filename="{filename}"\r\n'
            ).encode("ascii")
        )
        body.extend(f"Content-Type: {mime_type}\r\n\r\n".encode("ascii"))
        body.extend(image_data)
        body.extend(f"\r\n--{boundary}--\r\n".encode("ascii"))
        request = Request(
            upload_url,
            data=bytes(body),
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "User-Agent": "vk-xlsx-publisher/1.0",
            },
            method="POST",
        )
        result = _json_request(
            request,
            timeout=self._timeout,
            retries=3,
            action="загрузка фото на сервер VK",
        )
        if not isinstance(result, dict):
            raise HttpRequestError("Сервер загрузки VK вернул неожиданный ответ")
        for required_key in ("photo", "server", "hash"):
            if required_key not in result:
                raise HttpRequestError(
                    f"В ответе сервера загрузки VK нет поля {required_key}"
                )
        return result


def _sniff_image_mime(data: bytes, reported_mime: str) -> str:
    reported_mime = reported_mime.split(";", 1)[0].strip().lower()
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if reported_mime.startswith("image/"):
        return reported_mime
    raise HttpRequestError("Загруженный файл не похож на изображение")


def download_image(url: str, timeout: float) -> tuple[bytes, str]:
    request = Request(
        url,
        headers={
            "Accept": "image/*",
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 Chrome/124 Safari/537.36"
            ),
        },
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            declared_length = response.headers.get("Content-Length")
            if declared_length and int(declared_length) > MAX_IMAGE_BYTES:
                raise HttpRequestError(
                    f"Изображение больше {MAX_IMAGE_BYTES // 1024 // 1024} МБ"
                )
            data = response.read(MAX_IMAGE_BYTES + 1)
            reported_mime = response.headers.get_content_type()
    except HTTPError as exc:
        raise HttpRequestError(f"Скачивание фото: HTTP {exc.code}") from exc
    except (URLError, TimeoutError, ValueError) as exc:
        reason = getattr(exc, "reason", exc)
        raise HttpRequestError(f"Скачивание фото: {reason}") from exc
    if len(data) > MAX_IMAGE_BYTES:
        raise HttpRequestError(
            f"Изображение больше {MAX_IMAGE_BYTES // 1024 // 1024} МБ"
        )
    if not data:
        raise HttpRequestError("Скачано пустое изображение")
    return data, _sniff_image_mime(data, reported_mime)


def _filename_for_mime(index: int, mime_type: str) -> str:
    extension = mimetypes.guess_extension(mime_type) or ".jpg"
    if extension == ".jpe":
        extension = ".jpg"
    return f"photo_{index}{extension}"


def upload_wall_photo(
    client: VkClient,
    group_id: int,
    image_url: str,
    image_index: int,
    timeout: float,
) -> str:
    image_data, mime_type = download_image(image_url, timeout)
    server = client.call("photos.getWallUploadServer", {"group_id": group_id})
    if not isinstance(server, dict) or not server.get("upload_url"):
        raise HttpRequestError("VK не вернул адрес сервера для загрузки фото")
    uploaded = client.upload_binary(
        str(server["upload_url"]),
        image_data,
        mime_type,
        _filename_for_mime(image_index, mime_type),
    )
    saved = client.call(
        "photos.saveWallPhoto",
        {
            "group_id": group_id,
            "photo": uploaded["photo"],
            "server": uploaded["server"],
            "hash": uploaded["hash"],
        },
    )
    if not isinstance(saved, list) or not saved:
        raise HttpRequestError("VK не вернул сохранённое фото")
    photo = saved[0]
    try:
        attachment = f"photo{int(photo['owner_id'])}_{int(photo['id'])}"
    except (KeyError, TypeError, ValueError) as exc:
        raise HttpRequestError("VK вернул фото без owner_id или id") from exc
    if photo.get("access_key"):
        attachment += f"_{photo['access_key']}"
    return attachment


def upload_message_photo(
    client: VkClient,
    image_url: str,
    image_index: int,
    timeout: float,
    peer_id: int,
) -> str:
    """Загружает фото через сервер сообщений, доступный ключу сообщества."""
    image_data, mime_type = download_image(image_url, timeout)
    server = client.call(
        "photos.getMessagesUploadServer", {"peer_id": peer_id}
    )
    if not isinstance(server, dict) or not server.get("upload_url"):
        raise HttpRequestError("VK не вернул адрес сервера загрузки фото")
    uploaded = client.upload_binary(
        str(server["upload_url"]),
        image_data,
        mime_type,
        _filename_for_mime(image_index, mime_type),
    )
    saved = client.call(
        "photos.saveMessagesPhoto",
        {
            "photo": uploaded["photo"],
            "server": uploaded["server"],
            "hash": uploaded["hash"],
        },
    )
    if not isinstance(saved, list) or not saved:
        raise HttpRequestError("VK не вернул сохранённое фото")
    photo = saved[0]
    try:
        attachment = f"photo{int(photo['owner_id'])}_{int(photo['id'])}"
    except (KeyError, TypeError, ValueError) as exc:
        raise HttpRequestError("VK вернул фото без owner_id или id") from exc
    if photo.get("access_key"):
        attachment += f"_{photo['access_key']}"
    return attachment


def validate_credentials(
    client: VkClient, group_id: int, community_auth: bool = False
) -> str:
    if community_auth:
        permissions_response = client.call("groups.getTokenPermissions")
        permissions = (
            permissions_response.get("permissions", [])
            if isinstance(permissions_response, dict)
            else []
        )
        permission_names = {
            str(item.get("name"))
            for item in permissions
            if isinstance(item, dict)
        }
        missing = {"photos", "wall"} - permission_names
        if missing:
            raise PublisherError(
                "Ключу сообщества не хватает прав: " + ", ".join(sorted(missing))
            )
    else:
        users = client.call("users.get")
        if not isinstance(users, list) or not users:
            raise PublisherError(
                "Не удалось подтвердить пользовательский токен через users.get"
            )
    group_response = client.call("groups.getById", {"group_ids": group_id})
    if isinstance(group_response, dict):
        groups = group_response.get("groups") or group_response.get("items") or []
    else:
        groups = group_response
    if not isinstance(groups, list) or not groups:
        raise PublisherError(f"Сообщество с ID {group_id} не найдено")
    group = groups[0] if isinstance(groups[0], dict) else {}
    return str(group.get("name") or group.get("screen_name") or group_id)


def publish_product(
    client: VkClient,
    product: Product,
    group_id: int,
    max_photos: int,
    timeout: float,
    allow_no_photo: bool,
    community_auth: bool = False,
    upload_peer_id: int | None = None,
) -> tuple[int, list[str]]:
    attachments: list[str] = []
    photo_errors: list[str] = []
    for image_index, image_url in enumerate(product.image_urls[:max_photos], 1):
        try:
            if community_auth:
                if upload_peer_id is None:
                    raise PublisherError(
                        "Для загрузки фото ключом сообщества нужен "
                        "VK_UPLOAD_PEER_ID"
                    )
                attachments.append(
                    upload_message_photo(
                        client,
                        image_url,
                        image_index,
                        timeout,
                        upload_peer_id,
                    )
                )
            else:
                attachments.append(
                    upload_wall_photo(
                        client, group_id, image_url, image_index, timeout
                    )
                )
        except VkApiError as exc:
            if exc.is_fatal:
                raise
            photo_errors.append(f"фото {image_index}: {exc}")
        except PublisherError as exc:
            photo_errors.append(f"фото {image_index}: {exc}")

    if not attachments and not allow_no_photo:
        details = "; ".join(photo_errors) if photo_errors else "ссылок на фото нет"
        raise PublisherError(f"нет ни одного загруженного фото: {details}")

    guid = str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"vk-xlsx-publisher:{group_id}:{product.record_id}",
        )
    )
    response = client.call(
        "wall.post",
        {
            "owner_id": -group_id,
            "from_group": True,
            "message": product.message,
            "attachments": attachments,
            "guid": guid,
        },
    )
    if not isinstance(response, dict) or "post_id" not in response:
        raise HttpRequestError("VK не вернул post_id после публикации")
    return int(response["post_id"]), photo_errors


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "published": {}}
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PublisherError(f"Не удалось прочитать состояние {path}: {exc}") from exc
    if not isinstance(state, dict) or not isinstance(state.get("published"), dict):
        raise PublisherError(f"Некорректный файл состояния: {path}")
    return state


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(state, ensure_ascii=False, indent=2) + "\n"
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as stream:
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def _resolve_path(value: str, base_dir: Path) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else base_dir / path


def command_preview(args: argparse.Namespace, base_dir: Path) -> int:
    xlsx_path = _resolve_path(args.xlsx, base_dir)
    products = load_products(xlsx_path, args.start_row)
    limit = args.limit if args.limit is not None else 3
    for product in products[:limit]:
        print(f"\n=== Строка {product.row_number} / {product.record_id} ===")
        print(product.message or "[нет текста]")
        print(
            f"\nФото: {len(product.image_urls)}"
            + (
                f" (в пост пойдут первые {args.max_photos})"
                if len(product.image_urls) > args.max_photos
                else ""
            )
        )
        for url in product.image_urls[: args.max_photos]:
            print(f"  {url}")
        if product.warnings:
            print("Предупреждения: " + ", ".join(product.warnings))
    print(f"\nПоказано: {min(limit, len(products))} из {len(products)} записей.")
    print("Это preview: запросы к VK не выполнялись.")
    return 0


def command_validate(args: argparse.Namespace, base_dir: Path) -> int:
    xlsx_path = _resolve_path(args.xlsx, base_dir)
    report_path = _resolve_path(args.report, base_dir)
    products = load_products(xlsx_path, args.start_row)
    if args.limit is not None:
        products = products[: args.limit]
    warning_counts: Counter[str] = Counter()
    blocked = 0
    for product in products:
        warning_counts.update(product.warnings)
        if not product.is_publishable(allow_no_photo=False):
            blocked += 1

    report_path.parent.mkdir(parents=True, exist_ok=True)
    with report_path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(
            (
                "Строка",
                "ID записи",
                "Артикул",
                "Статус",
                "Предупреждения",
                "Количество фото",
                "Название",
                "Ссылка",
            )
        )
        for product in products:
            writer.writerow(
                (
                    product.row_number,
                    product.record_id,
                    product.article,
                    (
                        "готово"
                        if product.is_publishable(allow_no_photo=False)
                        else "пропуск"
                    ),
                    "; ".join(product.warnings),
                    len(product.image_urls),
                    product.title,
                    product.source_url,
                )
            )

    print(f"Всего записей: {len(products)}")
    print(f"Готово к публикации с фото: {len(products) - blocked}")
    print(f"Будут пропущены без исправления: {blocked}")
    for warning, count in warning_counts.most_common():
        print(f"  {warning}: {count}")
    print(f"Отчёт: {report_path}")
    return 0


def _get_group_id(args: argparse.Namespace) -> int:
    raw_group_id = (
        str(args.group_id)
        if args.group_id is not None
        else os.environ.get("VK_GROUP_ID", "")
    ).strip()
    try:
        group_id = abs(int(raw_group_id))
    except ValueError as exc:
        raise PublisherError(
            "Укажите числовой VK_GROUP_ID в .env или через --group-id"
        ) from exc
    if group_id <= 0:
        raise PublisherError("VK_GROUP_ID должен быть положительным числом")
    return group_id


def _confirm_bulk_publish(
    count: int, group_id: int, interval: float, assume_yes: bool
) -> None:
    print(f"К публикации: {count} новых постов.")
    print(f"Сообщество: {group_id}. Интервал: {interval:g} сек.")
    if count <= 1 or assume_yes:
        return
    if not sys.stdin.isatty():
        raise PublisherError(
            "Для массового запуска без терминала добавьте флаг --yes"
        )
    answer = input("Для начала введите PUBLISH: ").strip()
    if answer != "PUBLISH":
        raise PublisherError("Публикация отменена")


def command_publish(args: argparse.Namespace, base_dir: Path) -> int:
    env_path = _resolve_path(args.env_file, base_dir)
    load_dotenv(env_path)
    community_token = os.environ.get("VK_COMMUNITY_TOKEN", "").strip()
    user_scopes = set(os.environ.get("VK_TOKEN_SCOPE", "").split())
    user_has_publish_scopes = {"photos", "wall", "groups"} <= user_scopes
    community_auth = bool(community_token and not user_has_publish_scopes)
    if community_auth:
        raise PublisherError(
            "Ключ сообщества не поддерживает нативные фото на стене: "
            "VK принимает wall.post, но удаляет фотографии, загруженные через "
            "сервер сообщений. Нужен пользовательский токен с правами "
            "photos wall groups."
        )
    upload_peer_id: int | None = None
    if community_auth:
        raw_peer_id = os.environ.get("VK_UPLOAD_PEER_ID", "").strip()
        try:
            upload_peer_id = int(raw_peer_id)
        except ValueError as exc:
            raise PublisherError(
                "Укажите числовой VK_UPLOAD_PEER_ID в .env"
            ) from exc
    token_manager: VkTokenManager | StaticTokenManager
    if community_auth:
        token_manager = StaticTokenManager(community_token)
    else:
        token_manager = VkTokenManager(env_path, args.timeout)
    token_manager.get_access_token()
    group_id = _get_group_id(args)
    api_version = os.environ.get("VK_API_VERSION", DEFAULT_API_VERSION).strip()
    xlsx_path = _resolve_path(args.xlsx, base_dir)
    state_path = _resolve_path(args.state_file, base_dir)
    state = load_state(state_path)
    published: dict[str, Any] = state["published"]

    products = load_products(xlsx_path, args.start_row)
    state_keys = {
        product.record_id: f"group:{group_id}:{product.record_id}"
        for product in products
    }
    candidates = [
        product
        for product in products
        if state_keys[product.record_id] not in published
        and product.is_publishable(args.allow_no_photo)
    ]
    if args.limit is not None:
        candidates = candidates[: args.limit]
    if not candidates:
        print("Новых записей для публикации нет.")
        return 0

    _confirm_bulk_publish(
        len(candidates), group_id, args.interval, args.yes
    )
    client = VkClient(token_manager, api_version, args.timeout)
    group_name = validate_credentials(client, group_id, community_auth)
    auth_label = "ключ сообщества" if community_auth else "пользовательский токен"
    print(
        f"Авторизация проверена ({auth_label}). "
        f"Сообщество: {group_name} ({group_id})."
    )

    success_count = 0
    failure_count = 0
    for candidate_index, product in enumerate(candidates, 1):
        print(
            f"[{candidate_index}/{len(candidates)}] "
            f"строка {product.row_number}, {product.record_id}"
        )
        try:
            post_id, photo_errors = publish_product(
                client,
                product,
                group_id,
                args.max_photos,
                args.timeout,
                args.allow_no_photo,
                community_auth,
                upload_peer_id,
            )
        except KeyboardInterrupt:
            print("\nОстановлено пользователем. Прогресс уже сохранён.")
            return 130
        except VkApiError as exc:
            failure_count += 1
            print(f"  ОШИБКА: {exc}", file=sys.stderr)
            if exc.is_fatal or args.stop_on_error:
                raise
        except PublisherError as exc:
            failure_count += 1
            print(f"  ОШИБКА: {exc}", file=sys.stderr)
            if args.stop_on_error:
                raise
        else:
            published[state_keys[product.record_id]] = {
                "row": product.row_number,
                "article": product.article,
                "post_id": post_id,
                "group_id": group_id,
                "published_at": datetime.now(timezone.utc).isoformat(),
            }
            save_state(state_path, state)
            success_count += 1
            print(f"  Опубликовано: https://vk.com/wall-{group_id}_{post_id}")
            for photo_error in photo_errors:
                print(f"  Предупреждение: {photo_error}", file=sys.stderr)

        if candidate_index < len(candidates) and args.interval > 0:
            print(f"  Пауза {args.interval:g} сек.")
            time.sleep(args.interval)

    print(
        f"Готово. Опубликовано: {success_count}; ошибок: {failure_count}; "
        f"состояние: {state_path}"
    )
    return 0 if failure_count == 0 else 2


def positive_int(value: str) -> int:
    result = int(value)
    if result <= 0:
        raise argparse.ArgumentTypeError("значение должно быть больше нуля")
    return result


def non_negative_float(value: str) -> float:
    result = float(value)
    if result < 0:
        raise argparse.ArgumentTypeError("значение не может быть отрицательным")
    return result


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--xlsx",
        default="res.xlsx",
        help="путь к XLSX (по умолчанию: res.xlsx)",
    )
    common.add_argument(
        "--start-row",
        type=positive_int,
        default=2,
        help="начальная строка XLSX, включая её (по умолчанию: 2)",
    )
    common.add_argument(
        "--limit",
        type=positive_int,
        help="максимальное количество записей",
    )
    common.add_argument(
        "--max-photos",
        type=positive_int,
        default=MAX_VK_PHOTOS,
        choices=range(1, MAX_VK_PHOTOS + 1),
        metavar="1..10",
        help=f"фото на один пост (по умолчанию: {MAX_VK_PHOTOS})",
    )

    parser = argparse.ArgumentParser(
        description="Публикация записей из XLSX на стене сообщества VK"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser(
        "preview",
        parents=[common],
        help="показать готовый текст без запросов к VK",
    )

    validate_parser = subparsers.add_parser(
        "validate",
        parents=[common],
        help="проверить все записи и сформировать CSV-отчёт",
    )
    validate_parser.add_argument(
        "--report",
        default=DEFAULT_REPORT_FILE,
        help=f"путь к CSV-отчёту (по умолчанию: {DEFAULT_REPORT_FILE})",
    )

    publish_parser = subparsers.add_parser(
        "publish",
        parents=[common],
        help="опубликовать новые записи в VK",
    )
    publish_parser.add_argument(
        "--group-id",
        type=int,
        help="числовой ID сообщества; переопределяет VK_GROUP_ID",
    )
    publish_parser.add_argument(
        "--env-file",
        default=".env",
        help="локальный файл с токеном (по умолчанию: .env)",
    )
    publish_parser.add_argument(
        "--state-file",
        default=DEFAULT_STATE_FILE,
        help=f"файл прогресса (по умолчанию: {DEFAULT_STATE_FILE})",
    )
    publish_parser.add_argument(
        "--interval",
        type=non_negative_float,
        default=DEFAULT_INTERVAL_SECONDS,
        help=(
            "пауза между записями в секундах "
            f"(по умолчанию: {DEFAULT_INTERVAL_SECONDS:g})"
        ),
    )
    publish_parser.add_argument(
        "--timeout",
        type=positive_int,
        default=int(DEFAULT_TIMEOUT_SECONDS),
        help="таймаут одного сетевого запроса (по умолчанию: 45 сек.)",
    )
    publish_parser.add_argument(
        "--allow-no-photo",
        action="store_true",
        help="разрешить текстовые посты для строк без фото",
    )
    publish_parser.add_argument(
        "--stop-on-error",
        action="store_true",
        help="остановиться после первой ошибки строки",
    )
    publish_parser.add_argument(
        "--yes",
        action="store_true",
        help="подтвердить массовую публикацию без интерактивного вопроса",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    base_dir = Path(__file__).resolve().parent
    try:
        if args.command == "preview":
            return command_preview(args, base_dir)
        if args.command == "validate":
            return command_validate(args, base_dir)
        if args.command == "publish":
            return command_publish(args, base_dir)
        parser.error(f"Неизвестная команда: {args.command}")
    except PublisherError as exc:
        print(f"ОШИБКА: {exc}", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
