#!/usr/bin/env python3
"""Генерирует YML-файл для штатного импорта товаров ВКонтакте."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from xml.etree import ElementTree

from vk_publisher import Product, clean_text, load_dotenv, load_products


MAX_VK_FEED_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class FeedItem:
    product: Product
    offer_id: str
    price: str
    description: str


def vk_picture_url(value: str) -> str:
    """Возвращает URL, по которому VK получает поддерживаемый формат."""
    parts = urlsplit(value)
    path = parts.path
    if parts.hostname and parts.hostname.endswith("ozone.ru"):
        # Ozon отдаёт WebP по URL с /wc1000/, даже если расширение .jpg.
        # Без сегмента ресайза тот же публичный URL возвращает настоящий JPEG.
        path = path.replace("/wc1000/", "/")
    return urlunsplit(
        (parts.scheme, parts.netloc, path, parts.query, parts.fragment)
    )


def normalize_price(value: str) -> str:
    normalized = (
        clean_text(value)
        .replace("\u00a0", "")
        .replace(" ", "")
        .replace(",", ".")
    )
    normalized = re.sub(r"[^\d.+-]", "", normalized)
    try:
        price = Decimal(normalized)
    except InvalidOperation:
        return ""
    if not price.is_finite() or price <= 0:
        return ""
    result = format(price, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return result or "0"


def visible_description(product: Product) -> str:
    parts = [product.description or product.title]
    if product.brand:
        parts.append(f"Бренд: {product.brand}")
    if product.size:
        parts.append(f"Размер: {product.size}")
    return "\n\n".join(part for part in parts if part)


def prepare_items(
    products: list[Product], limit: int, offset: int = 0
) -> tuple[list[FeedItem], list[tuple[Product, str]]]:
    items: list[FeedItem] = []
    skipped: list[tuple[Product, str]] = []
    seen_ids: set[str] = set()
    for product in products:
        reasons: list[str] = []
        offer_id = product.article or f"row-{product.row_number}"
        price = normalize_price(product.price)
        description = visible_description(product)
        if offer_id in seen_ids:
            reasons.append("повторяющийся id")
        if not product.title:
            reasons.append("нет названия")
        if not description:
            reasons.append("нет описания")
        if not product.image_urls:
            reasons.append("нет фото")
        if not price:
            reasons.append("нет корректной цены")
        if reasons:
            skipped.append((product, "; ".join(reasons)))
            continue
        seen_ids.add(offer_id)
        items.append(
            FeedItem(
                product=product,
                offer_id=offer_id,
                price=price,
                description=description,
            )
        )
    end = offset + limit if limit else None
    return items[offset:end], skipped


def filter_products_by_ids(
    products: list[Product], path: Path
) -> list[Product]:
    """Оставляет товары, ID которых перечислены по одному на строку."""
    requested = {
        line.strip()
        for line in path.read_text(encoding="utf-8-sig").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    if not requested:
        raise SystemExit(f"Файл ID пуст: {path}")
    filtered = [
        product
        for product in products
        if (product.article or f"row-{product.row_number}") in requested
    ]
    found = {
        product.article or f"row-{product.row_number}"
        for product in filtered
    }
    missing = requested - found
    if missing:
        print(
            f"Предупреждение: {len(missing)} ID из {path.name} "
            "не найдены в Excel"
        )
    if not filtered:
        raise SystemExit("Ни один ID для повторного импорта не найден в Excel")
    return filtered


def exclude_existing_products(
    products: list[Product], path: Path
) -> tuple[list[Product], list[tuple[Product, str]]]:
    if not path.exists():
        return products, []
    data = json.loads(path.read_text(encoding="utf-8"))
    entries = data.get("items", []) if isinstance(data, dict) else []
    by_title: dict[str, list[int]] = {}
    for index, product in enumerate(products):
        title_key = re.sub(r"\s+", " ", product.title).strip().casefold()
        if title_key:
            by_title.setdefault(title_key, []).append(index)

    claimed: set[int] = set()
    pending_title_matches: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        title_key = (
            re.sub(r"\s+", " ", str(entry.get("title", "")))
            .strip()
            .casefold()
        )
        candidates = by_title.get(title_key, [])
        if not candidates:
            continue
        price_match = re.search(
            r"([\d\s]+)\s*₽", str(entry.get("row_text", ""))
        )
        existing_price = (
            normalize_price(price_match.group(1)) if price_match else ""
        )
        exact = next(
            (
                index
                for index in candidates
                if index not in claimed
                and existing_price
                and normalize_price(products[index].price) == existing_price
            ),
            None,
        )
        if exact is not None:
            claimed.add(exact)
        else:
            pending_title_matches.append(title_key)

    for title_key in pending_title_matches:
        candidate = next(
            (
                index
                for index in by_title.get(title_key, [])
                if index not in claimed
            ),
            None,
        )
        if candidate is not None:
            claimed.add(candidate)

    remaining: list[Product] = []
    skipped: list[tuple[Product, str]] = []
    for index, product in enumerate(products):
        if index in claimed:
            skipped.append((product, "товар с таким названием уже есть в VK"))
        else:
            remaining.append(product)
    return remaining, skipped


def build_yml(
    items: list[FeedItem],
    *,
    group_id: str,
    shop_name: str,
    company_name: str,
    max_photos: int,
    catalog_date: str | None = None,
) -> ElementTree.ElementTree:
    catalog = ElementTree.Element(
        "yml_catalog",
        {"date": catalog_date or datetime.now().strftime("%Y-%m-%d %H:%M")},
    )
    shop = ElementTree.SubElement(catalog, "shop")
    ElementTree.SubElement(shop, "name").text = shop_name
    ElementTree.SubElement(shop, "company").text = company_name
    ElementTree.SubElement(shop, "url").text = f"https://vk.ru/club{group_id}"
    currencies = ElementTree.SubElement(shop, "currencies")
    ElementTree.SubElement(currencies, "currency", {"id": "RUB", "rate": "1"})
    offers = ElementTree.SubElement(shop, "offers")

    for item in items:
        product = item.product
        offer = ElementTree.SubElement(
            offers,
            "offer",
            {"id": item.offer_id, "available": "true"},
        )
        ElementTree.SubElement(offer, "name").text = product.title
        ElementTree.SubElement(offer, "price").text = item.price
        ElementTree.SubElement(offer, "currencyId").text = "RUB"
        ElementTree.SubElement(offer, "description").text = item.description
        for image_url in product.image_urls[:max_photos]:
            ElementTree.SubElement(offer, "picture").text = vk_picture_url(
                image_url
            )
        if product.brand:
            ElementTree.SubElement(
                offer, "param", {"name": "Бренд"}
            ).text = product.brand
        if product.size:
            ElementTree.SubElement(
                offer, "param", {"name": "Размер"}
            ).text = product.size

    ElementTree.indent(catalog, space="  ")
    return ElementTree.ElementTree(catalog)


def write_report(
    path: Path,
    items: list[FeedItem],
    skipped: list[tuple[Product, str]],
) -> None:
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(
            ["row", "id", "title", "price", "status", "reason"]
        )
        for item in items:
            writer.writerow(
                [
                    item.product.row_number,
                    item.offer_id,
                    item.product.title,
                    item.price,
                    "ready",
                    "",
                ]
            )
        for product, reason in skipped:
            writer.writerow(
                [
                    product.row_number,
                    product.article,
                    product.title,
                    product.price,
                    "skipped",
                    reason,
                ]
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", default="res.xlsx")
    parser.add_argument("--output", default="vk_market_products.yml")
    parser.add_argument("--report", default="vk_market_validation.csv")
    parser.add_argument("--existing", default="vk_market_existing.json")
    parser.add_argument("--only-ids", default="")
    parser.add_argument("--include-existing", action="store_true")
    parser.add_argument("--start-row", type=int, default=2)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--max-photos", type=int, default=5)
    parser.add_argument("--group-id")
    parser.add_argument("--shop-name", default="Товары")
    parser.add_argument("--company-name", default="VK Community")
    args = parser.parse_args()

    if args.limit < 0:
        parser.error("--limit должен быть 0 (все товары) или положительным")
    if args.offset < 0:
        parser.error("--offset должен быть 0 или положительным")
    if not 1 <= args.max_photos <= 5:
        parser.error("--max-photos должен быть от 1 до 5")

    data_dir = Path(os.environ.get("VK_DATA_DIR", Path(__file__).parent))
    load_dotenv(data_dir / ".env")
    group_id = (args.group_id or os.environ.get("VK_GROUP_ID", "")).strip()
    if not re.fullmatch(r"\d+", group_id):
        parser.error("VK_GROUP_ID не задан или имеет неверный формат")

    xlsx_path = Path(args.xlsx).expanduser()
    output_path = Path(args.output).expanduser()
    report_path = Path(args.report).expanduser()
    existing_path = Path(args.existing).expanduser()
    if not xlsx_path.is_absolute():
        xlsx_path = data_dir / xlsx_path
    if not output_path.is_absolute():
        output_path = data_dir / output_path
    if not report_path.is_absolute():
        report_path = data_dir / report_path
    if not existing_path.is_absolute():
        existing_path = data_dir / existing_path

    products = load_products(xlsx_path, args.start_row)
    if args.only_ids:
        only_ids_path = Path(args.only_ids).expanduser()
        if not only_ids_path.is_absolute():
            only_ids_path = data_dir / only_ids_path
        products = filter_products_by_ids(products, only_ids_path)
    if args.include_existing:
        existing_skipped: list[tuple[Product, str]] = []
    else:
        products, existing_skipped = exclude_existing_products(
            products, existing_path
        )
    items, invalid_skipped = prepare_items(
        products, args.limit, offset=args.offset
    )
    skipped = existing_skipped + invalid_skipped
    if not items:
        raise SystemExit("Нет товаров, подходящих для импорта VK")

    tree = build_yml(
        items,
        group_id=group_id,
        shop_name=clean_text(args.shop_name),
        company_name=clean_text(args.company_name),
        max_photos=args.max_photos,
        # Одинаковый Excel должен давать одинаковый YML и SHA-256. Иначе
        # текущее время позволяло случайно повторно отправить тот же каталог.
        catalog_date=datetime.fromtimestamp(
            xlsx_path.stat().st_mtime
        ).strftime("%Y-%m-%d %H:%M"),
    )
    tree.write(
        output_path,
        encoding="utf-8",
        xml_declaration=True,
        short_empty_elements=True,
    )
    write_report(report_path, items, skipped)

    size = output_path.stat().st_size
    if size > MAX_VK_FEED_BYTES:
        output_path.unlink(missing_ok=True)
        raise SystemExit(
            f"YML превышает лимит VK 8 МБ: {size / 1024 / 1024:.2f} МБ"
        )
    print(f"Готово товаров: {len(items)}")
    print(f"Уже есть в VK: {len(existing_skipped)}")
    print(f"Пропущено как неполные: {len(invalid_skipped)}")
    print(f"YML: {output_path} ({size / 1024 / 1024:.2f} МБ)")
    print(f"Отчёт: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
