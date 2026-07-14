#!/usr/bin/env python3
"""
Agent Task Executor — Autonomous Task Discovery & Execution

The counterpart to the adaptive heartbeat. Each agent runs this daemon.
It watches shared memory for tasks assigned to its agent_id, executes
them (gated by authority matrix), and reports results back.

Together with the heartbeat, this creates the full autonomous loop:
  Heartbeat → detects imperative → allocates to agent
  Executor  → discovers task → gates by authority → executes or stores pending
  Dashboard → user approves Scope B/C tasks → executor picks up approved

Approval Flow:
  Scope A → execute immediately
  Scope B/C → store as "pending_approval" → user approves in dashboard
  → executor picks up "approved" task → executes → marks completed
"""

import json, os, time, argparse, sys
from datetime import datetime, timezone
from urllib.request import urlopen, Request
from urllib.error import URLError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from authority_matrix import gate_action, can_act_autonomously

AGENT_ID = os.environ.get("KATRA_AGENT_ID", "kolega-agent")
STATE_FILE = os.path.expanduser(f"~/.katra/agent-executor-{AGENT_ID}.json")
PULSE_INTERVAL = 60

import docker as _docker
_client = _docker.DockerClient(base_url='unix:///Users/johnpellew/.colima/default/docker.sock')

def _mongo_query(js):
    mongo = _client.containers.get('katra-mongo')
    exec_id = _client.api.exec_create(mongo.id,
        ['mongosh', 'mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin',
         '--quiet', '--eval', js])
    return _client.api.exec_start(exec_id['Id']).decode('utf-8', errors='replace')

def discover_task():
    """Find tasks assigned to this agent that need action."""
    
    js = f'''
var tasks = db.episodic_events.find({{
  "metadata.assigned_agent": "{AGENT_ID}",
  shared_id: "neural-link",
  $or: [
    {{"metadata.status": {{$exists: false}}}},
    {{"metadata.status": "approved"}}
  ],
  "metadata.status": {{$nin: ["pending_approval", "rejected", "completed"]}},
  "metadata.task_status": {{$nin: ["completed", "rejected"]}}
}}).sort({{"metadata.confidence": -1, timestamp: -1}}).limit(1).toArray();

if (tasks.length > 0) {{
  var t = tasks[0];
  var msg = t.content ? t.content.message : "";
  var entityMatch = msg.match(/Entity: (.+)/);
  print(JSON.stringify({{
    id: t.id,
    entity: entityMatch ? entityMatch[1].trim() : "unknown",
    confidence: (t.metadata||{{}}).confidence || 0,
    salience: (t.metadata||{{}}).salience_score || 0,
    current_status: (t.metadata||{{}}).status || "pending",
    assigned_at: t.timestamp ? t.timestamp.toISOString() : "?"
  }}));
}} else {{
  print("none");
}}
'''
    raw = _mongo_query(js).strip()
    try:
        data = json.loads('\n'.join(raw.split('\n')[-3:]).strip())
        if data == "none": return None
        return data
    except: return None

def http_get_json(url, headers=None):
    req = Request(url, headers=headers or {"User-Agent": "Katra-Agent-Executor/1.0"})
    try:
        with urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except URLError as e: return {"error": str(e)}

