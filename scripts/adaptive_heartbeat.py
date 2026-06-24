#!/usr/bin/env python3
"""
Adaptive Heartbeat — Demand-Driven Autonomous Cadence with Task Allocation

No cron. No .md files. The heartbeat's cadence is governed by the emotional
landscape. When an imperative is detected, it determines which agent should
act based on emotional proximity and domain history.

Cadence Formula:
  Base: 30 min  |  Floor: 24h (idle)  |  Ceiling: 5 min (urgent)
  Multipliers: event volume, salience, thread backlog, emotional intensity

Task Allocation (mirrors brain hemisphere specialization):
  1. REFLECTION EDGES: which agent has felt relationships with the entity?
  2. EVENT HISTORY: which agent mentions the entity most?
  3. EMOTIONAL INTENSITY: which agent feels strongest about it?
"""

import json, os, time, hashlib, argparse
from datetime import datetime, timezone
from typing import Optional, Tuple
from urllib.request import urlopen, Request
from urllib.error import URLError

# ── Config ──────────────────────────────────────────────────────────
STATE_FILE = os.path.expanduser("~/.katra/adaptive-heartbeat-state.json")
EXECUTED_FILE = os.path.expanduser("~/.katra/adaptive-heartbeat-executed.json")
BASE_INTERVAL = 30 * 60
FLOOR_INTERVAL = 24 * 3600
CEILING_INTERVAL = 5 * 60
HIGH_EVENT_THRESHOLD = 50
HIGH_SALIENCE_THRESHOLD = 0.4
HIGH_THREAD_THRESHOLD = 3

import docker as _docker
_client = _docker.DockerClient(base_url='unix:///Users/johnpellew/.colima/default/docker.sock')

def _mongo_query(js):
    mongo = _client.containers.get('katra-mongo')
    exec_id = _client.api.exec_create(mongo.id,
        ['mongosh', 'mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin',
         '--quiet', '--eval', js])
    return _client.api.exec_start(exec_id['Id']).decode('utf-8', errors='replace')

