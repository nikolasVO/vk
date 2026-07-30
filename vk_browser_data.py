#!/usr/bin/env python3
"""Отдаёт браузерному загрузчику нормализованные товары в JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from vk_publisher import load_products


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", default="res.xlsx")
    parser.add_argument("--start-row", type=int, default=2)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--max-photos", type=int, default=10)
    args = parser.parse_args()
    if args.limit < 0:
        parser.error("--limit должен быть 0 (все записи) или положительным числом")
    if not 1 <= args.max_photos <= 10:
        parser.error("--max-photos должен быть от 1 до 10")

    project_dir = Path(__file__).resolve().parent
    xlsx = Path(args.xlsx).expanduser()
    if not xlsx.is_absolute():
        xlsx = project_dir / xlsx
    products = load_products(xlsx, args.start_row)
    result = []
    for product in products:
        if not product.is_publishable(allow_no_photo=False):
            continue
        result.append(
            {
                "record_id": product.record_id,
                "row_number": product.row_number,
                "article": product.article,
                "message": product.message,
                "image_urls": list(product.image_urls[: args.max_photos]),
            }
        )
        if args.limit and len(result) >= args.limit:
            break
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