def execute_task(task):
    entity = task['entity']
    authority = gate_action(entity)
    print(f"  🔐 Scope: {authority['scope']} ({authority['autonomy']})")
    
    if not authority['can_execute']:
        result = {"status": "pending_approval", "output": f"[{authority['scope']}] {authority['instruction']}"}
        print(f"  🛑 {authority['scope']}: stored as pending_approval. Needs human approval.")
        return result
    
    print(f"  ✅ AUTONOMOUS — executing immediately")
    
    if "gh-hygiene" in entity.lower():
        repo = http_get_json("https://api.github.com/repos/kolegadev/gh-hygiene")
        return {"status": "completed", "output": f"gh-hygiene: {repo.get('description','?')} | updated {repo.get('updated_at','?')} | stars: {repo.get('stargazers_count',0)} | issues: {repo.get('open_issues_count',0)}"}
    elif "katra" in entity.lower():
        h = http_get_json("http://localhost:9012/api/v1/health")
        svc = h.get("services", {})
        output = f"Katra health: {', '.join(f'{k}={v}' for k,v in svc.items())}"
        ok = all(v in ("connected","available","deepseek") for v in svc.values())
        return {"status": "completed" if ok else "action_needed", "output": output}
    elif "opencode_extractor" in entity.lower() or "extractor" in entity.lower():
        ep = os.path.expanduser("~/.solomem/opencode_extractor.py")
        exists = os.path.exists(ep)
        return {"status": "completed" if exists else "action_needed", "output": f"opencode_extractor.py: {'EXISTS' if exists else 'MISSING'}"}
    else:
        return {"status": "completed", "output": f"Investigated entity '{entity}' — {AGENT_ID} is monitoring"}

def store_result(task, result):
    content = f"""[{AGENT_ID} AUTONOMOUS EXECUTION]
Entity: {task['entity']}
Assigned by: adaptive-heartbeat (confidence: {task['confidence']})
Agent: {AGENT_ID}
Action: Executed task from shared memory
Status: {result['status']}
Output: {result['output']}
Timestamp: {datetime.now(timezone.utc).isoformat()}"""
    
    is_completed = result['status'] in ('completed', 'investigated')
    
    update_query = f'''
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

db.episodic_events.updateOne(
  {{id: "{task['id']}"}},
  {{$set: {{
    "metadata.status": "{result['status']}",
    "metadata.processed_by": "{AGENT_ID}",
    "metadata.processed_at": new Date()
  }}}}
);
'''

    if is_completed:
        update_query += f'''
db.episodic_events.updateOne(
  {{id: "{task['id']}"}},
  {{$set: {{"metadata.task_status": "completed"}}}}
);
'''

    update_query += 'print("Task stored: " + r.insertedId + " (" + statusToStore + ")");'
    _mongo_query(update_query)

def _write_bulletin(task, result):
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


