#!/bin/bash
# REST API recall across users
API_URL="http://localhost:9012"
API_KEY="katra-admin-key-2026"

api_get() {
  curl -s -H "Authorization: Bearer $API_KEY" "$API_URL$1"
}

echo "═══════════════════════════════════════════════════"
echo " SEMANTIC FACTS (all users, top 20)"
echo "═══════════════════════════════════════════════════"
for uid in "kolega-agent" "test-suite" "rest-test-suite"; do
  echo "--- $uid ---"
  api_get "/api/v1/memory/semantic/facts?user_id=$uid&limit=5" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('results',d.get('facts',[]))
for f in r[:5]:
    print(f'  - {f.get(\"content\", f.get(\"fact\", str(f)))[:120]}')
" 2>/dev/null
done

echo ""
echo "═══════════════════════════════════════════════════"
echo " EPISODIC EVENTS (all users, last 20)"
echo "═══════════════════════════════════════════════════"
for uid in "kolega-agent" "test-suite" "rest-test-suite"; do
  echo "--- $uid ---"
  api_get "/api/v1/memory/episodic/events?user_id=$uid&limit=5" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('results',d.get('events',[]))
for e in r[:5]:
    content = e.get('content','')
    if isinstance(content, dict):
        content = content.get('message', str(content))
    ts = e.get('timestamp', e.get('created_at','?'))
    print(f'  [{ts}] {content[:120]}')
" 2>/dev/null
done

echo ""
echo "═══════════════════════════════════════════════════"
echo " KNOWLEDGE GRAPH NODES"
echo "═══════════════════════════════════════════════════"
api_get "/api/v1/memory/knowledge-graph?limit=30" | python3 -c "
import sys,json
d=json.load(sys.stdin)
nodes=d.get('nodes', d.get('data',{}).get('nodes',[]))
for n in nodes[:20]:
    print(f'  - {n.get(\"name\", n.get(\"id\", str(n)))} ({n.get(\"type\",\"?\")})')
" 2>/dev/null
