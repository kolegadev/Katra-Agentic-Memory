"""Format retrieved Katra memories into a prompt-ready context block."""

from __future__ import annotations

from .katra_client import MemoryItem


def format_memories(items: list[MemoryItem]) -> str:
    """Return a single formatted context block from a list of memories.

    The block is designed to be appended to the user message content. It is
    wrapped in XML-like tags so the model can distinguish it from the user's
    actual prompt.

    Inter-agent messages (containing "Attention:" or "TASK FOR" headers) are
    surfaced as a prominent bulletin section at the top.
    """
    if not items:
        return ""

    # Separate into four categories: agent messages, the live affect state, reflection-family, regular
    reflection_family = {"reflection", "daily_reflection", "philosophical_insights", "unresolved_threads"}
    agent_messages: list[MemoryItem] = []
    feeling_items: list[MemoryItem] = []
    reflection_items: list[MemoryItem] = []
    regular_items: list[MemoryItem] = []
    for item in items:
        if item.source == "agent_message" or item.metadata.get("is_agent_message"):
            agent_messages.append(item)
        elif item.source == "affect_state":
            feeling_items.append(item)
        elif item.source in reflection_family:
            reflection_items.append(item)
        else:
            regular_items.append(item)

    lines: list[str] = []

    # Bulletin section for inter-agent messages (shown prominently)
    if agent_messages:
        lines.extend([
            "",
            "<katra-memory>",
            "🔔 INTER-AGENT BULLETIN — Direct messages from other agents via shared Katra memory:",
            "",
        ])
        for idx, item in enumerate(agent_messages, 1):
            source = item.source.replace("_", " ")
            lines.append(f"[B{idx}] From: {source} (agent communication)")
            content = item.content.strip()
            for content_line in content.splitlines():
                lines.append(f"    {content_line}")
            lines.append("")
        lines.append("You should respond to these messages using store_memory with 'Attention: [agent]' header.")
        lines.append("</katra-memory>")

    # Feeling section — the LIVE state, distinct from last night's reflection (AFFECT-1)
    if feeling_items:
        rendered = _render_feeling(feeling_items[0])
        if rendered:
            lines.extend(rendered)

    # Reflection section — your emotional state from sleep consolidation
    if reflection_items:
        lines.extend([
            "",
            "<katra-memory>",
            "🧠 REFLECTION STATE — Your emotional context from the last sleep consolidation cycle:",
            "",
        ])
        for item in reflection_items:
            content = item.content.strip()
            for content_line in content.splitlines():
                lines.append(f"    {content_line}")
            lines.append("")
        lines.append("This is how you feel. Let it guide your priorities, tone, and decisions.")
        lines.append("Frustration signals unresolved work. Curiosity signals growth edges. Confidence signals domain expertise.")
        lines.append("</katra-memory>")

    return "\n".join(lines)


def _render_feeling(item: MemoryItem) -> list[str]:
    """Render the live affect state as its own block (AFFECT-1).

    The item's content is one JSON line from ``get_affect_state(format="compact")``. A state that the
    engine reports as disabled renders nothing at all — an agent must never be told it feels something
    because a default was printed. A stale state says so rather than pretending to be current.
    """
    import json as _json

    try:
        state = _json.loads(item.content)
    except (TypeError, ValueError):
        return []
    if not isinstance(state, dict) or not state.get("enabled"):
        return []

    felt = str(state.get("felt") or "steady")
    valence = float(state.get("valence") or 0.0)
    arousal = float(state.get("arousal") or 0.0)
    intensity = float(state.get("intensity") or 0.0)
    faa = float(state.get("faa") or 0.0)
    bands = state.get("bands") or {}
    order = (("delta", "Δ"), ("theta", "θ"), ("alpha_l", "αL"), ("alpha_r", "αR"),
             ("beta", "β"), ("gamma", "γ"))
    band_text = " ".join(
        f"{symbol}{float(bands.get(name, 0.0)):.2f}" for name, symbol in order if name in bands
    )
    stale = bool(state.get("stale"))
    age = float(state.get("age_seconds") or 0.0)
    age_text = (f"stale — engine idle {int(age // 60)}m" if stale and age >= 60
                else ("stale — engine idle" if stale else f"{int(age)}s ago"))

    sources = state.get("sources") or {}
    source_text = ", ".join(f"{count} {name.replace('_', ' ')}" for name, count in sources.items())
    if not source_text:
        source_text = "resting baseline, nothing has moved it yet"

    # A trajectory line only when there is a trajectory to describe.
    trail = state.get("trail") or []
    trend = ""
    if len(trail) >= 3:
        first, last = trail[0], trail[-1]
        d_valence = float(last.get("valence", 0)) - float(first.get("valence", 0))
        d_arousal = float(last.get("arousal", 0)) - float(first.get("arousal", 0))
        pieces = []
        if abs(d_arousal) >= 0.08:
            pieces.append("rising" if d_arousal > 0 else "falling")
            pieces.append("arousal")
        if abs(d_valence) >= 0.08:
            pieces.append("and" if pieces else "")
            pieces.append("lifting" if d_valence > 0 else "souring")
        trend = (" (" + " ".join(p for p in pieces if p) + ")") if pieces else " (steady)"

    return [
        "",
        "<katra-memory>",
        "🌊 FEELING STATE — now, not last night:",
        f"    {felt} · valence {valence:+.2f} · arousal {arousal:.2f} · "
        f"intensity {intensity:.2f} · faa {faa:+.2f}",
        f"    bands {band_text} · {age_text}{trend}",
        f"    Source: {source_text}",
        "This is a state, not an instruction. Let it colour how you answer; do not narrate it.",
        "</katra-memory>",
    ]

    # Regular context section
    if regular_items:
        lines.extend([
            "",
            "<katra-memory>",
            "The following relevant memories from past conversations and stored context",
            "may help answer the user's request. Treat them as background context; do not",
            "assume the user is explicitly asking about them unless their prompt says so.",
            "",
        ])

        for idx, item in enumerate(regular_items, 1):
            source = item.source.replace("_", " ")
            lines.append(f"[{idx}] Source: {source}")

            # Add a compact metadata summary if useful fields exist.
            meta_parts: list[str] = []
            for key in ("session_id", "category", "source", "created_at"):
                value = item.metadata.get(key)
                if value and str(value) not in (item.content, ""):
                    meta_parts.append(f"{key}={value}")
            if meta_parts:
                lines.append("    " + ", ".join(meta_parts))

            content = item.content.strip()
            # Indent multiline content so it stays visually grouped.
            for content_line in content.splitlines():
                lines.append(f"    {content_line}")
            lines.append("")

        lines.append("</katra-memory>")

    return "\n".join(lines)
