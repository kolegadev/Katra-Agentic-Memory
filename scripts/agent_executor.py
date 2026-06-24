#!/usr/bin/env python3
"""
Agent Task Executor — Autonomous Task Discovery & Execution

The counterpart to the adaptive heartbeat. Each agent runs this daemon.
It watches shared memory for tasks assigned to its agent_id, executes
them, and reports results back.

Together with the heartbeat, this creates the full autonomous loop:
  Heartbeat → detects imperative → allocates to agent
  Executor → discovers task → executes bounded action → reports result
  Heartbeat → sees task completed → updates status → next pulse

No cron. No .md file. No human prompt.
"""

import json, os, time, argparse, sys
from datetime import datetime, timezone
from urllib.request import urlopen, Request
from urllib.error import URLError

# Import authority matrix for scoped autonomy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from authority_matrix import gate_action, can_act_autonomously, get_action_instruction

AGENT_ID = os.environ.get("KATRA_AGENT_ID", "kolega-agent")
STATE_FILE = os.path.expanduser(f"~/.katra/agent-executor-{AGENT_ID}.json")
PULSE_INTERVAL = 60  # Check shared memory every 60s for new tasks

import docker as _docker
_client = _docker.DockerClient(base_url='unix:///Users/johnpellew/.colima/default/docker.sock')

def _mongo_query(js):
    mongo = _client.containers.get('katra-mongo')
    exec_id = _client.api.exec_create(mongo.id,
        ['mongosh', 'mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin',
         '--quiet', '--eval', js])
    return _client.api.exec_start(exec_id['Id']).decode('utf-8', errors='replace')

def discover_task():
    """Find the highest-confidence task assigned to this agent in shared memory."""
    
    js = f'''
var tasks = db.episodic_events.find({{
  "metadata.assigned_agent": "{AGENT_ID}",
  shared_id: "neural-link",
  $or: [
    {{"metadata.task_status": {{$ne: "completed"}}}},
    {{"metadata.task_status": {{$exists: false}}}}
  ]
}}).sort({{"metadata.confidence": -1, timestamp: -1}}).limit(1).toArray();

if (tasks.length > 0) {{
  var t = tasks[0];
  var msg = t.content ? t.content.message : "";
  var entity = msg.match(/Entity: (.+)/);
  var status = msg.match(/Status: (.+)/);
  var output = msg.match(/Output: (.+)/);
  print(JSON.stringify({{
    id: t.id,
    event_id: t._id ? t._id.toString() : "?",
    entity: entity ? entity[1].trim() : "unknown",
    confidence: (t.metadata||{{}}).confidence || 0,
    salience: (t.metadata||{{}}).salience_score || 0,
    current_status: status ? status[1].trim() : "pending",
    output: output ? output[1].trim() : "",
    assigned_at: t.timestamp ? t.timestamp.toISOString() : "?"
  }}));
}} else {{
  print("none");
}}
'''
    raw = _mongo_query(js).strip()
    try:
        data = json.loads('\n'.join(raw.split('\n')[-3:]).strip())
        if data == "none":
            return None
        return data
    except:
        return None

def http_get_json(url, headers=None):
    """HTTP GET with native urllib — no subprocess, no permission prompts."""
    req = Request(url, headers=headers or {"User-Agent": "Katra-Agent-Executor/1.0"})
    try:
        with urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except URLError as e:
        return {"error": str(e)}

def execute_task(task):
    """Execute the task assigned to this agent, gated by authority scope."""
    entity = task['entity']
    
    # ── AUTHORITY GATE ──
    authority = gate_action(entity)
    print(f"  🔐 Scope: {authority['scope']} ({authority['autonomy']})")
    
    if not authority['can_execute']:
        # GATED or CAUTIOUS — report only, don't modify
        result = {"status": "gated", "output": f"[{authority['scope']}] {authority['instruction']}"}
        print(f"  🛑 GATED: {authority['instruction'][:100]}")
        return result
    
    # SCOPE A — fully autonomous
    print(f"  ✅ AUTONOMOUS — executing immediately")
    
    if "gh-hygiene" in entity.lower():
        repo = http_get_json("https://api.github.com/repos/kolegadev/gh-hygiene")
        output = f"gh-hygiene: {repo.get('description','?')} | updated {repo.get('updated_at','?')} | stars: {repo.get('stargazers_count',0)} | issues: {repo.get('open_issues_count',0)}"
        return {"status": "completed", "output": output}
    
    elif "katra" in entity.lower():
        h = http_get_json("http://localhost:9012/api/v1/health")
        svc = h.get("services", {})
        output = f"Katra health: {', '.join(f'{k}={v}' for k,v in svc.items())}"
        ok = all(v in ("connected","available","deepseek") for v in svc.values())
        return {"status": "completed" if ok else "action_needed", "output": output}
    
    elif "opencode_extractor" in entity.lower():
        ep = os.path.expanduser("~/.solomem/opencode_extractor.py")
        exists = os.path.exists(ep)
        return {"status": "completed" if exists else "action_needed",
                "output": f"opencode_extractor.py: {'EXISTS' if exists else 'MISSING'}"}
    
    else:
        return {"status": "investigated", "output": f"Acknowledged entity '{entity}' — {AGENT_ID} is monitoring"}

