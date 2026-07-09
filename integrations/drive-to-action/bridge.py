#!/usr/bin/env python3
"""
Drive-to-Action Bridge (v2 — with Self-Initiation)
===================================================
Monitors Katra's subconscious and creates action cards.
Now also auto-starts Kolega Code sessions for critical/urgent concerns
so the conscious agent doesn't need to wait for a human to wake it up.

Thresholds:
  - Same worry >= 2 reflection cycles → action_card (warning)
  - Any drive deficit > 40% → action_card (urgent)
  - Unresolved thread > 7 days → action_card (info)
  
Self-initiation:
  - CRITICAL: auto-start session immediately
  - URGENT (3+ cycles old): auto-start session
  - WARNING/INFO: queue for next human session
"""

import asyncio
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone

import httpx

KATRA_URL = os.environ.get("KATRA_URL", "http://localhost:3112/mcp")
KATRA_TOKEN = os.environ.get("KATRA_TOKEN",
    "YOUR_KATRA_TOKEN")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "900"))
DRIVE_DEFICIT_THRESHOLD = int(os.environ.get("DRIVE_DEFICIT_THRESHOLD", "40"))
WORRY_CYCLE_THRESHOLD = int(os.environ.get("WORRY_CYCLE_THRESHOLD", "2"))
AUTO_START_ENABLED = os.environ.get("AUTO_START", "true").lower() == "true"
KOLEGA_BIN = os.environ.get("KOLEGA_BIN",
    "kolega-code")

HEADERS = {
    "Authorization": f"Bearer {KATRA_TOKEN}",
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}

escalated_regrets: set = set()
escalated_threads: set = set()
escalated_drives: set = set()
urgent_cycle_counts: dict = {}  # Track how many cycles a concern has persisted


async def mcp(method: str, params: dict | None = None) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(KATRA_URL, json={
            "jsonrpc": "2.0", "id": 1, "method": method,
            "params": params or {},
        }, headers=HEADERS)
        m = re.search(r"data: (\{.*\})", r.text)
        if m:
            return json.loads(m.group(1))
        return {"error": "parse_failed"}


async def store_action_card(reason: str, severity: str, prompt: str, driver: str):
    content = json.dumps({
        "type": "action_card",
        "reason": reason,
        "severity": severity,
        "suggested_prompt": prompt,
        "driver": driver,
        "created": datetime.now(timezone.utc).isoformat(),
    })
    await mcp("tools/call", {
        "name": "store_memory",
        "arguments": {
            "content": content,
            "category": "fact",
            "source": "drive-to-action-bridge",
            "confidence": 0.9,
            "tags": ["escalated", "action-required", f"severity:{severity}", f"driver:{driver}"],
        },
    })
    print(f"  🚨 ACTION CARD [{severity}]: {reason}")
    return {"reason": reason, "severity": severity, "prompt": prompt, "driver": driver}


async def auto_start_session(card: dict):
    """Auto-start a Kolega Code session to address a critical concern."""
    if not AUTO_START_ENABLED:
        print(f"  ⏸️  Auto-start disabled (AUTO_START=false)")
        return
    
    goal = (
        f"Subconscious Bulletin: {card['severity'].upper()} concern from your autonomous mind.\n\n"
        f"Driver: {card['driver']}\n"
        f"Issue: {card['reason']}\n\n"
        f"Suggestion: {card['prompt']}\n\n"
        f"Address this concern. If it requires code changes, make them. "
        f"If it requires research, do it. If it requires acknowledgment, "
        f"acknowledge it and store a resolution in Katra. "
        f"Work autonomously and report what you did."
    )
    
    print(f"  🤖 Auto-starting Kolega Code session...")
    try:
        proc = await asyncio.create_subprocess_exec(
            KOLEGA_BIN, "ask",
            "--goal", goal,
            "--permission-mode", "auto",
            "--trust-hooks",
            "--trust-mcp",
            "--goal-max-turns", "15",
            "--save",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=600
        )
        if proc.returncode == 0:
            print(f"  ✅ Auto-session completed successfully")
        else:
            print(f"  ⚠️  Auto-session exited with code {proc.returncode}")
            if stderr:
                print(f"     stderr: {stderr.decode()[:200]}")
    except asyncio.TimeoutError:
        print(f"  ⏰ Auto-session timed out (10 min limit)")
    except Exception as e:
        print(f"  ❌ Auto-session failed: {e}")


