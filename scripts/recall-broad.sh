#!/bin/bash
# Broad memory recall across all test user IDs
MCP="http://localhost:3112/mcp"
KEY="katra-mcp-key-2026"

SID=$(curl -s -D - -o /dev/null -X POST "$MCP" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"recall-broad","version":"1"}}}' \
  | grep -i mcp-session-id | tr -d '\r' | awk '{print $2}')

curl -s -X POST "$MCP" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null

mcp_call() {
  local name="$1" args="$2"
  curl -s -X POST "$MCP" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "mcp-session-id: $SID" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$args}}" \
    | python3 -c "
import sys,json
raw=sys.stdin.read()
if raw.startswith('event:'):
    for line in raw.split('\n'):
        if line.startswith('data: '):
            raw=line[6:]
            break
d=json.loads(raw)
tc=d.get('result',{}).get('content',[])
if tc and isinstance(tc,list) and len(tc)>0:
    print(tc[0].get('text',''))
else:
    print(json.dumps(d.get('result',d.get('error','?')),indent=2))
" 2>/dev/null
}

query_user() {
  local uid="$1"
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo " USER: $uid"
  echo "═══════════════════════════════════════════════════"

  echo "--- search 'memory test bug fix' ---"
  mcp_call "search_memories" "{\"query\":\"memory test bug fix\",\"user_id\":\"$uid\",\"limit\":10}"

  echo "--- search 'Mercedes Jersey dark mode' ---"
  mcp_call "search_memories" "{\"query\":\"Mercedes Jersey dark mode\",\"user_id\":\"$uid\",\"limit\":10}"

  echo "--- temporal recall last 24h ---"
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  PAST=$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)
  mcp_call "temporal_recall" "{\"user_id\":\"$uid\",\"start_time\":\"$PAST\",\"end_time\":\"$NOW\",\"limit\":10}"
}

for uid in "kolega-agent" "test-suite" "rest-test-suite"; do
  query_user "$uid"
done

echo ""
echo "═══════════════════════════════════════════════════"
echo " GLOBAL SEARCH (no user_id)"
echo "═══════════════════════════════════════════════════"
mcp_call "search_memories" '{"query":"memory test installation bug fix","limit":20}'

echo ""
echo "═══════════════════════════════════════════════════"
echo " SEMANTIC FACTS FOR test-suite"
echo "═══════════════════════════════════════════════════"
mcp_call "search_memories" '{"query":"Mercedes C63 AMG Jersey","user_id":"test-suite","limit":10}'

echo ""
echo "═══════════════════════════════════════════════════"
echo " JOURNAL ENTRIES FOR test-suite"
echo "═══════════════════════════════════════════════════"
mcp_call "get_journal" '{"user_id":"test-suite","limit":10}'
