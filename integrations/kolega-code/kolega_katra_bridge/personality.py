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

The values are not hand-maintained here: they live in
``shared/personality/registry.json``, the single source of truth shared with
the TypeScript server, and reach this module through the generated artifact
``personality_registry.generated.py``. Editing that file by hand is detected by
``node scripts/generate-personality-registry.mjs --check`` and by
``scripts/test_personality_registry.py``.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def _load_registry() -> Any:
    """Load the generated registry artifact.

    Its file name contains a dot (matching its TypeScript sibling
    ``personality-profiles.generated.ts``), so it is not importable as a
    submodule — load it by path, once, and cache it in ``sys.modules``.
    """
    module_name = f"{__package__}._personality_registry_generated" if __package__ else "_personality_registry_generated"
    cached = sys.modules.get(module_name)
    if cached is not None:
        return cached

    path = Path(__file__).with_name("personality_registry.generated.py")
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:  # pragma: no cover — a missing artifact
        raise ImportError(f"personality registry artifact is not loadable: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        del sys.modules[module_name]
        raise
    return module


_REGISTRY = _load_registry()

# Operational floor: inter-agent comms always rank first. Not overridable.
AGENT_MESSAGE_WEIGHT = _REGISTRY.AGENT_MESSAGE_WEIGHT

# All source labels known to the retriever. "reflection" (legacy umbrella)
# is expanded to the three sub-sources at config load time.
ALL_SOURCES = _REGISTRY.ALL_SOURCES

REFLECTION_FAMILY = _REGISTRY.REFLECTION_FAMILY

# Registry scoring key → PersonalityProfile field.
_SCORING_FIELDS = {
    "k": "relevance_multiplier",
    "half_life_days": "recency_half_life_days",
    "cap_pct": "max_single_source_pct",
    "floors": "budget_floors",
    "vector_fetch_limit": "vector_fetch_limit",
    "vector_sample": "vector_sample",
    "min_fetch_weight": "min_fetch_weight",
}

_DEFAULT_SCORING = _REGISTRY.DEFAULT_SCORING

# Sources whose weight falls below this are not fetched at all
# (saves MCP round-trips and is itself a personality trait: what the
# agent never retrieves, it effectively does not remember unprompted).
DEFAULT_MIN_FETCH_WEIGHT = _DEFAULT_SCORING["min_fetch_weight"]


@dataclass(frozen=True)
class PersonalityProfile:
    """A named retrieval disposition."""

    name: str
    description: str
    weights: dict[str, float]
    # k in: composite = weight * (1 + k*vector_score + recency_score)
    relevance_multiplier: float = _DEFAULT_SCORING["k"]
    # Half-life for power-law recency: 1 / (1 + age_days / half_life)
    recency_half_life_days: float = _DEFAULT_SCORING["half_life_days"]
    # Guaranteed minimum share of the token budget per source (fractions).
    budget_floors: dict[str, float] = field(
        default_factory=lambda: dict(_DEFAULT_SCORING["floors"])
    )
    # No single source (except agent_message) may exceed this share.
    max_single_source_pct: float = _DEFAULT_SCORING["cap_pct"]
    # Vector search: how many candidates to fetch; if sample=True, sample
    # 5 score-weighted at random from them (looser association — "dreamer").
    vector_fetch_limit: int = _DEFAULT_SCORING["vector_fetch_limit"]
    vector_sample: bool = _DEFAULT_SCORING["vector_sample"]
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


def _profile_from_registry(entry: dict[str, Any]) -> PersonalityProfile:
    """Materialise one profile from its registry entry.

    Only the overrides the entry declares are passed; everything else falls
    through to the dataclass defaults, which come from the same registry.
    """
    kwargs: dict[str, Any] = {}
    for key, value in entry["scoring"].items():
        field_name = _SCORING_FIELDS.get(key)
        if field_name is None:
            logger.warning("Ignoring unknown registry scoring key %r on profile %r", key, entry["name"])
            continue
        kwargs[field_name] = value
    return _profile(entry["name"], entry["description"], entry["weights"], **kwargs)


PROFILES: dict[str, PersonalityProfile] = {
    name: _profile_from_registry(entry) for name, entry in _REGISTRY.PROFILE_DATA.items()
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