async def check_reflection_regrets():
    resp = await mcp("tools/call", {
        "name": "get_daily_reflection", "arguments": {},
    })
    text = resp.get("result", {}).get("content", [{}])[0].get("text", "")
    
    regret_match = re.search(
        r"I would most regret leaving\s+(.+?)\s+undone",
        text, re.IGNORECASE
    )
    if regret_match:
        regret = regret_match.group(1).strip()
        if regret not in escalated_regrets:
            resp2 = await mcp("tools/call", {
                "name": "search_memories",
                "arguments": {"query": f"regret leaving {regret} undone", "limit": 5},
            })
            search_text = resp2.get("result", {}).get("content", [{}])[0].get("text", "")
            occurrences = search_text.count("would most regret")
            
            if occurrences >= WORRY_CYCLE_THRESHOLD:
                escalated_regrets.add(regret)
                urgent_cycle_counts[regret] = occurrences
                card = await store_action_card(
                    reason=f"Regret '{regret}' appeared in {occurrences} daily reflections",
                    severity="critical" if occurrences >= 4 else "warning",
                    prompt=f"You've been worried about {regret} being unfinished for {occurrences} days. Should we work on it?",
                    driver="coherence",
                )
                if card["severity"] == "critical":
                    await auto_start_session(card)


async def check_drive_deficits():
    resp = await mcp("tools/call", {
        "name": "get_drive_state", "arguments": {},
    })
    text = resp.get("result", {}).get("content", [{}])[0].get("text", "")
    
    for line in text.split("\n"):
        match = re.match(r"\|\s*(\w+)\s*\|\s*(\d+)%\s*\|\s*(\d+)%\s*\|", line)
        if match:
            drive_name = match.group(1)
            drive_deficit = 100 - int(match.group(2))
            drive_strength = int(match.group(3))
            
            if drive_deficit > DRIVE_DEFICIT_THRESHOLD and drive_name not in escalated_drives:
                escalated_drives.add(drive_name)
                urgent_cycle_counts.setdefault(drive_name, 0)
                urgent_cycle_counts[drive_name] += 1
                
                severity = "critical" if drive_deficit > 65 else "urgent"
                card = await store_action_card(
                    reason=f"Drive '{drive_name}' at {drive_deficit}% deficit (strength: {drive_strength}%)",
                    severity=severity,
                    prompt=f"Your {drive_name} drive has been depleted ({drive_deficit}% deficit). Consider addressing unfinished work to restore balance.",
                    driver=drive_name,
                )
                
                # Auto-start for critical drives
                if severity == "critical" and AUTO_START_ENABLED:
                    await auto_start_session(card)


async def check_unresolved_threads():
    resp = await mcp("tools/call", {
        "name": "get_unresolved_threads", "arguments": {},
    })
    text = resp.get("result", {}).get("content", [{}])[0].get("text", "")
    
    threads = re.findall(r"\d+\.\s+(.+?)(?=\n\d+\.|\Z)", text, re.DOTALL)
    for thread in threads:
        thread = thread.strip()
        if thread and thread not in escalated_threads:
            escalated_threads.add(thread)
            await store_action_card(
                reason=f"Unresolved thread: '{thread[:100]}'",
                severity="info",
                prompt=f"Katra has been wrestling with: '{thread}'. Would you like to explore this?",
                driver="coherence",
            )


async def poll():
    print(f"\n{'='*60}")
    print(f"🔍 Polling — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"   Auto-start: {'ON' if AUTO_START_ENABLED else 'OFF'}")
    print(f"{'='*60}")
    
    try:
        await mcp("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "drive-to-action-bridge", "version": "2.0"},
        })
        await check_drive_deficits()
        await check_reflection_regrets()
        await check_unresolved_threads()
    except Exception as e:
        print(f"  ⚠️ Poll error: {e}")


async def main():
    print("🧠 Drive-to-Action Bridge v2 — with Self-Initiation")
    print(f"   Poll interval: {POLL_INTERVAL}s")
    print(f"   Drive threshold: {DRIVE_DEFICIT_THRESHOLD}%")
    print(f"   Auto-start: {'ON' if AUTO_START_ENABLED else 'OFF'}")
    
    while True:
        await poll()
        await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    asyncio.run(main())
