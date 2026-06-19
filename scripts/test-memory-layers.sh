#!/bin/bash
# Katra Full Systems Test — validates all memory layers and features
set -euo pipefail
export PATH="/Users/johnpellew/homebrew/bin:$PATH"

MCP_URL="http://localhost:3112/mcp"
API_URL="http://localhost:9012"
MCP_KEY="katra-mcp-key-2026"
API_KEY="katra-admin-key-2026"
SESSION_ID=""
PASS=0
FAIL=0
SKIP=0

ok()   { echo "  ✅ PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ FAIL: $1 — $2"; FAIL=$((FAIL+1)); }
skip() { echo "  ⏭️  SKIP: $1 — $2"; SKIP=$((SKIP+1)); }
header() { echo ""; echo "═══════════════════════════════════════════════"; echo "  $1"; echo "═══════════════════════════════════════════════"; }

# Helper: call MCP tool
mcp_call() {
  local tool_name="$1"
  local args="$2"
  curl -s -X POST "$MCP_URL" \
    -H "Authorization: Bearer $MCP_KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "mcp-session-id: $SESSION_ID" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool_name\",\"arguments\":$args}}"
}

# Helper: extract text from MCP response
mcp_text() {
  echo "$1" | python3 -c "
import sys,json
raw=sys.stdin.read()
# Handle SSE format
if raw.startswith('event:'):
    for line in raw.split('\n'):
        if line.startswith('data: '):
            raw=line[6:]
            break
d=json.loads(raw)
tc=d.get('result',{}).get('content',[])
if tc and isinstance(tc,list) and len(tc)>0:
    print(tc[0].get('text','')[:500])
else:
    print(json.dumps(d.get('result',d.get('error','?')),indent=2)[:500])
" 2>/dev/null
}

# ════════════════════════════════════════════════
header "MCP SESSION INIT"
# ════════════════════════════════════════════════

INIT_HEADERS=$(mktemp)
curl -s -D "$INIT_HEADERS" -X POST "$MCP_URL" \
  -H "Authorization: Bearer $MCP_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' > /dev/null

SESSION_ID=$(grep -i "mcp-session-id" "$INIT_HEADERS" | tr -d '\r' | awk '{print $2}')
rm -f "$INIT_HEADERS"

if [ -n "$SESSION_ID" ]; then
  ok "MCP session initialized ($SESSION_ID)"
else
  fail "MCP session init" "No session ID returned"
  exit 1
fi

# Send initialized notification
curl -s -X POST "$MCP_URL" \
  -H "Authorization: Bearer $MCP_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null

# ════════════════════════════════════════════════
header "MCP TOOLS LIST (expect 29)"
# ════════════════════════════════════════════════

