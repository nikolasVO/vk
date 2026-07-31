#!/usr/bin/env python3
"""Собирает ID товаров из партий, которые не принял импорт VK."""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
from xml.etree import ElementTree


def resolve_data_path(data_dir: Path, value: str) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else data_dir / path


def offer_ids_from_yml(path: Path) -> list[str]:
    return [
        value
        for offer in ElementTree.parse(path).getroot().findall(".//offer")
        if (value := offer.attrib.get("id", "").strip())
    ]


def offer_ids_from_report(path: Path) -> list[str]:
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return [
            row.get("id", "").strip()
            for row in csv.DictReader(stream)
            if row.get("status") == "ready" and row.get("id", "").strip()
        ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--skipped", default="vk_market_skipped_batches.jsonl"
    )
    parser.add_argument("--output", default="vk_market_retry_ids.txt")
    parser.add_argument(
        "--manifest", default="vk_market_retry_manifest.csv"
    )
    args = parser.parse_args()

    data_dir = Path(os.environ.get("VK_DATA_DIR", Path(__file__).parent))
    skipped_path = resolve_data_path(data_dir, args.skipped)
    output_path = resolve_data_path(data_dir, args.output)
    manifest_path = resolve_data_path(data_dir, args.manifest)
    if not skipped_path.exists():
        raise SystemExit(f"Журнал проблемных партий не найден: {skipped_path}")

    records: list[dict[str, object]] = []
    for number, line in enumerate(
        skipped_path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise SystemExit(
                f"Повреждена строка {number} журнала: {error}"
            ) from error
        if isinstance(record, dict):
            records.append(record)

    unique: dict[str, tuple[str, str]] = {}
    missing_files: list[str] = []
    for record in records:
        file_name = str(record.get("file", ""))
        report_name = str(record.get("report", ""))
        reason = str(record.get("reason", ""))
        file_path = resolve_data_path(data_dir, file_name) if file_name else None
        report_path = (
            resolve_data_path(data_dir, report_name) if report_name else None
        )
        try:
            if file_path and file_path.exists():
                offer_ids = offer_ids_from_yml(file_path)
                source = file_name
            elif report_path and report_path.exists():
                offer_ids = offer_ids_from_report(report_path)
                source = report_name
            else:
                missing_files.append(file_name or report_name or "<не указан>")
                continue
        except (ElementTree.ParseError, OSError) as error:
            raise SystemExit(
                f"Не удалось прочитать {file_name}: {error}"
            ) from error
        for offer_id in offer_ids:
            unique.setdefault(offer_id, (source, reason))

    if not unique:
        raise SystemExit("В журнале нет товаров для повторного импорта")

    output_path.write_text("\n".join(unique) + "\n", encoding="utf-8")
    with manifest_path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["id", "source_batch", "reason"])
        for offer_id, (source, reason) in unique.items():
            writer.writerow([offer_id, source, reason])

    print(f"Проблемных записей в журнале: {len(records)}")
    print(f"Уникальных товаров для повтора: {len(unique)}")
    if missing_files:
        print(f"Предупреждение: отсутствует файлов партий: {len(missing_files)}")
    print(f"ID: {output_path}")
    print(f"Отчёт: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
