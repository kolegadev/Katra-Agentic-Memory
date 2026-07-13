"""Retrieval orchestrator: fetch, rank, dedupe, and budget Katra memories.

v2 — personality-weighted retrieval. Key changes vs v1 (see
IMPLEMENTATION-PLAN.md for full rationale and change log):

  1. Source weights come from a named PersonalityProfile instead of a
     hard-coded table; per-source weights are the mechanism by which an
     agent's long-term disposition ("personality") is tuned.
  2. Cue-driven scoring: composite = weight * (1 + k*vector + recency),
     with k (relevance_multiplier) defaulting to 2.0 so a strongly
     relevant memory of any type can outrank a high-weight source.
  3. Power-law recency (1 / (1 + age/half_life)) replaces the 30-day
     linear cliff; half-life is a personality parameter.
  4. Token budget now has per-source floors (guaranteed minimum share)
     and a per-source cap (homeostatic limit on any single source).
  5. Fetches run concurrently via asyncio.gather (v1 was sequential
     despite the docs saying "parallel").
  6. Reflection is split into daily_reflection / philosophical_insights
     / unresolved_threads; emotional_context, missions and
     knowledge_graph are new optional sources.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import random
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from .config import BridgeConfig
from .katra_client import KatraMCPClient, MemoryItem
from .personality import PersonalityProfile, resolve_profile

logger = logging.getLogger(__name__)

# Rough token estimation: ~4 characters per token for English text.
CHARS_PER_TOKEN = 4

# Max entities probed for emotional_context per prompt (naive extraction).
MAX_EMOTIONAL_ENTITIES = 2


class MemoryRetriever:
    """Fetches relevant memories from Katra within a token budget."""

    def __init__(self, config: BridgeConfig) -> None:
        self.config = config
        self.profile: PersonalityProfile = resolve_profile(
            config.personality,
            weight_overrides=config.source_weights,
            scoring_overrides=config.scoring,
        )

    async def retrieve(
        self,
        query: str,
        session_id: str,
    ) -> list[MemoryItem]:
        """Return a ranked, deduplicated, token-budgeted list of memories."""
        if not self.config.enabled:
            return []

        sources = set(self.config.sources)
        profile = self.profile

        def active(source: str) -> bool:
            return source in sources and profile.should_fetch(source)

        async with KatraMCPClient(self.config) as client:
            tasks: list[tuple[str, Awaitable[list[MemoryItem]]]] = []

            # ── Inter-agent message scan (always runs — operational) ──
            tasks.append(("agent_message", self._fetch_agent_messages(client)))

            # ── Reflection family (sleep consolidation outputs) ──
            if active("daily_reflection"):
                tasks.append(("daily_reflection", client.get_daily_reflection("daily")))
            if active("philosophical_insights"):
                tasks.append(
                    ("philosophical_insights", client.get_philosophical_insights(limit=5))
                )
            if active("unresolved_threads"):
                tasks.append(("unresolved_threads", client.get_unresolved_threads()))

            # ── Present-focus sources ──
            if active("working_memory"):
                tasks.append(
                    ("working_memory", client.get_working_memory(session_id, limit=20))
                )
            if active("temporal_context"):
                tasks.append(("temporal_context", client.get_temporal_context(session_id)))

            # ── Cue-driven semantic retrieval ──
            if active("vector_search") and query.strip():
                tasks.append(
                    ("vector_search", client.vector_search(query, limit=profile.vector_fetch_limit))
                )

            # ── Episodic recall ──
            if active("temporal_recall"):
                now = datetime.now(timezone.utc)
                from_dt = now - timedelta(days=7)
                tasks.append(
                    (
                        "temporal_recall",
                        client.temporal_recall(from_dt.isoformat(), now.isoformat(), limit=10),
                    )
                )

            # ── New personality sources ──
            if active("missions"):
                tasks.append(("missions", client.list_missions(limit=5)))
            if active("knowledge_graph") and query.strip():
                tasks.append(("knowledge_graph", client.explore_graph(query, limit=10)))
            if active("emotional_context"):
                for entity in _extract_entities(query)[:MAX_EMOTIONAL_ENTITIES]:
                    tasks.append(("emotional_context", client.get_emotional_context(entity)))

            fetched = await self._gather(tasks)

        if self.config.debug:
            by_source: dict[str, int] = {}
            for item in fetched:
                by_source[item.source] = by_source.get(item.source, 0) + 1
            logger.info(
                "Katra fetch [personality=%s]: %s", profile.name, by_source
            )

        ranked = self._rank_and_dedupe(fetched, query)
        return self._apply_token_budget(ranked)

    async def _gather(
        self, tasks: list[tuple[str, Awaitable[list[MemoryItem]]]]
    ) -> list[MemoryItem]:
        """Run all fetches concurrently; fail open per-source."""
        results = await asyncio.gather(
            *(coro for _, coro in tasks), return_exceptions=True
        )
        fetched: list[MemoryItem] = []
        for (source, _), result in zip(tasks, results):
            if isinstance(result, BaseException):
                logger.warning("%s retrieval failed: %s", source, result)
                continue
            fetched.extend(result)
        return fetched

    async def _fetch_agent_messages(self, client: KatraMCPClient) -> list[MemoryItem]:
        """Inter-agent message scan (independent of user query).

        Prefers search_memories (works while embeddings load), falls back
        to vector_search. Items are retagged source=agent_message so the
        formatter surfaces them as the bulletin.
        """
        try:
            messages = await client.search_memories(
                '"Attention: KolegaCode" OR "Attention: KolegaCoder" OR "FROM: OpenCode"',
                limit=5,
            )
        except Exception:
            messages = await client.vector_search(
                "Attention: KolegaCoder OR TASK FOR KOLEGACODER",
                limit=5,
            )
        return [
            MemoryItem(
                source="agent_message",
                content=msg.content,
                metadata={**msg.metadata, "is_agent_message": True},
                score=msg.score,
            )
            for msg in messages
        ]

    def _rank_and_dedupe(self, items: list[MemoryItem], query: str) -> list[MemoryItem]:
        """Remove near-duplicates, drop empty placeholders, and rank."""
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

        # Optional loose-association sampling ("dreamer"): keep 5 of the
        # fetched vector candidates, sampled with probability ∝ score, so
        # adjacent-but-not-nearest memories can surface.
        if self.profile.vector_sample:
            unique = _sample_vector_candidates(unique, keep=5)

        # Composite score: weight * (1 + k*relevance + recency).
        # The weight sets the personality's default disposition; k lets a
        # strongly relevant memory of any type break through it.
        now = datetime.now(timezone.utc)
        k = self.profile.relevance_multiplier
        half_life = self.profile.recency_half_life_days
        scored: list[tuple[float, MemoryItem]] = []
        for item in unique:
            source_weight = self.profile.weight_for(item.source)
            vector_score = item.score if item.score else 0.0
            recency_score = _recency_score(item.metadata, now, half_life)
            composite = source_weight * (1.0 + k * vector_score + recency_score)
            scored.append((composite, item))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [item for _, item in scored]

    def _apply_token_budget(self, items: list[MemoryItem]) -> list[MemoryItem]:
        """Select items within budget using a three-pass strategy.

        Pass 1 — agent_message items are admitted first (operational).
        Pass 2 — budget floors: each floored source gets its top-ranked
                 items admitted until its guaranteed share is met, so a
                 personality skew can never fully evict task context.
        Pass 3 — remaining budget filled by global rank, with a
                 homeostatic per-source cap (max_single_source_pct of the
                 total budget; agent_message exempt) that prevents any
                 single memory system from monopolising context — the
                 guard against self-reinforcing rumination loops.
        Final order is by rank, regardless of admission pass.
        """
        budget = self.config.max_context_tokens
        cap_tokens = int(budget * self.profile.max_single_source_pct)
        used = 0
        used_by_source: dict[str, int] = {}
        admitted: set[int] = set()  # indices into `items` (rank order)

        def tokens(item: MemoryItem) -> int:
            return max(1, len(item.content) // CHARS_PER_TOKEN)

        def admit(idx: int, item: MemoryItem) -> None:
            nonlocal used
            admitted.add(idx)
            t = tokens(item)
            used += t
            used_by_source[item.source] = used_by_source.get(item.source, 0) + t

        # Pass 1: agent messages first.
        for idx, item in enumerate(items):
            if item.source != "agent_message":
                continue
            if used + tokens(item) > budget and admitted:
                break
            admit(idx, item)

        # Pass 2: satisfy per-source floors (in rank order within source).
        for source, floor_pct in self.profile.budget_floors.items():
            floor_tokens = int(budget * floor_pct)
            for idx, item in enumerate(items):
                if idx in admitted or item.source != source:
                    continue
                if used_by_source.get(source, 0) >= floor_tokens:
                    break
                if used + tokens(item) > budget:
                    break
                admit(idx, item)

        # Pass 3: fill remaining budget by global rank, respecting caps.
        for idx, item in enumerate(items):
            if idx in admitted:
                continue
            t = tokens(item)
            if used + t > budget:
                if admitted:
                    continue  # try smaller lower-ranked items
            if (
                item.source != "agent_message"
                and used_by_source.get(item.source, 0) + t > cap_tokens
            ):
                continue  # homeostatic cap
            if used + t > budget and admitted:
                continue
            admit(idx, item)

        result = [item for idx, item in enumerate(items) if idx in admitted]

        if self.config.debug and result:
            logger.info(
                "Injecting %d Katra memories (~%d tokens) [personality=%s, per-source=%s]",
                len(result),
                used,
                self.profile.name,
                used_by_source,
            )
        return result


def _sample_vector_candidates(items: list[MemoryItem], keep: int) -> list[MemoryItem]:
    """Score-weighted random sampling of vector_search candidates."""
    vector_items = [i for i in items if i.source == "vector_search"]
    if len(vector_items) <= keep:
        return items
    others = [i for i in items if i.source != "vector_search"]
    weights = [max(0.05, i.score or 0.05) for i in vector_items]
    chosen: list[MemoryItem] = []
    pool = list(zip(vector_items, weights))
    for _ in range(keep):
        total = sum(w for _, w in pool)
        r = random.uniform(0, total)
        acc = 0.0
        for j, (item, w) in enumerate(pool):
            acc += w
            if r <= acc:
                chosen.append(item)
                pool.pop(j)
                break
    return others + chosen


def _extract_entities(query: str) -> list[str]:
    """Naive entity extraction for emotional_context probing (v1 heuristic).

    Takes quoted phrases and Capitalised tokens (excluding sentence-initial
    stop words). Good enough to seed get_emotional_context; replace with
    graph-assisted extraction later (see plan, Phase 3 follow-ups).
    """
    entities: list[str] = []
    for match in re.findall(r'"([^"]{2,60})"', query):
        entities.append(match.strip())
    stop = {"i", "the", "a", "an", "this", "that", "what", "why", "how", "when",
            "where", "who", "can", "could", "should", "please", "let", "ok", "okay"}
    for match in re.findall(r"\b([A-Z][A-Za-z0-9_-]{2,30})\b", query):
        if match.lower() in stop:
            continue
        if match not in entities:
            entities.append(match)
    return entities


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


def _recency_score(metadata: dict[str, Any], now: datetime, half_life_days: float) -> float:
    """Power-law recency: 1.0 for now, 0.5 at one half-life, long tail.

    Replaces the previous 30-day linear decay — human forgetting curves are
    closer to power laws, and the linear version created a hard cliff where
    a 31-day-old memory scored identically to a 3-year-old one.
    """
    for key in ("created_at", "timestamp", "stored_at", "updated_at", "occurred_at"):
        raw = metadata.get(key)
        if not raw:
            continue
        try:
            dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            age_days = max(0.0, (now - dt).total_seconds() / 86400.0)
            return 1.0 / (1.0 + age_days / max(0.5, half_life_days))
        except (ValueError, TypeError):
            continue
    return 0.0