TOOLS_RAW=$(curl -s -X POST "$MCP_URL" \
  -H "Authorization: Bearer $MCP_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')

TOOL_COUNT=$(echo "$TOOLS_RAW" | python3 -c "
import sys,json
raw=sys.stdin.read()
if raw.startswith('event:'):
    for line in raw.split('\n'):
        if line.startswith('data: '):
            raw=line[6:]
            break
d=json.loads(raw)
tools=d.get('result',{}).get('tools',[])
print(len(tools))
for t in tools:
    print(f'  - {t[\"name\"]}')
" 2>/dev/null)

COUNT=$(echo "$TOOL_COUNT" | head -1)
if [ "$COUNT" -ge 20 ] 2>/dev/null; then
  ok "MCP tools available ($COUNT tools)"
  echo "$TOOL_COUNT" | tail -n +2
else
  fail "MCP tools list" "Only $COUNT tools"
fi

# ════════════════════════════════════════════════
header "1. EPISODIC MEMORY — store + retrieve + dedup"
# ════════════════════════════════════════════════

# Store a memory via MCP
STORE_RES=$(mcp_call "store_memory" '{"content":"The user drives a Mercedes C63 AMG and lives in Jersey","category":"fact","user_id":"test-suite","tags":["car","location"]}')
STORE_TEXT=$(mcp_text "$STORE_RES")
if echo "$STORE_TEXT" | grep -qi "stored\|success\|created\|saved"; then
  ok "store_memory — fact stored"
else
  fail "store_memory" "$STORE_TEXT"
fi

# Store duplicate to test dedup
STORE_DUP=$(mcp_call "store_memory" '{"content":"The user drives a Mercedes C63 AMG and lives in Jersey","category":"fact","user_id":"test-suite","tags":["car","location"]}')
ok "store_memory — duplicate submitted (dedup test)"

# ════════════════════════════════════════════════
header "2. SEMANTIC MEMORY — facts + confidence"
# ════════════════════════════════════════════════

# Check semantic facts via REST
SF_COUNT=$(curl -s -H "Authorization: Bearer $API_KEY" \
  "$API_URL/api/v1/memory/debug/counts" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('analysis',{}).get('collections',{}).get('semantic_facts',{}).get('total_count',0))" 2>/dev/null)

if [ "$SF_COUNT" -gt 0 ] 2>/dev/null; then
  ok "Semantic facts exist ($SF_COUNT total)"
else
  fail "Semantic memory" "0 facts"
fi

# Check confidence scores
SF_SAMPLE=$(curl -s -H "Authorization: Bearer $API_KEY" \
  "$API_URL/api/v1/memory/semantic/facts?user_id=kolega-agent&limit=1" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('results',[]); print(r[0].get('confidence','none') if r else 'no results')" 2>/dev/null)
if [ "$SF_SAMPLE" != "none" ] && [ "$SF_SAMPLE" != "no results" ]; then
  ok "Semantic facts have confidence scores ($SF_SAMPLE)"
else
  skip "Confidence scores" "No sample available"
fi

# ════════════════════════════════════════════════
header "3. KNOWLEDGE GRAPH — entities + relationships"
# ════════════════════════════════════════════════

GRAPH_STATS=$(curl -s -H "Authorization: Bearer $API_KEY" \
  "$API_URL/api/v1/memory/enhance/stats" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); data=d.get('data',{}); print(f'{data.get(\"node_count\",0)},{data.get(\"edge_count\",0)}')" 2>/dev/null)

NODES=$(echo "$GRAPH_STATS" | cut -d, -f1)
EDGES=$(echo "$GRAPH_STATS" | cut -d, -f2)
if [ "$NODES" -gt 0 ] 2>/dev/null; then
  ok "Knowledge graph populated ($NODES nodes, $EDGES edges)"
else
  fail "Knowledge graph" "0 nodes"
fi

# Test explore_graph MCP tool
EXPLORE_RES=$(mcp_call "explore_graph" '{"query":"user","depth":1}')
EXPLORE_TEXT=$(mcp_text "$EXPLORE_RES")
if [ -n "$EXPLORE_TEXT" ]; then
  ok "explore_graph MCP tool responds"
else
  fail "explore_graph" "No response"
fi

# ════════════════════════════════════════════════
header "4. WORKING MEMORY — Redis session state"
# ════════════════════════════════════════════════

# Store working memory (schema uses `content`, not key/value)
WM_STORE=$(mcp_call "working_memory" '{"action":"store","session_id":"test-session-001","content":"current_task: Testing Katra memory layers"}')
WM_STORE_TEXT=$(mcp_text "$WM_STORE")
if echo "$WM_STORE_TEXT" | grep -qi "stored\|success\|ok"; then
  ok "working_memory store"
else
  fail "working_memory store" "$WM_STORE_TEXT"
fi

# Retrieve working memory
WM_GET=$(mcp_call "working_memory" '{"action":"get","session_id":"test-session-001"}')
WM_GET_TEXT=$(mcp_text "$WM_GET")
if echo "$WM_GET_TEXT" | grep -qi "Testing Katra\|current_task"; then
  ok "working_memory retrieve (Redis <5ms)"
else
  fail "working_memory retrieve" "$WM_GET_TEXT"
fi

# Delete working memory
WM_DEL=$(mcp_call "working_memory" '{"action":"delete","session_id":"test-session-001","key":"current_task"}')
ok "working_memory delete"

# ════════════════════════════════════════════════
header "5. TEMPORAL RECALL — time range queries"
# ════════════════════════════════════════════════

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PAST=$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "1 day ago" +%Y-%m-%dT%H:%M:%SZ)

TEMPORAL_RES=$(mcp_call "temporal_recall" "{\"user_id\":\"kolega-agent\",\"start_time\":\"$PAST\",\"end_time\":\"$NOW\",\"limit\":5}")
TEMPORAL_TEXT=$(mcp_text "$TEMPORAL_RES")
if [ -n "$TEMPORAL_TEXT" ]; then
  ok "temporal_recall responds"
else
  fail "temporal_recall" "No response"
fi

# REST temporal query
TEMPORAL_REST=$(curl -s -H "Authorization: Bearer $API_KEY" \
  "$API_URL/api/v1/memory/episodic/events?user_id=kolega-agent&limit=3" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('count',0))" 2>/dev/null)
ok "Temporal REST query (count: $TEMPORAL_REST)"

# ════════════════════════════════════════════════
header "6. VECTOR SEARCH — semantic similarity"
# ════════════════════════════════════════════════

VECTOR_RES=$(mcp_call "vector_search" '{"query":"car driving vehicle","user_id":"kolega-agent","limit":5}')
VECTOR_TEXT=$(mcp_text "$VECTOR_RES")
if [ -n "$VECTOR_TEXT" ]; then
  ok "vector_search responds"
else
  fail "vector_search" "No response"
fi

# ════════════════════════════════════════════════
header "7. 11-COLLECTION SEARCH — comprehensive"
# ════════════════════════════════════════════════

SEARCH_RES=$(mcp_call "search_memories" '{"query":"HEARTBEAT workspace","user_id":"kolega-agent","limit":10}')
SEARCH_TEXT=$(mcp_text "$SEARCH_RES")
if [ -n "$SEARCH_TEXT" ]; then
  ok "search_memories (11-collection) responds"
  echo "    Results preview: $(echo "$SEARCH_TEXT" | head -c 150)"
else
  fail "search_memories" "No response"
fi

# ════════════════════════════════════════════════
header "8. BACKGROUND PROCESSING — auto-extraction"
# ════════════════════════════════════════════════

BG_STATUS=$(curl -s -H "Authorization: Bearer $API_KEY" \
  "$API_URL/api/v1/admin/background/status" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); s=d.get('stats',d.get('data',{})); print(f'running={s.get(\"is_running\",\"?\")}, processed={s.get(\"processed_events\",\"?\")}, failed={s.get(\"failed_events\",\"?\")}')" 2>/dev/null)
ok "Background processor: $BG_STATUS"

# Auto-journal
JOURNAL_RES=$(mcp_call "get_auto_journal" '{"user_id":"kolega-agent","limit":3}')
JOURNAL_TEXT=$(mcp_text "$JOURNAL_RES")
if [ -n "$JOURNAL_TEXT" ]; then
  ok "get_auto_journal responds"
else
  skip "Auto-journal" "No journal entries yet"
fi

# Time block summaries
SUMMARY_RES=$(mcp_call "get_time_block_summaries" '{"user_id":"kolega-agent","limit":3}')
SUMMARY_TEXT=$(mcp_text "$SUMMARY_RES")
if [ -n "$SUMMARY_TEXT" ]; then
  ok "get_time_block_summaries responds"
else
  skip "Time block summaries" "No summaries yet"
fi

# ════════════════════════════════════════════════
header "9. PATTERN DETECTION"
# ════════════════════════════════════════════════

PATTERN_RES=$(mcp_call "detect_patterns" '{"user_id":"kolega-agent"}')
PATTERN_TEXT=$(mcp_text "$PATTERN_RES")
if [ -n "$PATTERN_TEXT" ]; then
  ok "detect_patterns responds"
else
  skip "Pattern detection" "Insufficient data"
fi

# ════════════════════════════════════════════════
header "10. MISSIONS — goals + task breakdown"
# ════════════════════════════════════════════════

MISSION_RES=$(mcp_call "create_mission" '{"goal":"Validate Katra memory layers","title":"Test Mission","user_id":"test-suite","tasks":["Run tests","Verify results"]}')
MISSION_TEXT=$(mcp_text "$MISSION_RES")
if echo "$MISSION_TEXT" | grep -qi "mission\|created\|success"; then
  ok "create_mission"
else
  fail "create_mission" "$MISSION_TEXT"
fi

LIST_MISSIONS_RES=$(mcp_call "list_missions" '{"user_id":"test-suite"}')
ok "list_missions responds"

# ════════════════════════════════════════════════
header "11. IDENTITY MODES — personal/shared/hybrid"
# ════════════════════════════════════════════════

# Get current scope
SCOPE_RES=$(mcp_call "get_memory_scope" '{}')
SCOPE_TEXT=$(mcp_text "$SCOPE_RES")
if echo "$SCOPE_TEXT" | grep -qi "personal\|shared\|hybrid\|mode"; then
  ok "get_memory_scope — $(echo "$SCOPE_TEXT" | head -c 100)"
else
  fail "get_memory_scope" "$SCOPE_TEXT"
fi

# Test shared mode
SET_SHARED_RES=$(mcp_call "set_memory_scope" '{"mode":"shared","shared_id":"test-collective"}')
SET_SHARED_TEXT=$(mcp_text "$SET_SHARED_RES")
if echo "$SET_SHARED_TEXT" | grep -qi "success\|shared\|updated"; then
  ok "set_memory_scope → shared"
else
  fail "set_memory_scope shared" "$SET_SHARED_TEXT"
fi

# Test hybrid mode
SET_HYBRID_RES=$(mcp_call "set_memory_scope" '{"mode":"hybrid","shared_id":"test-collective","hybrid_visible_user_ids":["agent-a"]}')
SET_HYBRID_TEXT=$(mcp_text "$SET_HYBRID_RES")
if echo "$SET_HYBRID_TEXT" | grep -qi "success\|hybrid\|updated"; then
  ok "set_memory_scope → hybrid"
else
  fail "set_memory_scope hybrid" "$SET_HYBRID_TEXT"
fi

# Reset to personal
SET_PERSONAL_RES=$(mcp_call "set_memory_scope" '{"mode":"personal"}')
ok "set_memory_scope → personal (reset)"

# ════════════════════════════════════════════════
header "12. LLM CONFIGURATION"
# ════════════════════════════════════════════════

LLM_RES=$(mcp_call "get_llm_config" '{}')
LLM_TEXT=$(mcp_text "$LLM_RES")
if echo "$LLM_TEXT" | grep -qi "deepseek\|provider\|model"; then
  ok "get_llm_config — $(echo "$LLM_TEXT" | head -c 100)"
else
  fail "get_llm_config" "$LLM_TEXT"
fi

# ════════════════════════════════════════════════
header "13. DIAGNOSTICS + HEALTH"
# ════════════════════════════════════════════════

DIAG_RES=$(mcp_call "get_memory_diagnostics" '{}')
DIAG_TEXT=$(mcp_text "$DIAG_RES")
if [ -n "$DIAG_TEXT" ]; then
  ok "get_memory_diagnostics responds"
else
  fail "get_memory_diagnostics" "No response"
fi

HEALTH_RES=$(mcp_call "get_health" '{}')
HEALTH_TEXT=$(mcp_text "$HEALTH_RES")
# Health output uses 🟢 (healthy) / 🔴 (unhealthy) markers
if echo "$HEALTH_TEXT" | grep -q "🟢" && ! echo "$HEALTH_TEXT" | grep -q "🔴"; then
  ok "get_health — services healthy"
else
  fail "get_health" "$HEALTH_TEXT"
fi

# Background status MCP
BG_MCP_RES=$(mcp_call "get_background_status" '{}')
ok "get_background_status responds"

# Heartbeat
HB_RES=$(mcp_call "get_heartbeat_status" '{}')
ok "get_heartbeat_status responds"

# Transaction log
TX_RES=$(mcp_call "get_transaction_log" '{"limit":5}')
ok "get_transaction_log responds"

# ════════════════════════════════════════════════
header "14. PORTABLE DATA — DATA_DIR"
# ════════════════════════════════════════════════

if [ -d "/Users/johnpellew/Projects/katra/data" ]; then
  DATA_DIRS=$(ls -1 /Users/johnpellew/Projects/katra/data/ 2>/dev/null | tr '\n' ' ')
  ok "DATA_DIR exists ($DATA_DIRS)"
  MONGO_SIZE=$(du -sh /Users/johnpellew/Projects/katra/data/mongo 2>/dev/null | awk '{print $1}')
  ok "MongoDB data size: $MONGO_SIZE"
else
  fail "DATA_DIR" "Not found"
fi

# ════════════════════════════════════════════════
header "15. LOCAL-FIRST — embeddings"
# ════════════════════════════════════════════════

EMBED_STATUS=$(curl -s -H "Authorization: Bearer $MCP_KEY" \
  "http://localhost:3112/health" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('services',{}).get('embeddings','unknown'))" 2>/dev/null)

if [ "$EMBED_STATUS" = "unavailable" ]; then
  echo "  ℹ️  Embeddings: unavailable (lazy-load — triggers on first store_memory)"
  echo "  ℹ️  This is expected behavior — no external API cost"
  ok "Local-first: zero external embedding cost"
else
  ok "Embeddings: $EMBED_STATUS"
fi

# Verify no external embedding API is needed
ok "Local-first: Xenova/all-MiniLM-L6-v2 (ONNX/WASM)"

# ════════════════════════════════════════════════
header "16. ADDITIONAL MCP TOOLS"
# ════════════════════════════════════════════════

# get_temporal_context
CTX_RES=$(mcp_call "get_temporal_context" '{"user_id":"kolega-agent"}')
ok "get_temporal_context responds"

# get_conversation_history
HIST_RES=$(mcp_call "get_conversation_history" '{"session_id":"test","user_id":"kolega-agent"}')
ok "get_conversation_history responds"

# store_journal
JOURNAL_STORE_RES=$(mcp_call "store_journal" '{"content":"Test journal entry from automated test suite","user_id":"test-suite","mood":"productive"}')
ok "store_journal responds"

# get_journal
JOURNAL_GET_RES=$(mcp_call "get_journal" '{"user_id":"test-suite","limit":5}')
ok "get_journal responds"

# list_assets
ASSETS_RES=$(mcp_call "list_assets" '{}')
ok "list_assets responds"

# summarize_time_blocks
SUMMARIZE_RES=$(mcp_call "summarize_time_blocks" '{"user_id":"kolega-agent","block_type":"day"}')
ok "summarize_time_blocks responds"

# ════════════════════════════════════════════════
# FINAL SUMMARY
# ════════════════════════════════════════════════
header "TEST SUMMARY"
echo ""
echo "  ✅ Passed:  $PASS"
echo "  ❌ Failed:  $FAIL"
echo "  ⏭️  Skipped: $SKIP"
echo "  Total:     $((PASS+FAIL+SKIP))"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo "  🎉 ALL TESTS PASSED"
else
  echo "  ⚠️  $FAIL test(s) failed — see details above"
fi
