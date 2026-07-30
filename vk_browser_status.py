#!/usr/bin/env python3
"""Показывает локальный прогресс браузерной публикации."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from vk_publisher import load_products


PROJECT_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("VK_DATA_DIR", PROJECT_DIR)).resolve()
STATE_PATH = DATA_DIR / "browser_publish_state.json"


def load_env() -> dict[str, str]:
    result: dict[str, str] = {}
    env_path = DATA_DIR / ".env"
    if not env_path.exists():
        return result
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = value.strip().strip("\"'")
    return result


def wall_summary(env: dict[str, str], group_id: str) -> tuple[int, list[dict]]:
    tokens = (
        env.get("VK_COMMUNITY_TOKEN", ""),
        env.get("VK_SERVICE_TOKEN", ""),
        env.get("VK_ACCESS_TOKEN", ""),
    )
    last_error = "подходящий токен не найден"
    for token in tokens:
        if len(token) <= 20 or token.lower().startswith("replace_"):
            continue
        data = urlencode(
            {
                "owner_id": f"-{group_id}",
                "count": "10",
                "access_token": token,
                "v": env.get("VK_API_VERSION", "5.199"),
            }
        ).encode()
        try:
            request = Request(
                "https://api.vk.com/method/wall.get",
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with urlopen(request, timeout=30) as response:
                payload = json.load(response)
            if "error" in payload:
                error = payload["error"]
                last_error = (
                    f"VK API {error.get('error_code')}: {error.get('error_msg')}"
                )
                continue
            result = payload["response"]
            return int(result["count"]), list(result["items"])
        except Exception as error:  # noqa: BLE001 — перебираем доступные токены
            last_error = str(error)
    raise RuntimeError(last_error)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--online",
        action="store_true",
        help="дополнительно проверить последние посты через VK API",
    )
    args = parser.parse_args()
    env = load_env()
    group_id = env.get("VK_GROUP_ID", "")
    products = load_products(DATA_DIR / "res.xlsx")
    ready = [product for product in products if product.is_publishable()]
    without_photos = [product for product in products if not product.image_urls]
    if STATE_PATH.exists():
        state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    else:
        state = {"published": {}, "failed": {}}

    published = state.get("published", {})
    failed = state.get("failed", {})
    prefix = f"group:{group_id}:"
    group_published = {
        key: value for key, value in published.items() if key.startswith(prefix)
    }
    group_failed = {
        key: value for key, value in failed.items() if key.startswith(prefix)
    }

    print(f"Всего строк с товарами:       {len(products)}")
    print(f"Готовы к публикации с фото:  {len(ready)}")
    print(f"Без фотографий (пропущены): {len(without_photos)}")
    print(f"Опубликовано по журналу:     {len(group_published)}")
    print(f"Осталось готовых:            {max(len(ready) - len(group_published), 0)}")
    print(f"Ошибок последнего запуска:   {len(group_failed)}")
    if group_id:
        print(f"ID группы:                   {group_id}")
    if state.get("pending"):
        pending = state["pending"]
        print(
            "Незавершённая проверка:       "
            f"строка {pending.get('row', '?')}, {pending.get('record_id', '?')}"
        )
    if args.online:
        if not group_id.isdigit():
            raise RuntimeError("VK_GROUP_ID не указан в .env")
        total, posts = wall_summary(env, group_id)
        print(f"Постов на стене VK:          {total}")
        print("Последние посты (ID → фото):")
        for post in posts:
            photo_count = sum(
                attachment.get("type") == "photo"
                for attachment in post.get("attachments", [])
            )
            print(f"  {post.get('id')} → {photo_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
