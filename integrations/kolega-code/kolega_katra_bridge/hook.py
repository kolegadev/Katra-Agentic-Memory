"""Kolega Code lifecycle hook entry point."""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

from .config import BridgeConfig, load_config
from .formatter import format_memories
from .retriever import MemoryRetriever

logger = logging.getLogger(__name__)

# Simple in-memory cache: {(session_id, query_hash): (timestamp, context_text)}
_cache: dict[tuple[str, str], tuple[float, str]] = {}


def _cache_key(session_id: str, query: str) -> tuple[str, str]:
    normalized = " ".join(query.lower().split())[:200]
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return (session_id, digest)


async def on_user_prompt(event: Any) -> dict[str, Any]:
    """Kolega Code `UserPromptSubmit` hook handler.

    Expects a `kolega_code.hooks.LifecycleEvent` but accepts Any so the module
    can be imported without Kolega Code installed (e.g., in tests).
    """
    config = load_config()

    if not config.enabled:
        return {}

    if config.debug:
        logging.basicConfig(level=logging.DEBUG)

    user_message = ""
    if hasattr(event, "payload") and isinstance(event.payload, dict):
        user_message = str(event.payload.get("user_message", ""))

    session_id = ""
    if hasattr(event, "session_id") and event.session_id:
        session_id = str(event.session_id)

    if not user_message.strip():
        return {}

    # Check cache.
    if config.cache_ttl_seconds > 0 and session_id:
        key = _cache_key(session_id, user_message)
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
            return {}

        context_text = format_memories(memories)
        if not context_text:
            return {}

        # Store in cache.
        if config.cache_ttl_seconds > 0 and session_id:
            _cache[_cache_key(session_id, user_message)] = (time.time(), context_text)

        return {"additional_context": context_text}
    except Exception as exc:  # noqa: BLE001 - hooks must never crash the turn
        logger.warning("Katra hook failed: %s", exc)
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
