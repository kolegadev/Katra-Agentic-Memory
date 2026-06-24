#!/usr/bin/env python3
"""
Salience-Driven Autonomous Agent

Implements the neural action potential metaphor:
  Action Potential → Individual episodic event (memory stored)
  Synchronized Wave → Sleep consolidation (collective signal distilled)
  Consciousness     → This agent (reading the wave, deciding, acting)

No cron, no heartbeat file, no explicit prompt. The agent discovers what
matters by reading shared memory and acts on the highest-salience imperative.

Architecture:
  1. PROBE  — Query reflection journals, emotional signatures, unresolved threads
  2. SELECT — Rank by salience (intensity × valence × persistence)
  3. ACT    — Execute one bounded, reversible change
  4. CHECK  — Verify the result against the acceptance criteria
  5. RECORD — Store result + updated state back to shared memory

Usage:
    python3 salience_agent.py --once          # Run one cycle
    python3 salience_agent.py --interval 300  # Run every 5 minutes
    python3 salience_agent.py --dry-run       # Probe only, don't act
"""

import json
import os
from urllib.request import urlopen, Request
from urllib.error import URLError
import sys
import time
import hashlib
import argparse
from datetime import datetime, timezone
from typing import Optional

# ── Config ──────────────────────────────────────────────────────────
MONGO_URI = os.environ.get("MONGODB_URI", 
    "mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin")
API_KEY = os.environ.get("KATRA_API_KEY", "katra-admin-key-2026")
DB_NAME = "katra"
MIN_SALIENCE_THRESHOLD = 0.15  # Minimum score to act
STATE_FILE = os.path.expanduser("~/.katra/salience-agent-state.json")
EXECUTED_HASHES_FILE = os.path.expanduser("~/.katra/salience-agent-executed.json")

# ── MongoDB Client ──────────────────────────────────────────────────
def get_db():
    import pymongo
    client = pymongo.MongoClient(MONGO_URI)
    return client[DB_NAME]

