#!/usr/bin/env python3
"""Inventory stale DeepSeek model-id references across a machine.

Canonical target id: deepseek-flash (DeepSeek-V4.1-Flash).
Stale: deepseek-v4-pro, deepseek-v4-flash[-*], deepseek-v4.1-flash*, deepseek-chat,
deepseek-reasoner, deepseek-coder, deepseek-v3*, deepseek-r1*.

Usage: scan_stale_models.py <root> [<root> ...]
Writes full detail to /tmp/stale-models-<host>.txt and prints a compact summary.
"""
from __future__ import annotations

import os
import re
import socket
import sys
from collections import Counter, defaultdict

TOKEN_RE = re.compile(r"deepseek-[A-Za-z0-9][A-Za-z0-9._-]*", re.IGNORECASE)
TARGET = "deepseek-flash"

SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", ".cache",
    ".mypy_cache", ".pytest_cache", "site-packages", "diagnostics", "dist",
    "build", ".next", "target", ".terraform", ".tox", ".ruff_cache",
}
# Measurement output / session logs / model caches are not "usage".
DATA_HINTS = ("/results/", "/data/", "/exports/", "/fixtures/", "/.ollama/",
              "/.openclaw/", "/logs/", "/tmp/")
TEXT_EXT = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".sh", ".bash",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
    ".md", ".txt", ".service", ".plist", ".xml", ".html", ".vue", ".rs",
    ".go", ".java", ".rb", ".sql", ".mdc",
}
CONFIG_NAMES = {"settings.json", "config.json", "config.yaml", "config.yml",
                ".env", "loop.env", "wake-env.sh", "compose.yaml",
                "docker-compose.yml", "docker-compose.yaml", ".bashrc",
                ".zshrc", ".profile", "crontab"}
MAX_BYTES = 2_000_000


def classify(path: str) -> str:
    low = path.lower()
    base = os.path.basename(path)
    if base in CONFIG_NAMES or "settings.json" in base:
        return "CONFIG"
    if any(hint in low for hint in DATA_HINTS):
        return "data"
    if low.endswith(".md") or "/docs/" in low or "/doc/" in low:
        return "doc"
    if base.endswith(".jsonl"):
        return "data"
    return "code"


def scan(root: str, detail: list[str], per_token: Counter,
         per_class: dict[str, list[str]]) -> None:
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if ext and ext not in TEXT_EXT:
                continue
            path = os.path.join(dirpath, name)
            try:
                if os.path.getsize(path) > MAX_BYTES:
                    continue
                with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                    text = fh.read()
            except OSError:
                continue
            if "deepseek" not in text.lower():
                continue
            kind = classify(path)
            for i, line in enumerate(text.splitlines(), 1):
                for m in TOKEN_RE.finditer(line):
                    tok = m.group(0).lower()
                    per_token[tok] += 1
                    per_class[kind].append(f"{path}:{i}:{tok}")
                    detail.append(f"[{kind}] {path}:{i}: {line.strip()[:220]}")


def main() -> int:
    roots = sys.argv[1:]
    if not roots:
        print(__doc__)
        return 2
    host = socket.gethostname().split(".")[0]
    detail: list[str] = []
    per_token: Counter = Counter()
    per_class: dict[str, list[str]] = defaultdict(list)
    for root in roots:
        root = os.path.expanduser(root)
        if os.path.exists(root):
            scan(root, detail, per_token, per_class)

    out = f"/tmp/stale-models-{host}.txt"
    with open(out, "w") as fh:
        fh.write("\n".join(detail) + "\n")

    print(f"host={host}  report={out}  lines={len(detail)}")
    print("\n-- tokens seen (count) --")
    for tok, n in per_token.most_common():
        flag = "" if tok == TARGET else "  <-- STALE"
        print(f"  {tok:52s} {n:5d}{flag}")
    print("\n-- by class --")
    for kind in ("CONFIG", "code", "doc", "data"):
        rows = per_class.get(kind, [])
        files = sorted({r.rsplit(":", 2)[0] for r in rows})
        print(f"  {kind}: {len(rows)} refs in {len(files)} files")
    print("\n-- CONFIG + code refs (actionable) --")
    for kind in ("CONFIG", "code"):
        for ref in per_class.get(kind, []):
            print(f"  [{kind}] {ref}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
