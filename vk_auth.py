#!/usr/bin/env python3
"""Локальная авторизация VK ID через Authorization Code + PKCE.

Команда открывает официальный экран VK ID. После подтверждения браузер
переходит на http://localhost и может показать ошибку соединения: это нормально.
Нужно скопировать полный URL из адресной строки — скрипт увидит его в буфере
обмена, проверит state и сохранит токены в локальный .env.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from typing import Any, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

from vk_publisher import load_dotenv


AUTHORIZE_URL = "https://id.vk.ru/authorize"
TOKEN_URL = "https://id.vk.ru/oauth2/auth"
DEFAULT_REDIRECT_URI = "http://localhost"
DEFAULT_SCOPE = "photos wall groups offline"
PENDING_FILE = ".vk_auth_pending.json"


class AuthError(RuntimeError):
    pass


def _base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _write_private_json(path: Path, data: dict[str, Any]) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    finally:
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def _update_env(path: Path, values: dict[str, str]) -> None:
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


def _post_token(params: dict[str, str], timeout: float) -> dict[str, Any]:
    request = Request(
        TOKEN_URL,
        data=urlencode(params).encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "vk-xlsx-publisher-auth/1.0",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = response.read()
    except HTTPError as exc:
        payload = exc.read()
        try:
            result = json.loads(payload.decode("utf-8"))
        except Exception:
            raise AuthError(f"VK ID вернул HTTP {exc.code}") from exc
    except (URLError, TimeoutError) as exc:
        reason = getattr(exc, "reason", exc)
        raise AuthError(f"Ошибка соединения с VK ID: {reason}") from exc
    else:
        try:
            result = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AuthError("VK ID вернул некорректный JSON") from exc
    if not isinstance(result, dict):
        raise AuthError("VK ID вернул неожиданный ответ")
    if result.get("error"):
        description = result.get("error_description") or result["error"]
        raise AuthError(f"VK ID: {description}")
    return result


def create_authorization(
    env_path: Path, pending_path: Path, scope: str
) -> str:
    load_dotenv(env_path)
    client_id = os.environ.get("VK_CLIENT_ID", "").strip()
    if not client_id.isdigit():
        raise AuthError("Укажите числовой VK_CLIENT_ID в .env")
    redirect_uri = os.environ.get("VK_REDIRECT_URI", DEFAULT_REDIRECT_URI).strip()
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = _base64url(hashlib.sha256(verifier.encode("ascii")).digest())
    pending = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": scope,
        "state": state,
        "code_verifier": verifier,
        "created_at": int(time.time()),
    }
    _write_private_json(pending_path, pending)
    return AUTHORIZE_URL + "?" + urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": scope,
            "prompt": "consent",
        }
    )


def _clipboard_text() -> str:
    try:
        result = subprocess.run(
            ["pbpaste"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip()


def wait_for_callback_from_clipboard(
    redirect_uri: str, timeout_seconds: int
) -> str:
    deadline = time.monotonic() + timeout_seconds
    redirect = urlparse(redirect_uri)
    expected_host = (redirect.hostname or "").casefold()
    print(
        "После подтверждения скопируйте ПОЛНЫЙ адрес из адресной строки "
        "браузера (Cmd+L, Cmd+C)."
    )
    while time.monotonic() < deadline:
        candidate = _clipboard_text()
        if candidate:
            parsed = urlparse(candidate)
            if (
                parsed.scheme in {"http", "https"}
                and (parsed.hostname or "").casefold() == expected_host
                and ("code=" in parsed.query or "error=" in parsed.query)
            ):
                return candidate
        time.sleep(1)
    raise AuthError("Время ожидания URL истекло. Запустите авторизацию ещё раз.")


def exchange_callback(
    callback_url: str,
    env_path: Path,
    pending_path: Path,
    timeout: float,
) -> None:
    if not pending_path.exists():
        raise AuthError("Нет ожидающей авторизации. Сначала запустите authorize.")
    try:
        pending = json.loads(pending_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AuthError("Не удалось прочитать параметры ожидающей авторизации") from exc
    if int(time.time()) - int(pending.get("created_at", 0)) > 600:
        raise AuthError("Код авторизации устарел. Запустите авторизацию ещё раз.")

    query = parse_qs(urlparse(callback_url).query)
    if query.get("error"):
        description = query.get("error_description", query["error"])[0]
        raise AuthError(f"VK ID: {description}")
    state = query.get("state", [""])[0]
    code = query.get("code", [""])[0]
    device_id = query.get("device_id", [""])[0]
    if not secrets.compare_digest(state, str(pending["state"])):
        raise AuthError("Проверка state не пройдена; ответ может быть подменён")
    if not code or not device_id:
        raise AuthError("В callback URL нет code или device_id")

    load_dotenv(env_path)
    params = {
        "grant_type": "authorization_code",
        "code_verifier": str(pending["code_verifier"]),
        "redirect_uri": str(pending["redirect_uri"]),
        "code": code,
        "client_id": str(pending["client_id"]),
        "device_id": device_id,
        "state": state,
    }
    service_token = os.environ.get("VK_SERVICE_TOKEN", "").strip()
    if service_token:
        params["service_token"] = service_token
    result = _post_token(params, timeout)
    access_token = str(result.get("access_token", ""))
    refresh_token = str(result.get("refresh_token", ""))
    if not access_token or not refresh_token:
        raise AuthError("VK ID не вернул Access token или Refresh token")
    expires_in = int(result.get("expires_in", 3600))
    _update_env(
        env_path,
        {
            "VK_ACCESS_TOKEN": access_token,
            "VK_REFRESH_TOKEN": refresh_token,
            "VK_DEVICE_ID": device_id,
            "VK_TOKEN_EXPIRES_AT": str(int(time.time()) + expires_in),
            "VK_TOKEN_SCOPE": str(result.get("scope", pending.get("scope", ""))),
        },
    )
    try:
        pending_path.unlink()
    except FileNotFoundError:
        pass
    print("Авторизация успешна. Токены сохранены локально в .env.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Локальное получение пользовательского токена VK ID"
    )
    parser.add_argument("--env-file", default=".env")
    parser.add_argument("--scope", default=DEFAULT_SCOPE)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument(
        "--callback-url",
        help="полный callback URL вместо чтения из буфера обмена",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    base_dir = Path(__file__).resolve().parent
    env_path = Path(args.env_file).expanduser()
    if not env_path.is_absolute():
        env_path = base_dir / env_path
    pending_path = base_dir / PENDING_FILE
    try:
        authorization_url = create_authorization(
            env_path, pending_path, args.scope
        )
        print("Открываю официальный экран авторизации VK ID...")
        opened = webbrowser.open(authorization_url, new=1)
        if not opened:
            print("Откройте ссылку вручную:\n" + authorization_url)
        callback_url = args.callback_url or wait_for_callback_from_clipboard(
            os.environ.get("VK_REDIRECT_URI", DEFAULT_REDIRECT_URI),
            args.timeout,
        )
        exchange_callback(callback_url, env_path, pending_path, 45)
    except AuthError as exc:
        print(f"ОШИБКА: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
