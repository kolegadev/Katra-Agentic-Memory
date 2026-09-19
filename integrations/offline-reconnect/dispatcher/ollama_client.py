"""Ollama client for the dispatcher.

The small model gets ONE tool: pick_skill(name). Its whole job is routing,
not problem solving. Handles native tool_calls AND JSON-in-content (qwen 7b
emits the call in `content`), and validates the name against the registry.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from skills.base import SKILLS  # noqa: E402

CATALOG_TOOL = {
    "type": "function",
    "function": {
        "name": "pick_skill",
        "description": "Pick the single best net-agent skill to run next. "
                       "You MUST call this tool exactly once. Never invent skill names.",
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "skill name from the catalog"},
                "why": {"type": "string",
                        "description": "one short sentence justifying the pick"},
            },
            "required": ["name", "why"],
        },
    },
}


def system_prompt(catalog: str) -> str:
    return (
        "You are the net-agent dispatcher on a Linux machine that lost internet. "
        "You do NOT fix anything yourself — you route. Read the NETWORK SNAPSHOT, "
        "pick the single most appropriate skill from the catalog, and call "
        "pick_skill exactly once. After each skill the snapshot updates and you "
        "choose again. The snapshot already contains fresh probe results "
        "(gw_ping, dns_resolves), so do NOT waste a cycle on s12_verify_online "
        "when the failure is clear from the snapshot. Skills named "
        "s08_scan_survey are read-only evidence skills; s13_wait_monitor is for "
        "confirmed ISP outages. Prefer the least invasive matching skill.\n\n"
        "SKILL CATALOG (name [risk] when-to-use):\n" + catalog)


def _chat(model: str, messages: list, timeout: int = 240) -> dict:
    body = json.dumps({"model": model, "messages": messages,
                       "tools": [CATALOG_TOOL], "stream": False,
                       "options": {"temperature": 0.1, "num_predict": 200}}).encode()
    req = urllib.request.Request("http://localhost:11434/api/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _extract_call(msg: dict) -> tuple[str | None, str | None]:
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        name = fn.get("name")
        try:
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                args = json.loads(args)
        except Exception:
            args = {}
        if name == "pick_skill":
            return (args.get("name"), args.get("why"))
    content = msg.get("content") or ""
    # JSON-in-content: the *argument* name lives inside "arguments"
    m = re.search(r'"arguments"\s*:\s*\{[^}]*"name"\s*:\s*"([a-z0-9_]+)"',
                  content)
    why = re.search(r'"arguments"\s*:\s*\{[^}]*"why"\s*:\s*"([^"]{0,140})"',
                    content)
    if m:
        return (m.group(1), why.group(1) if why else None)
    # bare form: {"name": "sXX_...", ...} with no tool wrapper
    m = re.search(r'"name"\s*:\s*"([a-z0-9_]+)"', content)
    return (m.group(1) if m else None, None)


def ask(model: str, snapshot: dict, catalog: str, history: list,
        extra_hint: str = "") -> tuple[str, str, str]:
    """Ask the model for the next skill. Returns (valid_name, why, raw_reason).

    valid_name is guaranteed in the registry; falls back deterministically to
    s02_nm_profile_up when the model output is unparseable.
    """
    msgs = [{"role": "system", "content": system_prompt(catalog)}]
    if history:
        failed = list(dict.fromkeys(
            h.get("skill") for h in history
            if h.get("result") in ("failed", "error")))
        block = ("Previous cycles in this run (for your awareness):\n"
                 "skills already tried and FAILED — NEVER pick these again: "
                 + (", ".join(failed) if failed else "(none)") + "\n")
        msgs.append({"role": "user", "content": block[:1200]})
    msgs.append({"role": "user", "content":
                 "CURRENT NETWORK SNAPSHOT:\n" + json.dumps(snapshot, indent=1)[:3500] +
                 (("\n\nDISPATCHER HINT: " + extra_hint) if extra_hint else "") +
                 "\n\nPick the next skill."})
    try:
        resp = _chat(model, msgs)
        name, why = _extract_call(resp.get("message") or {})
        raw = json.dumps(resp.get("message", {}))[:400]
    except Exception as e:
        return "s02_nm_profile_up", "model unreachable: %s" % str(e)[:100], "error"
    if name in SKILLS:
        return name, why or "(no reason)", raw
    return "s02_nm_profile_up", "unparseable pick (%r); deterministic fallback" % name, raw
