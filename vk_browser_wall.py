#!/usr/bin/env python3
"""Читает стену VK для проверки браузерной публикации."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
from pathlib import Path

from vk_publisher import VkClient, VkTokenManager, load_dotenv


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--group-id", required=True)
    parser.add_argument("--count", type=int, default=20)
    args = parser.parse_args()
    if not args.group_id.isdigit():
        parser.error("--group-id должен быть числом")
    if not 1 <= args.count <= 100:
        parser.error("--count должен быть от 1 до 100")

    project_dir = Path(__file__).resolve().parent
    data_dir = Path(os.environ.get("VK_DATA_DIR", project_dir)).resolve()
    env_path = data_dir / ".env"
    load_dotenv(env_path)
    client = VkClient(
        VkTokenManager(env_path, timeout=45),
        os.environ.get("VK_API_VERSION", "5.199"),
        timeout=45,
    )
    # Менеджер пишет сообщение об обновлении токена в stdout. JSON оставляем
    # единственным содержимым stdout для надёжного чтения из Node.js.
    with contextlib.redirect_stdout(sys.stderr):
        wall = client.call(
            "wall.get",
            {"owner_id": f"-{args.group_id}", "count": args.count},
        )
    print(json.dumps(wall, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
