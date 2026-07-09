#!/usr/bin/env python3
"""Kolega Code Hook: Action Card Checker — queries Katra for escalated action cards."""

import json, os, re, time
import httpx

KATRA_URL = os.environ.get("KATRA_URL", "http://localhost:3112/mcp")
KATRA_TOKEN = os.environ.get("KATRA_TOKEN",
    "YOUR_KATRA_TOKEN")
CACHE_TTL = 300

HEADERS = {
    "Authorization": "Bearer " + KATRA_TOKEN,
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}

_cache = {"cards": [], "timestamp": 0}


def _parse_action_cards(text):
    """Extract action cards from Katra search line by line.
    Some fields may be truncated; we extract what we can."""
    cards = []
    for line in text.split("\n"):
        if '{"type": "action_card"' not in line:
            continue
        
        reason_m = re.search(r'"reason":\s*"([^"]+)"', line)
        severity_m = re.search(r'"severity":\s*"([^"]+)"', line)
        prompt_m = re.search(r'"suggested_prompt":\s*"([^"]+)"', line)
        
        # Driver is often truncated in search results; extract partial if available
        driver_m = re.search(r'"driver":\s*"([a-z_]+)"?', line)
        driver = driver_m.group(1) if driver_m else (
            re.search(r'"driver":\s*"([a-z]+)', line).group(1) if re.search(r'"driver":\s*"([a-z]+)', line) else "unknown"
        )
        
        if reason_m and severity_m:
            cards.append({
                "reason": reason_m.group(1),
                "severity": severity_m.group(1),
                "prompt": prompt_m.group(1) if prompt_m else reason_m.group(1),
                "driver": driver,
            })
    return cards


def _get_action_cards():
    global _cache
    if time.time() - _cache["timestamp"] < CACHE_TTL and _cache["cards"]:
        return _cache["cards"]

    try:
        with httpx.Client(timeout=10) as client:
            client.post(KATRA_URL, json={
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                           "clientInfo": {"name": "hook", "version": "1.0"}},
            }, headers=HEADERS)

            r = client.post(KATRA_URL, json={
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {
                    "name": "search_memories",
                    "arguments": {"query": "action_card", "limit": 10},
                },
            }, headers=HEADERS)

            m = re.search(r'data: (\{.*\})', r.text)
            if not m:
                return _cache.get("cards", [])
            result = json.loads(m.group(1))
            text = result.get("result", {}).get("content", [{}])[0].get("text", "")
            cards = _parse_action_cards(text)
            _cache = {"cards": cards, "timestamp": time.time()}
            return cards
    except Exception:
        return _cache.get("cards", [])


async def on_session_start(context):
    cards = _get_action_cards()
    if not cards:
        return None

    lines = ["\n---", "## Subconscious Bulletin",
             "_{} concern(s) from your autonomous mind:_".format(len(cards)), ""]

    by_sev = {}
    for c in cards:
        by_sev.setdefault(c["severity"], []).append(c)

    labels = {"critical": "CRITICAL", "urgent": "URGENT", "warning": "WARNING", "info": "NOTABLE"}
    for sev in ["critical", "urgent", "warning", "info"]:
        if sev in by_sev:
            lines.append("### {}:".format(labels.get(sev, sev.upper())))
            for c in by_sev[sev]:
                lines.append("- **{}**: {}".format(c["driver"], c["reason"]))
                lines.append("  -> {}".format(c["prompt"]))
            lines.append("")

    lines.append("*Your subconscious has been thinking. Address or acknowledge.*")
    lines.append("---\n")
    return "\n".join(lines)


async def on_user_prompt(context):
    _get_action_cards()
    return None


if __name__ == "__main__":
    import asyncio
    async def test():
        r = await on_session_start({})
        print(r if r else "No action cards found.")
    asyncio.run(test())
