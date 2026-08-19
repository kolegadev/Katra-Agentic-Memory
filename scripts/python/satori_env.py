"""
Lightweight .env loader for Katra Python services.

No external dependency (python-dotenv is not installed on the runtime). Loads
KEY=VALUE pairs from the project .env into a dict and exposes a getenv() that
prefers the real process environment, then the .env file, then a default.

Resolution order for get_key(name):
  1. os.environ[name]              (explicit env / launchd override)
  2. parsed value from .env        (project-local secrets, gitignored)
  3. provided default

The .env location is resolved relative to this file (scripts/python/../../.env),
and can be overridden with the KATRA_ENV_FILE environment variable.
"""
from __future__ import annotations

import os
from pathlib import Path

_DEFAULT_ENV = Path(__file__).resolve().parents[2] / ".env"


def _parse_env_file(path: Path) -> dict[str, str]:
    data: dict[str, str] = {}
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key:
                data[key] = val
    except FileNotFoundError:
        pass
    except Exception:
        # Never let config parsing crash a service; fall back to os.environ.
        pass
    return data


_ENV_PATH = Path(os.environ.get("KATRA_ENV_FILE", str(_DEFAULT_ENV)))
_FILE_ENV = _parse_env_file(_ENV_PATH)


def get_key(name: str, default: str = "") -> str:
    """Return a config value: os.environ > .env file > default."""
    if name in os.environ and os.environ[name] != "":
        return os.environ[name]
    if name in _FILE_ENV and _FILE_ENV[name] != "":
        return _FILE_ENV[name]
    return default
