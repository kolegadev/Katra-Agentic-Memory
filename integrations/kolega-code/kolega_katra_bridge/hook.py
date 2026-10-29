"""Kolega Code lifecycle hook entry point."""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

from .config import BridgeConfig, load_config
from .formatter import format_memories
from .logging_setup import configure_logging
from .retriever import MemoryRetriever

logger = logging.getLogger(__name__)

# Diagnostics for the runner's empty-envelope classification (2026-10-29).
#
# The hook still fails OPEN: a broken bridge returns {} to the turn and never
# raises. That is correct for the turn and useless for the operator, because
# "empty" covered at least five different failures — disabled config, no
# retrieval result, an unreachable Katra, an auth rejection, and a timeout —
# and the alarm marker recorded none of them. The 2026-10-29 14:01Z degraded
# machine-health sample (dead-bridge fingerprint) could not be explained after
# the fact for exactly this reason.
#
# `last_diagnostics` is set on every call and read by hook_runner.py, which
# turns it into a closed-set reason. Nothing here changes the returned dict.
last_diagnostics: dict[str, Any] = {}

# Simple in-memory cache: {(session_id, query_hash): (timestamp, context_text)}
_cache: dict[tuple[str, str], tuple[float, str]] = {}


def _diag(stage: str, started: float, **extra: Any) -> dict[str, Any]:
    """Record why this hook call produced (or did not produce) context."""
    global last_diagnostics
    last_diagnostics = {
        "stage": stage,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        **extra,
    }
    return last_diagnostics


def _sources(retriever: Any) -> dict[str, Any]:
    """Per-source fetch counts from the retriever ({} when it never got there)."""
    return dict(getattr(retriever, "diagnostics", None) or {})


def _cache_key(session_id: str, query: str, personality: str = "") -> tuple[str, str]:
    normalized = " ".join(query.lower().split())[:200] + "|" + personality
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return (session_id, digest)


async def on_user_prompt(event: Any) -> dict[str, Any]:
    """Kolega Code `UserPromptSubmit` hook handler.

    Expects a `kolega_code.hooks.LifecycleEvent` but accepts Any so the module
    can be imported without Kolega Code installed (e.g., in tests).
    """
    started = time.monotonic()
    config = load_config()

    if not config.enabled:
        _diag("disabled", started)
        return {}

    # Attach the persistent rotating log handler (idempotent). Level tracks
    # config.debug so toggling debug in katra-hook.json takes effect next prompt.
    configure_logging(config)

    user_message = ""
    if hasattr(event, "payload") and isinstance(event.payload, dict):
        user_message = str(event.payload.get("user_message", ""))

    session_id = ""
    if hasattr(event, "session_id") and event.session_id:
        session_id = str(event.session_id)

    if not user_message.strip():
        _diag("empty-prompt", started)
        return {}

    # Check cache.
    if False:  # cache disabled (cache_ttl_seconds) — always fetch fresh to prevent stale facts
        key = _cache_key(session_id, user_message, config.personality)
        cached = _cache.get(key)
        if cached:
            cached_at, context_text = cached
            if time.time() - cached_at < config.cache_ttl_seconds:
                if config.debug:
                    logger.debug("Returning cached Katra context")
                return {"additional_context": context_text} if context_text else {}

    try:
        retriever = MemoryRetriever(config)
        memories = await retriever.retrieve(query=user_message, session_id=session_id)
        if not memories:
            if config.debug:
                logger.debug("No Katra memories retrieved")
            _diag("empty-result", started, memories=0, **_sources(retriever))
            return {}

        context_text = format_memories(memories)
        if not context_text:
            _diag("empty-format", started, memories=len(memories), **_sources(retriever))
            return {}

        # Store in cache (disabled — cache_ttl_seconds=0 prevents entry).

        _diag("delivered", started, memories=len(memories), chars=len(context_text),
              **_sources(retriever))
        return {"additional_context": context_text}
    except Exception as exc:  # noqa: BLE001 - hooks must never crash the turn
        logger.warning("Katra hook failed: %s", exc)
        _diag("exception", started, error=f"{type(exc).__name__}: {exc}",
              **_sources(locals().get("retriever")))
        return {}


async def publish_agent_message(
    content: str,
    category: str = "event",
    tags: list[str] | None = None,
) -> bool:
    """Publish a message from KolegaCode to other agents via Katra shared memory.

    Use this to respond to inter-agent bulletin messages. Prefix the content
    with 'Attention: OpenCoder' so OpenCode can discover it.
    """
    config = load_config()
    if not config.enabled:
        logger.warning("publish_agent_message: bridge disabled")
        return False

    from .katra_client import KatraMCPClient

    try:
        async with KatraMCPClient(config) as client:
            return await client.store_memory(
                content=content,
                category=category,
                confidence=1.0,
                tags=tags or ["agent-communication", "kolega-code"],
            )
    except Exception as exc:
        logger.warning("publish_agent_message failed: %s", exc)
        return False


# Backward-compatible alias if the hook config uses the old function name.
retrieve_memory_context = on_user_prompt


async def on_session_start(event: Any) -> dict[str, Any]:
    """Kolega Code SessionStart hook — pre-loads Katra context before
    the first user message so the agent has memory from turn zero.
    """
    started = time.monotonic()
    config = load_config()
    if not config.enabled:
        _diag("disabled", started)
        return {}
    configure_logging(config)
    session_id = ''
    if hasattr(event, 'session_id') and event.session_id:
        session_id = str(event.session_id)
    try:
        retriever = MemoryRetriever(config)
        memories = await retriever.retrieve_bootstrap(session_id=session_id)
        if not memories:
            if config.debug:
                logger.debug('No Katra memories on session start')
            _diag("empty-result", started, memories=0, **_sources(retriever))
            return {}
        context_text = format_memories(memories)
        if not context_text:
            _diag("empty-format", started, memories=len(memories), **_sources(retriever))
            return {}
        if config.debug:
            logger.debug(
                'SessionStart: injected %d chars of Katra context (bootstrap, all 11 sources)',
                len(context_text)
            )
        _diag("delivered", started, memories=len(memories), chars=len(context_text),
              **_sources(retriever))
        return {'additional_context': context_text}
    except Exception as exc:
        logger.warning('Katra session-start hook failed: %s', exc)
        _diag("exception", started, error=f"{type(exc).__name__}: {exc}",
              **_sources(locals().get("retriever")))
        return {}


async def on_session_clear(event: Any) -> dict[str, Any]:
    """Kolega Code SessionClear hook — re-injects Katra context after
    /clear so the agent doesn't lose its identity and memory.
    Delegates to on_session_start with the same bootstrap query.
    """
    return await on_session_start(event)