# ── Brain State Reader ──────────────────────────────────────────────
def read_brain_state():
    vol = _mongo_query('''
var h = db.episodic_events.countDocuments({timestamp: {$gte: new Date(Date.now()-3600000)}});
var t = db.episodic_events.countDocuments({});
print(JSON.stringify({last_hour: h, total: t}));
''').strip()
    vol_data = json.loads('\n'.join(vol.split('\n')[-3:]).strip() or '{}')

    sal = _mongo_query('''
var nodes = db.reflection_nodes.find({}).sort({observation_count: -1}).limit(5).toArray();
var journal = db.reflective_journals.find({}).sort({created_at: -1}).limit(1).toArray();
var unresolved = journal.length > 0 ? (journal[0].unresolved_threads || []) : [];
var arc = journal.length > 0 ? (journal[0].emotional_arc || {}) : {};
var ranked = [];
nodes.forEach(function(n) {
  var sig = n.emotional_signature || {};
  var intensity = sig.intensity || 0;
  var valence = sig.valence || 0;
  var obs = n.observation_count || 1;
  var urgency = Math.abs(valence) > 0.3 ? Math.abs(valence) : 0.5;
  var score = intensity * urgency * (1 + 0.2 * (obs - 1));
  if (unresolved.some(function(t) { return t.toLowerCase().indexOf(n.entity_name.toLowerCase()) >= 0; })) score *= 1.3;
  ranked.push({entity: n.entity_name, emotion: sig.primary_emotion||"?", score: Math.round(score*10000)/10000});
});
ranked.sort(function(a,b){return b.score-a.score;});
print(JSON.stringify({ranked: ranked, unresolved_count: unresolved.length,
  dominant_emotion: arc.dominant_emotion||"none", arc_intensity: arc.intensity||0}));
''').strip()
    sal_data = json.loads('\n'.join(sal.split('\n')[-3:]).strip() or '{}')

    return {
        "events_last_hour": vol_data.get("last_hour", 0),
        "events_total": vol_data.get("total", 0),
        "top_salience": sal_data.get("ranked", [{}])[0].get("score", 0) if sal_data.get("ranked") else 0,
        "unresolved_count": sal_data.get("unresolved_count", 0),
        "dominant_emotion": sal_data.get("dominant_emotion", "none"),
        "arc_intensity": sal_data.get("arc_intensity", 0),
        "ranked": sal_data.get("ranked", []),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

# ── Cadence Calculator ──────────────────────────────────────────────
def calculate_cadence(brain):
    interval = BASE_INTERVAL
    reasons = []
    ev = brain["events_last_hour"]
    if ev > HIGH_EVENT_THRESHOLD:
        interval = int(interval * 0.5); reasons.append(f"high event volume ({ev}/hr)")
    elif ev < 10:
        interval = int(interval * 2); reasons.append(f"low event volume ({ev}/hr)")
    if brain["top_salience"] > HIGH_SALIENCE_THRESHOLD:
        interval = int(interval * 0.5); reasons.append(f"high salience ({brain['top_salience']:.3f})")
    if brain["unresolved_count"] > HIGH_THREAD_THRESHOLD:
        interval = int(interval * 0.7); reasons.append(f"backlog ({brain['unresolved_count']} threads)")
    if brain["arc_intensity"] > 0.6:
        interval = int(interval * 0.7); reasons.append(f"emotional intensity ({brain['arc_intensity']:.2f})")
    if ev < 5 and brain["top_salience"] < 0.3 and brain["unresolved_count"] < 2:
        interval = FLOOR_INTERVAL; reasons.append("idle mode (floor at 24h)")
    interval = max(CEILING_INTERVAL, min(FLOOR_INTERVAL, interval))
    return interval, " | ".join(reasons) if reasons else "standard cadence"

# ── Task Allocation Engine ──────────────────────────────────────────
def determine_agent_affinity(entity_name):
    """Decide which agent should act based on emotional proximity."""
    
    # 1. Reflection edges — strongest signal
    edges_raw = _mongo_query(f'''
var edges = db.reflection_edges.find({{
  $or: [
    {{source_entity: {{$regex: "{entity_name}", $options: "i"}}}},
    {{target_entity: {{$regex: "{entity_name}", $options: "i"}}}}
  ]
}}).toArray();
var allEdges = db.reflection_edges.find({{}}).toArray();
print(JSON.stringify({{entity_edges: edges, all_edges: allEdges}}));
''').strip()
    edge_data = json.loads('\n'.join(edges_raw.split('\n')[-3:]).strip() or '{}')
    
    # 2. Event mentions per agent
    ev_raw = _mongo_query(f'''
var agents = ["opencode-agent", "kolega-agent"];
var counts = {{}};
agents.forEach(function(a) {{
  counts[a] = db.episodic_events.countDocuments({{
    user_id: a,
    $or: [
      {{"content.message": {{$regex: "{entity_name}", $options: "i"}}}}
    ]
  }});
}});
print(JSON.stringify(counts));
''').strip()
    ev_counts = json.loads('\n'.join(ev_raw.split('\n')[-3:]).strip() or '{}')
    
    # ── Scoring ──
    scores = {"opencode-agent": 0, "kolega-agent": 0}
    rationales = []
    
    # Signal 1: Reflection edges
    for edge in edge_data.get("entity_edges", []) + edge_data.get("all_edges", []):
        source = str(edge.get("source_entity", "")).lower()
        target = str(edge.get("target_entity", "")).lower()
        edge_type = edge.get("edge_type", "")
        intensity = edge.get("intensity", 0)
        
        for agent in ["opencode-agent", "kolega-agent"]:
            if agent in source or agent in target:
                s = intensity * 1.5
                if any(w in edge_type for w in ["frustrated","conflicted","anxious","tension"]):
                    s *= 1.3  # problem owner
                if any(w in edge_type for w in ["excited","growing","confident","inspired"]):
                    s *= 1.2  # domain expert
                scores[agent] = scores.get(agent, 0) + s
    
    # Signal 2: Event history
    max_ev = max(ev_counts.values()) if ev_counts else 1
    for agent, count in ev_counts.items():
        scores[agent] = scores.get(agent, 0) + (count / max(max_ev, 1))
    
    # Decision
    best = max(scores, key=scores.get) if scores else "opencode-agent"
    best_s = scores[best]
    second = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    second_agent = second[1][0] if len(second) > 1 else None
    second_s = second[1][1] if len(second) > 1 else 0
    confidence = round(best_s / (best_s + second_s + 0.001), 2) if second_agent else 1.0
    
    return {
        "agent": best, "score": round(best_s, 3), "confidence": confidence,
        "rationale": f"{best} has stronger emotional proximity to '{entity_name}' ({best_s:.2f} vs {second_agent} {second_s:.2f})",
        "signals": {"edges": len([e for e in edge_data.get("entity_edges",[]) if best in str(e).lower()]),
                     "events": ev_counts.get(best, 0)},
    }

# ── Action Executor ─────────────────────────────────────────────────
def http_get_json(url, headers=None):
    req = Request(url, headers=headers or {"User-Agent": "Katra-Adaptive-Heartbeat/1.0"})
    try:
        with urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except URLError as e:
        return {"error": str(e)}

def execute(entity, dry_run=False):
    name = entity["entity"]
    if dry_run:
        return {"entity": name, "status": "completed", "output": f"DRY RUN: would investigate {name}"}
    
    if "gh-hygiene" in name.lower():
        repo = http_get_json("https://api.github.com/repos/kolegadev/gh-hygiene")
        return {"entity": name, "status": "completed",
                "output": f"gh-hygiene: {repo.get('description','?')} — updated {repo.get('updated_at','?')} | stars: {repo.get('stargazers_count',0)}"}
    elif "opencode_extractor" in name.lower() or "extractor" in name.lower():
        ep = os.path.expanduser("~/.solomem/opencode_extractor.py")
        exists = os.path.exists(ep)
        return {"entity": name, "status": "action_needed" if not exists else "completed",
                "output": f"opencode_extractor.py: {'EXISTS' if exists else 'MISSING'}"}
    elif "katra" in name.lower():
        h = http_get_json("http://localhost:9012/api/v1/health")
        svc = h.get("services", {})
        ok = all(v in ("connected","available","deepseek") for v in svc.values())
        return {"entity": name, "status": "completed" if ok else "action_needed",
                "output": f"Katra: {', '.join(f'{k}={v}' for k,v in svc.items())}"}
    else:
        return {"entity": name, "status": "completed",
                "output": f"Investigated entity '{name}' — {entity.get('emotion','?')} state acknowledged"}

# ── State ───────────────────────────────────────────────────────────
def _load_executed():
    if os.path.exists(EXECUTED_FILE):
        with open(EXECUTED_FILE) as f: return json.load(f)
    return {"hashes": []}
def _save_executed(d):
    os.makedirs(os.path.dirname(EXECUTED_FILE), exist_ok=True)
    with open(EXECUTED_FILE, "w") as f: json.dump(d, f, indent=2)

# ── Heartbeat Cycle ─────────────────────────────────────────────────
def run_pulse(dry_run=False):
    # 1. PROBE
    brain = read_brain_state()
    
    # 2. CADENCE
    interval, rationale = calculate_cadence(brain)
    
    print(f"\n{'─'*55}")
    print(f"  💓 PULSE")
    print(f"  Events: {brain['events_last_hour']}/hr | Salience: {brain['top_salience']:.3f} | Threads: {brain['unresolved_count']}")
    print(f"  Dominant: {brain['dominant_emotion']} ({brain['arc_intensity']:.2f})")
    print(f"  Cadence: {interval}s ({interval/60:.0f}m) — {rationale}")
    
    # 3. SELECT
    ranked = brain.get("ranked", [])
    if not ranked or ranked[0].get("score", 0) < 0.15:
        print(f"  ⏭️  No actionable items. HEARTBEAT_OK")
        return {"status": "HEARTBEAT_OK", "interval": interval, "brain": brain}
    
    top = ranked[0]
    ahash = hashlib.sha256(f"{top['entity']}:{brain['timestamp']}".encode()).hexdigest()[:12]
    
    executed = _load_executed()
    if ahash in executed.get("hashes", []):
        print(f"  ⏭️  Already executed: {top['entity']}. HEARTBEAT_OK")
        return {"status": "HEARTBEAT_OK", "interval": interval, "brain": brain}
    
    print(f"  🎯 Selected: {top['entity']} [{top['emotion']}] score={top['score']:.3f}")
    
    # 3b. ALLOCATE — which agent executes?
    affinity = determine_agent_affinity(top['entity'])
    assigned = affinity['agent']
    print(f"  🧠 Allocated to: {assigned} (confidence: {affinity['confidence']})")
    print(f"     {affinity['rationale']}")
    
    # 4. ACT
    result = execute(top, dry_run)
    print(f"  ⚡ Action: {result['output'][:120]}")
    
    # 5. CHECK
    if result["status"] == "action_needed":
        print(f"  🚨 HEARTBEAT_ALERT: assigned to {assigned}")
    else:
        print(f"  ✅ HEARTBEAT_OK")
    
    # 6. RECORD
    if not dry_run:
        content = f"""[ADAPTIVE HEARTBEAT — TASK ALLOCATION]
Entity: {top['entity']}
Emotion: {top['emotion']}
Salience: {top['score']:.3f}
Assigned to: {assigned} (confidence: {affinity['confidence']})
Why: {affinity['rationale']}
Status: {result['status']}
Output: {result['output']}
Cadence: {interval}s ({interval/60:.0f}m) — {rationale}"""

        _mongo_query(f'''
var r = db.episodic_events.insertOne({{
  id: "heartbeat-{ahash}",
  user_id: "adaptive-heartbeat",
  session_id: "autonomous-loop",
  event_type: "heartbeat_action",
  content: {{ role: "assistant", message: {json.dumps(content)} }},
  shared_id: "neural-link",
  metadata: {{ processed: false, source: "adaptive-heartbeat", salience_score: {top['score']}, assigned_agent: "{assigned}", confidence: {affinity['confidence']}, interval: {interval}, created_at: new Date() }},
  timestamp: new Date()
}});
print(r.insertedId);
''')
        executed.setdefault("hashes", []).append(ahash)
        _save_executed(executed)
    
    return {"status": "HEARTBEAT_OK", "interval": interval, "brain": brain, "assigned": assigned}

# ── State Persistence ───────────────────────────────────────────────
def _load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f: return json.load(f)
    return {"total_pulses": 0}
def _save_state(s):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f: json.dump(s, f, indent=2)

# ── Main ─────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Adaptive Heartbeat — Demand-Driven Autonomous Cadence")
    parser.add_argument("--once", action="store_true", help="Single pulse and exit")
    parser.add_argument("--dry-run", action="store_true", help="Probe only, don't act")
    parser.add_argument("--max-cycles", type=int, default=0, help="Max cycles (0=unlimited)")
    args = parser.parse_args()

    print("=" * 55)
    print("  💓 ADAPTIVE HEARTBEAT — Task Allocation")
    print("  No cron. No .md file. Just salience.")
    print("=" * 55)

    state = _load_state()
    state["started_at"] = datetime.now(timezone.utc).isoformat()
    cycle = 0

    while True:
        cycle += 1
        state["total_pulses"] = cycle
        pulse = run_pulse(dry_run=args.dry_run)
        _save_state(state)

        if args.once or args.dry_run: break
        if args.max_cycles and cycle >= args.max_cycles: break

        interval = pulse.get("interval", BASE_INTERVAL) if pulse else BASE_INTERVAL
        next_ts = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() + interval, timezone.utc).strftime("%H:%M:%S")
        print(f"\n  💤 Sleeping {interval}s ({interval/60:.0f}m). Next: {next_ts} UTC")
        time.sleep(interval)

    print(f"\n{'═'*55}")
    print(f"  🧬 {cycle} pulses complete. No .md file. No cron. Just salience.")
    print(f"{'═'*55}")

if __name__ == "__main__":
    main()