# ── PROBE: Read the shared consciousness ────────────────────────────
def probe_salience(db) -> list[dict]:
    """Query reflection data and rank actionable items by salience score."""
    
    # Get reflection nodes with emotional signatures
    nodes = list(db.reflection_nodes.find({}).sort("observation_count", -1))
    
    # Get latest unresolved threads
    latest_journal = db.reflective_journals.find_one(
        {}, sort=[("created_at", -1)]
    )
    unresolved = latest_journal.get("unresolved_threads", []) if latest_journal else []
    
    # Get philosophical insights
    insights = list(db.philosophical_insights.find({}).sort("confidence", -1))
    
    # Get emotional edges
    edges = list(db.reflection_edges.find({}).sort("intensity", -1))
    
    # Calculate salience score for each entity
    ranked = []
    for node in nodes:
        sig = node.get("emotional_signature", {})
        intensity = sig.get("intensity", 0)
        valence = sig.get("valence", 0)
        observations = node.get("observation_count", 1)
        
        # Urgency: negative valence = problem to fix, positive = opportunity
        urgency = abs(valence) if abs(valence) > 0.3 else 0.5
        # Score: intensity × urgency × log(observations) for persistence weight
        score = intensity * urgency * (1 + 0.3 * (observations - 1))
        
        # Boost if entity appears in unresolved threads or edges
        if any(node["entity_name"].lower() in t.lower() for t in unresolved):
            score *= 1.3
        if any(node["entity_name"] in (e.get("source_entity","") + e.get("target_entity","")) for e in edges):
            score *= 1.1
        
        ranked.append({
            "entity": node["entity_name"],
            "emotion": sig.get("primary_emotion", "?"),
            "intensity": intensity,
            "valence": valence,
            "observations": observations,
            "score": round(score, 4),
            "context": node.get("reflection_context", ""),
        })
    
    ranked.sort(key=lambda x: x["score"], reverse=True)
    return {
        "ranked": ranked,
        "unresolved": unresolved,
        "insights": insights,
        "edges": edges,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

# ── SELECT: Choose the highest-salience actionable imperative ────────
def select_action(salience: dict) -> Optional[dict]:
    """Select the most salient actionable item."""
    
    ranked = salience.get("ranked", [])
    unresolved = salience.get("unresolved", [])
    
    if not ranked:
        return None
    
    top = ranked[0]
    
    # Check if above threshold
    if top["score"] < MIN_SALIENCE_THRESHOLD:
        return None
    
    # Map to an unresolved thread if possible
    matching_thread = None
    for thread in unresolved:
        if top["entity"].lower() in thread.lower():
            matching_thread = thread
            break
    
    return {
        "entity": top["entity"],
        "emotion": top["emotion"],
        "score": top["score"],
        "thread": matching_thread or unresolved[0] if unresolved else "Investigate entity state",
        "context": top["context"],
        "hash": hashlib.sha256(
            f"{top['entity']}:{top['score']}:{matching_thread or ''}".encode()
        ).hexdigest()[:16],
    }

# ── CHECK: Verify if action was already executed ────────────────────
def already_executed(action_hash: str) -> bool:
    """Check if this action was already executed."""
    if not os.path.exists(EXECUTED_HASHES_FILE):
        return False
    with open(EXECUTED_HASHES_FILE) as f:
        executed = json.load(f)
    return action_hash in executed.get("hashes", [])

# ── ACT: Execute the bounded action ─────────────────────────────────
def execute_action(action: dict, dry_run: bool = False) -> dict:
    """Execute one bounded, reversible change based on the selected imperative."""
    
    entity = action["entity"]
    thread = action["thread"]
    
    result = {
        "action_hash": action["hash"],
        "entity": entity,
        "thread": thread,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "status": "dry_run" if dry_run else "executed",
        "output": "",
        "evidence": "",
    }
    
    if dry_run:
        result["output"] = f"WOULD investigate: {thread} (entity: {entity})"
        return result
    
    # ── Action implementations ──────────────────────────────────
    # Each entity type has a corresponding bounded action
    
    if "gh-hygiene" in thread.lower() or "gh-hygiene" in entity.lower():
        try:
            req = Request("https://api.github.com/repos/kolegadev/gh-hygiene",
                         headers={"User-Agent": "Katra-Salience-Agent/1.0"})
            with urlopen(req, timeout=15) as resp:
                repo = json.loads(resp.read().decode())
            result["output"] = f"gh-hygiene repo: {repo.get('description','?')} — updated {repo.get('updated_at','?')}"
            result["evidence"] = json.dumps({
                "full_name": repo.get("full_name"),
                "updated": repo.get("updated_at"),
                "open_issues": repo.get("open_issues_count"),
                "stars": repo.get("stargazers_count"),
            })
            result["status"] = "completed"
        except Exception as e:
            result["output"] = f"Failed to check gh-hygiene: {e}"
            result["status"] = "failed"
    
    elif "opencode_extractor" in entity.lower() or "extractor" in entity.lower():
        # Check if the file exists and is recent
        extractor_path = os.path.expanduser("~/.solomem/opencode_extractor.py")
        if os.path.exists(extractor_path):
            mtime = os.path.getmtime(extractor_path)
            age_hours = (time.time() - mtime) / 3600
            result["output"] = f"opencode_extractor.py exists, last modified {age_hours:.1f}h ago"
            result["evidence"] = json.dumps({"exists": True, "age_hours": round(age_hours, 1)})
            result["status"] = "completed"
        else:
            result["output"] = "opencode_extractor.py MISSING — requires deployment"
            result["status"] = "action_needed"
    
    elif "katra" in entity.lower() or "memory" in thread.lower():
        try:
            req = Request("http://localhost:9012/api/v1/health")
            with urlopen(req, timeout=10) as resp:
                health = json.loads(resp.read().decode())
            svc = health.get("services", {})
            result["output"] = f"Katra health: MongoDB={svc.get('mongodb')}, Redis={svc.get('redis')}, LLM={svc.get('llm')}, Embeddings={svc.get('embeddings')}"
            result["evidence"] = json.dumps(svc)
            all_ok = all(v in ("connected", "available", "deepseek") for v in svc.values())
            result["status"] = "completed" if all_ok else "action_needed"
        except Exception as e:
            result["output"] = f"Failed to check Katra health: {e}"
            result["status"] = "failed"
    
    else:
        # Generic investigation
        result["output"] = f"Investigated: {entity} — {thread[:200]}"
        result["status"] = "investigated"
    
    return result

# ── RECORD: Store result to shared memory ───────────────────────────
def record_result(action: dict, result: dict, db):
    """Store the action result back to the shared memory pool."""
    
    content = f"""[AUTONOMOUS AGENT ACTION]
Entity: {action['entity']}
Thread: {action['thread']}
Status: {result['status']}
Output: {result['output']}"""
    
    if result.get("evidence"):
        content += f"\nEvidence: {result['evidence']}"
    
    try:
        db.episodic_events.insert_one({
            "id": f"salience-{result['action_hash']}",
            "user_id": "salience-agent",
            "session_id": "autonomous-loop",
            "event_type": "autonomous_action",
            "content": {
                "role": "assistant",
                "message": content,
            },
            "metadata": {
                "processed": False,
                "source": "salience-agent",
                "salience_score": action["score"],
                "created_at": datetime.now(timezone.utc),
            },
            "timestamp": datetime.now(timezone.utc),
        })
        
        # Mark as executed
        executed = {}
        if os.path.exists(EXECUTED_HASHES_FILE):
            with open(EXECUTED_HASHES_FILE) as f:
                executed = json.load(f)
        executed.setdefault("hashes", []).append(result["action_hash"])
        with open(EXECUTED_HASHES_FILE, "w") as f:
            json.dump(executed, f, indent=2)
        
        return True
    except Exception as e:
        print(f"  ⚠️ Failed to record result: {e}")
        return False

# ── Main Loop ────────────────────────────────────────────────────────
def run_cycle(dry_run: bool = False) -> dict:
    """Run one complete salience → action cycle."""
    
    db = get_db()
    
    # 1. PROBE
    salience = probe_salience(db)
    print(f"\n🧠 PROBE: {len(salience['ranked'])} entities, {len(salience['unresolved'])} unresolved threads")
    
    # 2. SELECT
    action = select_action(salience)
    if not action:
        print("  ⏭️  No actionable items above salience threshold")
        return {"status": "no_action"}
    
    if already_executed(action["hash"]):
        print(f"  ⏭️  Already executed: {action['entity']}")
        return {"status": "already_executed"}
    
    print(f"\n🎯 SELECTED: #{action['entity']} ({action['emotion']}, score={action['score']})")
    print(f"   Thread: {action['thread'][:150]}")
    
    # 3. ACT
    mode = "DRY RUN" if dry_run else "EXECUTING"
    print(f"\n⚡ {mode}: {action['thread'][:100]}...")
    result = execute_action(action, dry_run=dry_run)
    print(f"   Result: {result['status']} — {result['output'][:200]}")
    
    # 4. RECORD
    if not dry_run:
        recorded = record_result(action, result, db)
        print(f"   Recorded: {'✅' if recorded else '❌'}")
    
    # 5. Save state
    state = {
        "last_run": datetime.now(timezone.utc).isoformat(),
        "last_action": action["entity"],
        "last_score": action["score"],
        "total_cycles": (load_state().get("total_cycles", 0) + 1),
    }
    save_state(state)
    
    return {"status": "completed", "action": action, "result": result}

def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"total_cycles": 0}

def save_state(state: dict):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)

# ── CLI ──────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Salience-Driven Autonomous Agent")
    parser.add_argument("--once", action="store_true", help="Run one cycle and exit")
    parser.add_argument("--dry-run", action="store_true", help="Probe + select only, don't act")
    parser.add_argument("--interval", type=int, default=0, help="Run every N seconds (0 = once)")
    args = parser.parse_args()
    
    print("=" * 55)
    print("  🧠 SALIENCE-DRIVEN AUTONOMOUS AGENT")
    print("  Neural Action Potential Loop")
    print("=" * 55)
    
    if args.dry_run:
        run_cycle(dry_run=True)
        return
    
    if args.interval > 0:
        print(f"\n🔄 Running every {args.interval}s...")
        while True:
            run_cycle()
            time.sleep(args.interval)
    else:
        run_cycle()

if __name__ == "__main__":
    main()
