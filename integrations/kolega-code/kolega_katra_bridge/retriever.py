"""Retrieval orchestrator: fetch, rank, dedupe, and budget Katra memories."""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from .config import BridgeConfig
from .katra_client import KatraMCPClient, MemoryItem

logger = logging.getLogger(__name__)

# Rough token estimation: ~4 characters per token for English text.
CHARS_PER_TOKEN = 4

# Source priority weights (higher = preferred when scores tie).
SOURCE_WEIGHTS = {
    "working_memory": 3.0,
    "temporal_context": 2.5,
    "vector_search": 2.0,
    "temporal_recall": 1.0,
}


class MemoryRetriever:
    """Fetches relevant memories from Katra within a token budget."""

    def __init__(self, config: BridgeConfig) -> None:
        self.config = config

    async def retrieve(
        self,
        query: str,
        session_id: str,
    ) -> list[MemoryItem]:
        """Return a ranked, deduplicated, token-budgeted list of memories."""
        if not self.config.enabled:
            return []

        async with KatraMCPClient(self.config) as client:
            sources = set(self.config.sources)
            fetched: list[MemoryItem] = []

            # Always fetch working memory first (cheap + session-specific).
            if "working_memory" in sources:
                try:
                    fetched.extend(await client.get_working_memory(session_id, limit=20))
                except Exception as exc:  # noqa: BLE001 - fail open
                    logger.warning("working_memory retrieval failed: %s", exc)

            # Fetch temporal context if configured.
            if "temporal_context" in sources:
                try:
                    fetched.extend(await client.get_temporal_context(session_id))
                except Exception as exc:  # noqa: BLE001
                    logger.warning("temporal_context retrieval failed: %s", exc)

            # Fetch vector search results for the current prompt.
            if "vector_search" in sources and query.strip():
                try:
                    fetched.extend(await client.vector_search(query, limit=5))
                except Exception as exc:  # noqa: BLE001
                    logger.warning("vector_search retrieval failed: %s", exc)

            # Fetch recent episodic events.
            if "temporal_recall" in sources:
                now = datetime.now(timezone.utc)
                from_dt = now - timedelta(days=7)
                try:
                    fetched.extend(
                        await client.temporal_recall(
                            from_dt.isoformat(),
                            now.isoformat(),
                            limit=10,
                        )
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("temporal_recall retrieval failed: %s", exc)

        ranked = self._rank_and_dedupe(fetched)
        return self._apply_token_budget(ranked)

    def _rank_and_dedupe(self, items: list[MemoryItem]) -> list[MemoryItem]:
        """Remove near-duplicates, drop empty placeholders, and rank by relevance."""
        seen_hashes: set[str] = set()
        unique: list[MemoryItem] = []

        for item in items:
            content = item.content.strip()
            if not content:
                continue
            if _is_empty_placeholder(content):
                continue

            # Cap individual item length to prevent one huge transcript from
            # consuming the entire context budget.
            max_chars = 8000
            if len(content) > max_chars:
                content = content[:max_chars] + "\n\n... [truncated]"
                item = MemoryItem(
                    source=item.source,
                    content=content,
                    metadata=item.metadata,
                    score=item.score,
                )

            normalized = _normalize_for_dedupe(content)
            digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
            if digest in seen_hashes:
                continue
            seen_hashes.add(digest)
            unique.append(item)

        # Sort by composite score: source weight * (vector score + recency bonus).
        now = datetime.now(timezone.utc)
        scored: list[tuple[float, MemoryItem]] = []
        for item in unique:
            source_weight = SOURCE_WEIGHTS.get(item.source, 1.0)
            vector_score = item.score if item.score else 0.0
            recency_score = _recency_score(item.metadata, now)
            composite = source_weight * (1.0 + vector_score + recency_score)
            scored.append((composite, item))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [item for _, item in scored]

    def _apply_token_budget(self, items: list[MemoryItem]) -> list[MemoryItem]:
        """Truncate the list so the formatted context stays under budget."""
        budget = self.config.max_context_tokens
        result: list[MemoryItem] = []
        used_tokens = 0

        for item in items:
            item_tokens = max(1, len(item.content) // CHARS_PER_TOKEN)
            if used_tokens + item_tokens > budget and result:
                break
            result.append(item)
            used_tokens += item_tokens

        if self.config.debug and result:
            logger.info(
                "Injecting %d Katra memories (~%d tokens)",
                len(result),
                used_tokens,
            )
        return result


def _normalize_for_dedupe(text: str) -> str:
    """Create a stable, content-focused key for deduplication."""
    collapsed = " ".join(text.lower().split())
    return collapsed[:500]


def _is_empty_placeholder(content: str) -> bool:
    """Return True when the Katra tool result header itself reports no data.

    We only inspect the leading portion of the response; a long memory may
    legitimately contain phrases like "0 events" inside its body and must not
    be dropped.
    """
    # Only look at the first ~600 chars where Katra puts the result summary.
    header = content[:600].lower()
    for char in "*_`#":
        header = header.replace(char, " ")
    header = " ".join(header.split())

    empty_markers = [
        "items: 0",
        "0 items",
        "0 events",
        "0 results",
        "0 memories",
        "no events found",
        "no results found",
        "no memories found",
    ]
    return any(marker in header for marker in empty_markers)


def _recency_score(metadata: dict[str, Any], now: datetime) -> float:
    """Return a small bonus for memories that are newer."""
    for key in ("created_at", "timestamp", "stored_at", "updated_at", "occurred_at"):
        raw = metadata.get(key)
        if not raw:
            continue
        try:
            dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            age_days = (now - dt).total_seconds() / 86400.0
            # 1.0 for today, decaying toward 0 over 30 days.
            return max(0.0, 1.0 - (age_days / 30.0))
        except (ValueError, TypeError):
            continue
    return 0.0
