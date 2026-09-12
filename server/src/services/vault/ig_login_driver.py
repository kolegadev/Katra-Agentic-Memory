#!/usr/bin/env python3
"""Katra Vault — typed Instagram login driver (server-side instagrapi).

Operator-hosted helper for the vault's `instagram_login` capability. The
vault opens the IG password server-side and POSTs it here over a
token-gated localhost hop; this process runs instagrapi's own
client-encrypted login and returns ONLY derived session material
(sessionid / csrftoken / user id). The plaintext password is never
written to disk, argv, logs, or any response after the login call.

Usage:
    IG_DRIVER_TOKEN=<secret> [IG_DRIVER_PORT=8751] \
        python3 ig_login_driver.py

Requires: pip install instagrapi
"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIND = os.environ.get("IG_DRIVER_BIND", "127.0.0.1")
PORT = int(os.environ.get("IG_DRIVER_PORT", "8751"))
TOKEN = os.environ.get("IG_DRIVER_TOKEN", "").strip()

if not TOKEN:
    print("ig_login_driver: IG_DRIVER_TOKEN is required (refusing to start)", file=sys.stderr)
    sys.exit(1)

try:
    from instagrapi import Client  # type: ignore
except ImportError:
    print("ig_login_driver: instagrapi is required — pip install instagrapi", file=sys.stderr)
    sys.exit(1)

MAX_BODY = 16 * 1024


def do_login(username: str, password: str) -> dict:
    """Run instagrapi's client-encrypted login; return session material only.

    The password exists only inside this call frame and is never returned,
    logged, or stored.
    """
    client = Client()
    try:
        client.login(username, password)
    finally:
        # The session the client holds is what we surface; drop the password
        # reference as soon as the login call returns or raises.
        del password
    session = getattr(client, "sessionid", None)
    csrf = getattr(client, "csrf_token", None) or (
        getattr(client, "private", None)
        and getattr(client.private, "csrf_token", None)
    )
    user_id = getattr(client, "user_id", None)
    return {
        "ok": True,
        "userIdPk": str(user_id) if user_id is not None else None,
        "sessionid": session,
        "csrftoken": csrf,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "KatraIGDriver/1.0"

    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/health":
            self._send(200, {"ok": True})
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/login":
            self._send(404, {"ok": False, "error": "not found"})
            return
        auth = self.headers.get("Authorization", "")
        if auth != f"Bearer {TOKEN}":
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                self._send(400, {"ok": False, "error": "invalid body"})
                return
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            username = str(body.get("username") or "")
            password = str(body.get("password") or "")
            if not username or not password or len(username) > 128:
                self._send(400, {"ok": False, "error": "invalid body"})
                return
        except (ValueError, UnicodeDecodeError):
            self._send(400, {"ok": False, "error": "invalid body"})
            return
        try:
            result = do_login(username, password)
            self._send(200, result)
        except Exception:  # noqa: BLE001 - static failure text only
            self._send(502, {"ok": False, "error": "login failed"})

    def log_message(self, *args) -> None:  # silence access logs (bodies never logged)
        return


def main() -> int:
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"ig_login_driver: listening on {BIND}:{PORT}", file=sys.stderr)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
