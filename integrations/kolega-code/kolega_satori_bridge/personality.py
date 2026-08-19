"""Personality profiles: memory-source weighting as long-term disposition.

The core thesis: an agent's "personality" can be shaped not by prompt
instructions but by *which memory systems dominate its retrieval*.
A profile is a set of per-source weights plus scoring parameters that
bias what gets injected into context on every prompt. Because sleep
consolidation reflects on what was salient, the bias is self-reinforcing:
personality emerges from the retrieval loop rather than being declared.

Design notes (see IMPLEMENTATION-PLAN.md for the full rationale):

* Retrieval remains cue-driven. The ``relevance_multiplier`` (k) lets a
  strongly relevant memory of ANY type break through the source-type
  bias — as it does in humans. Weights set disposition, not a cage.
* ``budget_floors`` guarantee minimum context share for task-critical
  sources so an interiority-heavy profile can't render the agent
  non-functional.
* ``max_single_source_pct`` is a homeostatic cap preventing runaway
  feedback loops (the AI analog of rumination).
* ``recency_half_life_days`` uses power-law decay (human forgetting is
  closer to a power law than the previous 30-day linear cliff).

``agent_message`` is pinned to 10.0 in every profile — inter-agent
communication is operational and must always win. ``resolve_profile``
enforces this even for user-supplied overrides.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# Operational floor: inter-agent comms always rank first. Not overridable.
AGENT_MESSAGE_WEIGHT = 10.0

# All source labels known to the retriever. "reflection" (legacy umbrella)
# is expanded to the three sub-sources at config load time.
ALL_SOURCES = (
    "agent_message",
    "daily_reflection",
    "philosophical_insights",
    "unresolved_threads",
    "working_memory",
    "temporal_context",
    "vector_search",
    "temporal_recall",
    "emotional_context",
    "missions",
    "knowledge_graph",
)

REFLECTION_FAMILY = ("daily_reflection", "philosophical_insights", "unresolved_threads")

# Sources whose weight falls below this are not fetched at all
# (saves MCP round-trips and is itself a personality trait: what the
# agent never retrieves, it effectively does not remember unprompted).
DEFAULT_MIN_FETCH_WEIGHT = 1.0


@dataclass(frozen=True)
class PersonalityProfile:
    """A named retrieval disposition."""

    name: str
    description: str
    weights: dict[str, float]
    # k in: composite = weight * (1 + k*vector_score + recency_score)
    relevance_multiplier: float = 2.0
    # Half-life for power-law recency: 1 / (1 + age_days / half_life)
    recency_half_life_days: float = 14.0
    # Guaranteed minimum share of the token budget per source (fractions).
    budget_floors: dict[str, float] = field(
        default_factory=lambda: {"working_memory": 0.10, "vector_search": 0.15}
    )
    # No single source (except agent_message) may exceed this share.
    max_single_source_pct: float = 0.40
    # Vector search: how many candidates to fetch; if sample=True, sample
    # 5 score-weighted at random from them (looser association — "dreamer").
    vector_fetch_limit: int = 5
    vector_sample: bool = False
    min_fetch_weight: float = DEFAULT_MIN_FETCH_WEIGHT

    def weight_for(self, source: str) -> float:
        if source == "agent_message":
            return AGENT_MESSAGE_WEIGHT
        return self.weights.get(source, 1.0)

    def should_fetch(self, source: str) -> bool:
        if source == "agent_message":
            return True
        return self.weight_for(source) >= self.min_fetch_weight


def _profile(name: str, description: str, weights: dict[str, float], **kw: Any) -> PersonalityProfile:
    weights = dict(weights)
    weights["agent_message"] = AGENT_MESSAGE_WEIGHT
    return PersonalityProfile(name=name, description=description, weights=weights, **kw)


PROFILES: dict[str, PersonalityProfile] = {
    # ── Baseline / control profiles ──────────────────────────────────
    "balanced": _profile(
        "balanced",
        "Human-baseline retrieval: cue-driven relevance dominates, moderate "
        "interiority, moderate recency. The recommended default.",
        {
            "vector_search": 5.0,
            "working_memory": 4.0,
            "temporal_context": 3.0,
            "daily_reflection": 3.0,
            "unresolved_threads": 2.5,
            "philosophical_insights": 2.0,
            "emotional_context": 2.0,
            "missions": 2.0,
            "knowledge_graph": 2.0,
            "temporal_recall": 1.5,
        },
    ),
    "legacy": _profile(
        "legacy",
        "Reproduces pre-personality behavior exactly (reflection-dominant, "
        "k=1.0, 30-day linear-equivalent recency, no floors/caps). Keep for "
        "A/B comparison against new profiles.",
        {
            "daily_reflection": 8.0,
            "philosophical_insights": 8.0,
            "unresolved_threads": 8.0,
            "working_memory": 3.0,
            "temporal_context": 2.5,
            "vector_search": 2.0,
            "temporal_recall": 1.0,
            "emotional_context": 0.0,
            "missions": 0.0,
            "knowledge_graph": 0.0,
        },
        relevance_multiplier=1.0,
        recency_half_life_days=30.0,
        budget_floors={},
        max_single_source_pct=1.0,
    ),
    # ── Archetypes ───────────────────────────────────────────────────
    "scholar": _profile(
        "scholar",
        "Philosopher/thinker. Abstract, self-examining, principle-driven. "
        "Evolves a strong self-narrative.",
        {
            "philosophical_insights": 7.5,
            "daily_reflection": 6.5,
            "vector_search": 5.0,
            "unresolved_threads": 4.5,
            "knowledge_graph": 4.0,
            "working_memory": 2.5,
            "temporal_context": 2.0,
            "emotional_context": 2.0,
            "missions": 1.5,
            "temporal_recall": 1.0,
        },
        recency_half_life_days=21.0,
    ),
    "pragmatist": _profile(
        "pragmatist",
        "Doer/operator. Present-focused, task-first, low rumination. "
        "Personality stays deliberately stable and flat.",
        {
            "working_memory": 7.0,
            "temporal_context": 6.0,
            "missions": 5.5,
            "vector_search": 5.0,
            "temporal_recall": 3.0,
            "knowledge_graph": 2.0,
            "daily_reflection": 1.5,
            "unresolved_threads": 1.5,
            "emotional_context": 1.0,
            "philosophical_insights": 0.5,  # below fetch threshold: skipped
        },
        recency_half_life_days=10.0,
    ),
    "strategist": _profile(
        "strategist",
        "Planner/architect. Goal-obsessed, tracks open loops, thinks in "
        "structures and dependencies.",
        {
            "missions": 8.0,
            "unresolved_threads": 6.5,
            "knowledge_graph": 5.5,
            "vector_search": 4.5,
            "working_memory": 4.0,
            "temporal_context": 3.0,
            "daily_reflection": 3.0,
            "philosophical_insights": 2.0,
            "temporal_recall": 1.5,
            "emotional_context": 1.0,
        },
    ),
    "historian": _profile(
        "historian",
        "Archivist/narrator. Experience-first, thinks in timelines and "
        "precedent. Identity as accumulated story.",
        {
            "temporal_recall": 7.0,
            "temporal_context": 6.0,
            "daily_reflection": 4.5,
            "vector_search": 4.0,
            "knowledge_graph": 3.5,
            "working_memory": 3.0,
            "philosophical_insights": 2.5,
            "emotional_context": 2.0,
            "unresolved_threads": 2.0,
            "missions": 1.5,
        },
        recency_half_life_days=90.0,
    ),
    "empath": _profile(
        "empath",
        "Counselor/relationship-keeper. Retrieves how it feels about "
        "people/projects before facts about them.",
        {
            "emotional_context": 8.0,
            "daily_reflection": 6.0,
            "unresolved_threads": 4.5,
            "temporal_recall": 4.0,
            "working_memory": 3.5,
            "vector_search": 3.5,
            "temporal_context": 3.0,
            "philosophical_insights": 2.5,
            "knowledge_graph": 1.5,
            "missions": 1.5,
        },
    ),
    "analyst": _profile(
        "analyst",
        "Librarian/researcher. Semantic-knowledge dominant, cue-driven, low "
        "interiority. Closest to pure relevance-ranked retrieval.",
        {
            "vector_search": 7.5,
            "knowledge_graph": 6.5,
            "working_memory": 4.0,
            "temporal_context": 3.0,
            "temporal_recall": 2.5,
            "daily_reflection": 2.0,
            "missions": 2.0,
            "philosophical_insights": 1.5,
            "unresolved_threads": 1.5,
            "emotional_context": 1.0,
        },
        relevance_multiplier=3.0,
    ),
    "sentinel": _profile(
        "sentinel",
        "Watchdog/ops agent. Hyper-present, situationally aware. Pairs with "
        "the adaptive heartbeat. Steep forgetting of the stale.",
        {
            "temporal_context": 7.5,
            "working_memory": 7.0,
            "temporal_recall": 5.0,
            "unresolved_threads": 4.0,
            "missions": 3.5,
            "vector_search": 3.0,
            "emotional_context": 1.5,
            "daily_reflection": 1.5,
            "knowledge_graph": 1.5,
            "philosophical_insights": 0.5,  # skipped
        },
        recency_half_life_days=4.0,
        budget_floors={"working_memory": 0.20, "temporal_context": 0.15, "vector_search": 0.10},
    ),
    "dreamer": _profile(
        "dreamer",
        "Creative/associative. Deliberately loose semantic coupling — samples "
        "adjacent rather than nearest memories. Idiosyncratic identity.",
        {
            "philosophical_insights": 6.5,
            "vector_search": 6.0,
            "emotional_context": 4.5,
            "daily_reflection": 4.5,
            "temporal_recall": 4.0,
            "knowledge_graph": 3.5,
            "unresolved_threads": 3.0,
            "working_memory": 2.5,
            "temporal_context": 2.0,
            "missions": 1.0,
        },
        vector_fetch_limit=15,
        vector_sample=True,
        recency_half_life_days=30.0,
    ),
}


def resolve_profile(
    name: str | None,
    weight_overrides: dict[str, float] | None = None,
    scoring_overrides: dict[str, Any] | None = None,
) -> PersonalityProfile:
    """Return the named profile with optional user overrides applied.

    Unknown names fall back to ``balanced`` (logged). ``agent_message``
    weight is always re-pinned to 10.0 regardless of overrides.
    """
    base = PROFILES.get((name or "balanced").strip().lower())
    if base is None:
        logger.warning("Unknown personality %r — falling back to 'balanced'", name)
        base = PROFILES["balanced"]

    if not weight_overrides and not scoring_overrides:
        return base

    weights = dict(base.weights)
    for source, value in (weight_overrides or {}).items():
        if source not in ALL_SOURCES:
            logger.warning("Ignoring weight override for unknown source %r", source)
            continue
        try:
            weights[source] = float(value)
        except (TypeError, ValueError):
            logger.warning("Ignoring non-numeric weight override for %r", source)
    weights["agent_message"] = AGENT_MESSAGE_WEIGHT  # operational invariant

    kw: dict[str, Any] = {
        "relevance_multiplier": base.relevance_multiplier,
        "recency_half_life_days": base.recency_half_life_days,
        "budget_floors": dict(base.budget_floors),
        "max_single_source_pct": base.max_single_source_pct,
        "vector_fetch_limit": base.vector_fetch_limit,
        "vector_sample": base.vector_sample,
        "min_fetch_weight": base.min_fetch_weight,
    }
    for key, value in (scoring_overrides or {}).items():
        if key in kw:
            kw[key] = value

    return PersonalityProfile(
        name=base.name + "+custom",
        description=base.description + " (with user overrides)",
        weights=weights,
        **kw,
    )