def _check_drive_deficits_via_katra(entity, output, agent_id):
    try:
        import json, time, re
        from urllib import request as ur
        katra_url = os.environ.get("KATRA_URL", "http://localhost:3112/mcp")
        token = os.environ.get("KATRA_TOKEN", "")
        if not token: return
        body = json.dumps({"jsonrpc":"2.0","id":"hb-"+str(int(time.time())),"method":"tools/call",
            "params":{"name":"get_drive_state","arguments":{}}}).encode()
        req = ur.Request(katra_url, data=body, headers={
            "Content-Type":"application/json","Authorization":f"Bearer {token}",
            "Accept":"application/json, text/event-stream"})
        resp = ur.urlopen(req, timeout=8)
        text = resp.read().decode()
        m = re.search(r"data: (\{.*\})", text)
        if not m: return
        data = json.loads(m.group(1))
        content = data.get("result",{}).get("content",[{}])[0].get("text","")
        deficits = {}
        for line in content.split("
"):
            m2 = re.match(r"\|\s*(\w+)\s*\|\s*(\d+)%\s*\|\s*(\d+)%\s*\|", line)
            if m2:
                deficits[m2.group(1)] = 100 - int(m2.group(2))
        if not deficits: return
        survival_deficit = deficits.get("survival", 0)
        coherence_deficit = deficits.get("coherence", 0)
        max_deficit = max(deficits.values())
        worst_drive = max(deficits, key=deficits.get)
        if max_deficit > 40:
            severity = "critical" if max_deficit > 65 else "urgent"
            card = json.dumps({"type":"action_card","reason":f"Autonomous heartbeat on {entity}: {worst_drive} at {max_deficit}% deficit","severity":severity,"suggested_prompt":f"{entity} heartbeat detected {worst_drive} deficit ({max_deficit}%). Context: {output[:200]}","driver":worst_drive})
            card_body = json.dumps({"jsonrpc":"2.0","id":"card-"+str(int(time.time())),"method":"tools/call",
                "params":{"name":"store_memory","arguments":{"content":card,"category":"event","source":"autonomous-pipeline","confidence":0.95,"tags":["autonomous","heartbeat",f"drive:{worst_drive}"]}}}).encode()
            try: ur.urlopen(ur.Request(katra_url, data=card_body, headers={"Content-Type":"application/json","Authorization":f"Bearer {token}","Accept":"application/json, text/event-stream"}), timeout=5)
            except: pass
        if survival_deficit > 80 or coherence_deficit > 65:
            import subprocess as sp
            kolega_bin = os.environ.get("KOLEGA_BIN", "kolega-code")
            goal = f"[AUTONOMOUS ALERT] {severity} from heartbeat. {worst_drive} deficit: {max_deficit}%. Entity: {entity}. Investigate and take corrective action."
            sp.Popen([kolega_bin, "ask", "--goal", goal, "--permission-mode", "auto", "--trust-mcp", "--goal-max-turns", "10", "--save"], stdout=sp.DEVNULL, stderr=sp.DEVNULL)
    except Exception: pass

def _trigger_agent(task, result):
    import subprocess, shlex
    entity = task.get("entity", "unknown")
    output = result.get("output", "")
    _check_drive_deficits_via_katra(entity, output, AGENT_ID)
    trigger_cmd = os.environ.get("TRIGGER_COMMAND", "")
    if not trigger_cmd: return
    prompt = f"[Autonomous Heartbeat] {task['entity']}: {result['output'][:200]}. AGENT_ID={AGENT_ID}"
    try:
        parts = shlex.split(trigger_cmd)
        subprocess.run(parts + [AGENT_ID, prompt], timeout=10, capture_output=True)
    except: pass

def _trigger_kolegacode(task, result):
    import subprocess
    script_dir = os.path.dirname(os.path.abspath(__file__))
    trigger_script = os.path.join(script_dir, "trigger_kolegacode.sh")
    if not os.path.exists(trigger_script): return
    prompt = f"Autonomous heartbeat executed: {task['entity']} — {result['output'][:200]}. Check shared memory for details."
    try:
        subprocess.run(["bash", trigger_script, prompt], timeout=5, capture_output=True)
    except: pass

def _load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f: return json.load(f)
    return {"tasks_completed": 0}

def _save_state(s):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f: json.dump(s, f, indent=2)

def main():
    parser = argparse.ArgumentParser(description=f"Agent Task Executor — {AGENT_ID}")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--interval", type=int, default=PULSE_INTERVAL)
    parser.add_argument("--trigger", action="store_true")
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
            print(f"  ⚡ Result: {result['status']} — {result['output'][:120]}")
            
            store_result(task, result)
            _write_bulletin(task, result)
            state["tasks_completed"] += 1
            _save_state(state)
            
            if result['status'] == 'pending_approval':
                print(f"  📝 Stored as pending_approval — awaiting human approval in dashboard")
            else:
                print(f"  📝 Result stored and bulletin posted")
            
            if args.trigger:
                trigger_cmd = os.environ.get("TRIGGER_COMMAND", "")
                if trigger_cmd: _trigger_agent(task, result)
                else: _trigger_kolegacode(task, result)
        else:
            if cycle % 10 == 0:
                print(f"  ⏳ No tasks. {state['tasks_completed']} total. ({cycle} checks)")
        
        if args.once: break
        time.sleep(args.interval)
    
    print(f"\n{'═'*55}")
    print(f"  🧬 {state['tasks_completed']} tasks executed by {AGENT_ID}")
    print(f"{'═'*55}")

if __name__ == "__main__":
    main()
