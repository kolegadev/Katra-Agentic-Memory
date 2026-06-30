"""Runtime configuration for the Katra memory hook."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_MCP_URL = "http://localhost:3112/mcp"
DEFAULT_API_KEY = ""  # Must be configured via katra-hook.json — no default key
DEFAULT_USER_ID = "kolega-agent"
DEFAULT_TIMEOUT_SECONDS = 8
DEFAULT_MAX_CONTEXT_TOKENS = 2500
DEFAULT_CACHE_TTL_SECONDS = 30
DEFAULT_SOURCES = ["reflection", "working_memory", "temporal_context", "vector_search", "temporal_recall"]


@dataclass(frozen=True)
class BridgeConfig:
    """Loaded configuration for the Katra retrieval hook."""

    mcp_url: str = DEFAULT_MCP_URL
    api_key: str = DEFAULT_API_KEY
    user_id: str = DEFAULT_USER_ID
    shared_id: str = ""
    enabled: bool = True
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    max_context_tokens: int = DEFAULT_MAX_CONTEXT_TOKENS
    sources: list[str] = None  # type: ignore[assignment]
    cache_ttl_seconds: float = DEFAULT_CACHE_TTL_SECONDS
    include_thinking: bool = False
    debug: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "sources", list(self.sources) if self.sources else list(DEFAULT_SOURCES)
        )


def _default_state_dir() -> Path:
    if os.environ.get("KOLEGA_CODE_STATE_DIR"):
        return Path(os.environ["KOLEGA_CODE_STATE_DIR"]).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "kolega-code"
    if sys.platform.startswith("win"):
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / "kolega-code"
    return Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "kolega-code"


def config_path() -> Path:
    """Return the path to the runtime config file."""
    env_path = os.environ.get("KOLEGA_KATRA_HOOK_CONFIG")
    if env_path:
        return Path(env_path).expanduser()
    return _default_state_dir() / "katra-hook.json"


def load_config(path: Path | str | None = None) -> BridgeConfig:
    """Load configuration from disk, falling back to sensible defaults."""
    target = Path(path) if path else config_path()
    if not target.exists():
        return BridgeConfig()

    try:
        with open(target, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return BridgeConfig()

    if not isinstance(data, dict):
        return BridgeConfig()

    return BridgeConfig(
        mcp_url=_str(data.get("mcp_url"), DEFAULT_MCP_URL),
        api_key=_str(data.get("api_key"), DEFAULT_API_KEY),
        user_id=_str(data.get("user_id"), DEFAULT_USER_ID),
        shared_id=_str(data.get("shared_id"), ""),
        enabled=bool(data.get("enabled", True)),
        timeout_seconds=_float(data.get("timeout_seconds"), DEFAULT_TIMEOUT_SECONDS),
        max_context_tokens=_int(data.get("max_context_tokens"), DEFAULT_MAX_CONTEXT_TOKENS),
        sources=_list_str(data.get("sources"), DEFAULT_SOURCES),
        cache_ttl_seconds=_float(data.get("cache_ttl_seconds"), DEFAULT_CACHE_TTL_SECONDS),
        include_thinking=bool(data.get("include_thinking", False)),
        debug=bool(data.get("debug", False)),
    )


def _str(value: Any, default: str) -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text if text else default


def _float(value: Any, default: float) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _int(value: Any, default: int) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _list_str(value: Any, default: list[str]) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value if v is not None]
    return list(default)
