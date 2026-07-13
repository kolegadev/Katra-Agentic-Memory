"""Runtime configuration for the Katra memory hook."""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_MCP_URL = "http://localhost:3112/mcp"
DEFAULT_API_KEY = ""  # Must be configured via katra-hook.json — no default key
DEFAULT_USER_ID = "kolega-agent"
DEFAULT_TIMEOUT_SECONDS = 8
DEFAULT_MAX_CONTEXT_TOKENS = 5000
DEFAULT_CACHE_TTL_SECONDS = 30
DEFAULT_PERSONALITY = "balanced"
DEFAULT_SOURCES = ["reflection", "working_memory", "temporal_context", "vector_search", "temporal_recall"]

# When True, the active personality (profile + weight/scoring overrides +
# budget) is fetched from the Katra server's REST admin API and takes
# precedence over the local file values. This lets the dashboard steer
# personality centrally. Fail-open: if the server is unreachable, the
# locally-configured personality is used.
DEFAULT_SYNC_PERSONALITY_FROM_SERVER = True

# Legacy umbrella source names expanded to concrete retriever sources.
_SOURCE_EXPANSIONS = {
    "reflection": ["daily_reflection", "philosophical_insights", "unresolved_threads"],
}

# Module-level cache for the server-fetched personality config so we don't
# hit the REST API on every single prompt. (value, fetched_at) keyed by URL.
_SERVER_PERSONALITY_CACHE: dict[str, tuple[dict, float]] = {}
_SERVER_PERSONALITY_TTL_SECONDS = 60.0


def _expand_sources(sources: list[str]) -> list[str]:
    expanded: list[str] = []
    for source in sources:
        for concrete in _SOURCE_EXPANSIONS.get(source, [source]):
            if concrete not in expanded:
                expanded.append(concrete)
    return expanded


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
    # ── Personality (memory-disposition) settings ──────────────────
    # Named profile from personality.PROFILES ("balanced", "scholar",
    # "pragmatist", "strategist", "historian", "empath", "analyst",
    # "sentinel", "dreamer", "legacy").
    personality: str = DEFAULT_PERSONALITY
    # Optional per-source weight overrides on top of the named profile.
    source_weights: dict = None  # type: ignore[assignment]
    # Optional scoring parameter overrides (relevance_multiplier,
    # recency_half_life_days, budget_floors, max_single_source_pct,
    # vector_fetch_limit, vector_sample, min_fetch_weight).
    scoring: dict = None  # type: ignore[assignment]
    # When True, the dashboard-managed personality on the server overrides
    # the local personality/weights/scoring/budget (fail-open to local).
    sync_personality_from_server: bool = DEFAULT_SYNC_PERSONALITY_FROM_SERVER

    def __post_init__(self) -> None:
        raw_sources = list(self.sources) if self.sources else list(DEFAULT_SOURCES)
        object.__setattr__(self, "sources", _expand_sources(raw_sources))
        object.__setattr__(self, "source_weights", dict(self.source_weights or {}))
        object.__setattr__(self, "scoring", dict(self.scoring or {}))


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


def _rest_base_from_mcp(mcp_url: str) -> str | None:
    """Derive the Katra REST admin base URL from the MCP URL.

    MCP runs on 3112 (…/mcp); the REST admin API runs on 9012 (…/api/v1).
    We map the MCP host to the REST port so a single mcp_url configures both.
    Returns None if the URL can't be parsed.
    """
    try:
        from urllib.parse import urlparse

        parsed = urlparse(mcp_url)
        host = parsed.hostname or "localhost"
        scheme = parsed.scheme or "http"
        # Convention: MCP 3112 -> REST 9012. If a non-standard MCP port is
        # used, we still try 9012 (the fixed REST port in docker-compose).
        rest_port = int(os.environ.get("KATRA_REST_PORT", "9012"))
        return f"{scheme}://{host}:{rest_port}/api/v1"
    except Exception:
        return None


def _fetch_server_personality(cfg: BridgeConfig) -> dict | None:
    """Fetch the dashboard-managed personality config from the server.

    Cached for _SERVER_PERSONALITY_TTL_SECONDS. Fail-open: returns None on
    any error so the caller falls back to the local file config.
    """
    rest_base = _rest_base_from_mcp(cfg.mcp_url)
    if not rest_base:
        return None

    now = time.time()
    cached = _SERVER_PERSONALITY_CACHE.get(rest_base)
    if cached and (now - cached[1]) < _SERVER_PERSONALITY_TTL_SECONDS:
        return cached[0]

    url = f"{rest_base}/admin/personality"
    try:
        import httpx

        with httpx.Client(timeout=3.0) as client:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.json()
        if not isinstance(data, dict) or not data.get("success"):
            return None
        server_cfg = data.get("config") or {}
        _SERVER_PERSONALITY_CACHE[rest_base] = (server_cfg, now)
        return server_cfg
    except Exception as exc:  # noqa: BLE001 - fail open to local config
        logger.debug("Server personality fetch failed (using local): %s", exc)
        return None


def _apply_server_personality(cfg: BridgeConfig) -> BridgeConfig:
    """Return cfg with server-managed personality merged in (server wins).

    Only the personality dimensions are overridden; transport/auth/user
    settings always come from the local file. Fail-open to the given cfg.
    """
    if not cfg.sync_personality_from_server:
        return cfg

    server = _fetch_server_personality(cfg)
    if not server:
        return cfg

    personality = server.get("personality") or cfg.personality
    source_weights = server.get("source_weights")
    scoring = server.get("scoring")
    budget = server.get("max_context_tokens")

    if cfg.debug:
        logger.info("Personality synced from server: %s", personality)

    return BridgeConfig(
        mcp_url=cfg.mcp_url,
        api_key=cfg.api_key,
        user_id=cfg.user_id,
        shared_id=cfg.shared_id,
        enabled=cfg.enabled,
        timeout_seconds=cfg.timeout_seconds,
        max_context_tokens=int(budget) if isinstance(budget, (int, float)) else cfg.max_context_tokens,
        sources=list(cfg.sources),
        cache_ttl_seconds=cfg.cache_ttl_seconds,
        include_thinking=cfg.include_thinking,
        debug=cfg.debug,
        personality=personality,
        source_weights=dict(source_weights) if isinstance(source_weights, dict) else cfg.source_weights,
        scoring=dict(scoring) if isinstance(scoring, dict) else cfg.scoring,
        sync_personality_from_server=cfg.sync_personality_from_server,
    )


def load_config(path: Path | str | None = None) -> BridgeConfig:
    """Load configuration from disk, then optionally overlay the server-managed
    personality (dashboard-controlled). Falls back to sensible defaults."""
    target = Path(path) if path else config_path()
    if not target.exists():
        return _apply_server_personality(BridgeConfig())

    try:
        with open(target, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return _apply_server_personality(BridgeConfig())

    if not isinstance(data, dict):
        return _apply_server_personality(BridgeConfig())

    local = BridgeConfig(
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
        personality=_str(data.get("personality"), DEFAULT_PERSONALITY),
        source_weights=_dict(data.get("source_weights")),
        scoring=_dict(data.get("scoring")),
        sync_personality_from_server=bool(
            data.get("sync_personality_from_server", DEFAULT_SYNC_PERSONALITY_FROM_SERVER)
        ),
    )
    return _apply_server_personality(local)


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


def _dict(value: Any) -> dict:
    return dict(value) if isinstance(value, dict) else {}