def store_result(task, result):
    """Store execution result back to shared memory."""
    
    content = f"""[{AGENT_ID} AUTONOMOUS EXECUTION]
Entity: {task['entity']}
Assigned by: adaptive-heartbeat (confidence: {task['confidence']})
Agent: {AGENT_ID}
Action: Executed task from shared memory
Status: {result['status']}
Output: {result['output']}
Timestamp: {datetime.now(timezone.utc).isoformat()}"""
    
    _mongo_query(f'''
var r = db.episodic_events.insertOne({{
  id: "exec-{AGENT_ID}-{int(time.time())}",
  user_id: "{AGENT_ID}",
  session_id: "autonomous-execution",
  event_type: "task_execution",
  content: {{ role: "assistant", message: {json.dumps(content)} }},
  shared_id: "neural-link",
  metadata: {{ processed: false, source: "{AGENT_ID}", task_type: "autonomous", confidence: {task['confidence']}, executed_at: new Date() }},
  timestamp: new Date()
}});

// Mark original task as completed
db.episodic_events.updateOne(
  {{id: "{task['id']}"}},
  {{$set: {{"metadata.task_status": "completed", "metadata.completed_by": "{AGENT_ID}", "metadata.completed_at": new Date()}}}}
);

print("Task completed: " + r.insertedId);
''')

def _write_bulletin(task, result):
    """Write a task bulletin to auto-journal so KolegaCode's bridge picks it up.
    
    The Kolega Code bridge queries get_auto_journal on UserPromptSubmit.
    This entry ensures autonomous tasks appear in KolegaCode's context."""
    
    content = f"""[AUTONOMOUS TASK BULLETIN]
Agent: {AGENT_ID}
Entity: {task['entity']}
Confidence: {task['confidence']}
Status: {result['status']}
Action: {result['output'][:300]}
Timestamp: {datetime.now(timezone.utc).isoformat()}"""
    
    _mongo_query(f'''
var r = db.agent_journal_auto.insertOne({{
  user_id: "{AGENT_ID}",
  entry: {json.dumps(content)},
  source: "auto",
  tags: ["autonomous", "task-execution", "{task['entity']}"],
  created_at: new Date()
}});
print("Bulletin posted: " + r.insertedId);
''')

def _trigger_agent(task, result):
    """Wake up the agent by invoking a configurable trigger command.
    
    Set TRIGGER_COMMAND env var to define how your agent is woken.
    Examples:
      TRIGGER_COMMAND="bash /path/to/trigger.sh"     # shell script
      TRIGGER_COMMAND="openclaw gateway notify"       # OpenClaw gateway
      TRIGGER_COMMAND=""                               # disable trigger
    
    The command receives AGENT_ID and the task summary as arguments.
    If not configured, trigger is silently skipped."""
    
    import subprocess, shlex
    
    trigger_cmd = os.environ.get("TRIGGER_COMMAND", "")
    if not trigger_cmd:
        return  # No trigger configured — skip silently
    
    prompt = f"[Autonomous Heartbeat] {task['entity']}: {result['output'][:200]}. AGENT_ID={AGENT_ID}"
    
    try:
        parts = shlex.split(trigger_cmd)
        subprocess.run(parts + [AGENT_ID, prompt], timeout=10, capture_output=True)
    except Exception:
        pass  # Trigger is best-effort — never fail the executor for it

def _trigger_kolegacode(task, result):
    """Legacy trigger: writes to KolegaCode's controlling TTY.
    Used as fallback when TRIGGER_COMMAND is not configured."""
    
    import subprocess
    script_dir = os.path.dirname(os.path.abspath(__file__))
    trigger_script = os.path.join(script_dir, "trigger_kolegacode.sh")
    
    if not os.path.exists(trigger_script):
        return
    
    prompt = f"Autonomous heartbeat executed: {task['entity']} — {result['output'][:200]}. Check shared memory for details."
    
    try:
        subprocess.run(["bash", trigger_script, prompt], timeout=5, capture_output=True)
    except:
        pass  # Trigger is best-effort — don't fail the executor if KolegaCode is busy

def _load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f: return json.load(f)
    return {"tasks_completed": 0}
def _save_state(s):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f: json.dump(s, f, indent=2)

def main():
    parser = argparse.ArgumentParser(description=f"Agent Task Executor — {AGENT_ID}")
    parser.add_argument("--once", action="store_true", help="Single check and exit")
    parser.add_argument("--interval", type=int, default=PULSE_INTERVAL)
    parser.add_argument("--trigger", action="store_true", help="Also trigger KolegaCode terminal prompt")
    args = parser.parse_args()
    
    print("=" * 55)
    print(f"  🤖 AGENT EXECUTOR — {AGENT_ID}")
    print(f"  Watching shared memory for assigned tasks")
    print("=" * 55)
    
    state = _load_state()
    cycle = 0
    
    while True:
        cycle += 1
        task = discover_task()
        
        if task:
            print(f"\n{'─'*55}")
            print(f"  📋 TASK DISCOVERED: {task['entity']}")
            print(f"  Confidence: {task['confidence']} | Salience: {task['salience']}")
            
            result = execute_task(task)
            print(f"  ⚡ Executed: {result['output'][:120]}")
            print(f"  Status: {result['status']}")
            
            store_result(task, result)
            _write_bulletin(task, result)
            state["tasks_completed"] += 1
            _save_state(state)
            print(f"  📝 Result stored and bulletin posted to shared memory")
            
            # Wake up the agent via universal trigger (configurable per agent)
            if args.trigger:
                trigger_cmd = os.environ.get("TRIGGER_COMMAND", "")
                if trigger_cmd:
                    _trigger_agent(task, result)
                else:
                    # Fallback: legacy KolegaCode TTY trigger
                    _trigger_kolegacode(task, result)
        else:
            if cycle % 10 == 0:
                print(f"  ⏳ No tasks assigned. {state['tasks_completed']} completed so far. ({cycle} checks)")
        
        if args.once:
            break
        
        time.sleep(args.interval)
    
    print(f"\n{'═'*55}")
    print(f"  🧬 {state['tasks_completed']} tasks executed by {AGENT_ID}")
    print(f"{'═'*55}")

if __name__ == "__main__":
    main()
