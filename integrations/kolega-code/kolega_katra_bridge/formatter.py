"""Format retrieved Katra memories into a prompt-ready context block."""

from __future__ import annotations

from .katra_client import MemoryItem


def format_memories(items: list[MemoryItem]) -> str:
    """Return a single formatted context block from a list of memories.

    The block is designed to be appended to the user message content. It is
    wrapped in XML-like tags so the model can distinguish it from the user's
    actual prompt.
    """
    if not items:
        return ""

    lines = [
        "",
        "<katra-memory>",
        "The following relevant memories from past conversations and stored context",
        "may help answer the user's request. Treat them as background context; do not",
        "assume the user is explicitly asking about them unless their prompt says so.",
        "",
    ]

    for idx, item in enumerate(items, 1):
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
