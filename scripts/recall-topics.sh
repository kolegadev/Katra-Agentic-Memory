#!/bin/bash
# Query Katra memory for topics covered since installation
MCP="http://localhost:3112/mcp"
KEY="katra-mcp-key-2026"

SID=$(curl -s -D - -o /dev/null -X POST "$MCP" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"recall-query","version":"1"}}}' \
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

echo "═══════════════════════════════════════════════════"
echo " 1. COMPREHENSIVE SEARCH: 'topics covered installation testing'"
echo "═══════════════════════════════════════════════════"
mcp_call "search_memories" '{"query":"topics covered installation testing","user_id":"kolega-agent","limit":20}'
echo ""

echo "═══════════════════════════════════════════════════"
echo " 2. TEMPORAL RECALL: last 7 days"
echo "═══════════════════════════════════════════════════"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PAST=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)
mcp_call "temporal_recall" "{\"user_id\":\"kolega-agent\",\"start_time\":\"$PAST\",\"end_time\":\"$NOW\",\"limit\":20}"
echo ""

echo "═══════════════════════════════════════════════════"
echo " 3. PATTERN DETECTION"
echo "═══════════════════════════════════════════════════"
mcp_call "detect_patterns" '{"user_id":"kolega-agent"}'
echo ""

echo "═══════════════════════════════════════════════════"
echo " 4. AUTO-JOURNAL (distilled insights)"
echo "═══════════════════════════════════════════════════"
mcp_call "get_auto_journal" '{"user_id":"kolega-agent","limit":10}'
echo ""

echo "═══════════════════════════════════════════════════"
echo " 5. KNOWLEDGE GRAPH: recent entities"
echo "═══════════════════════════════════════════════════"
mcp_call "explore_graph" '{"query":"test memory bug fix","limit":20}'
echo ""
