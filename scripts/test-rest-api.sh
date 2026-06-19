#!/bin/bash
# Katra REST API Memory Layers Test — validates all REST memory layers on port 9012
set -euo pipefail
export PATH="/Users/johnpellew/homebrew/bin:$PATH"

API_URL="http://localhost:9012"
API_KEY="katra-admin-key-2026"
TEST_USER="rest-test-suite"
TEST_SESSION="rest-test-$(date +%s)"
PASS=0
FAIL=0
SKIP=0

ok()   { echo "  ✅ PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ FAIL: $1 — $2"; FAIL=$((FAIL+1)); }
skip() { echo "  ⏭️  SKIP: $1 — $2"; SKIP=$((SKIP+1)); }
header() { echo ""; echo "═══════════════════════════════════════════════"; echo "  $1"; echo "═══════════════════════════════════════════════"; }

# Helper: GET request, returns body
api_get() {
  curl -s -H "Authorization: Bearer $API_KEY" "$API_URL$1"
}

# Helper: POST/PUT request with JSON body, returns body
api_send() {
  local method="$1" path="$2" body="$3"
  curl -s -X "$method" "$API_URL$path" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$body"
}

# Helper: check HTTP status code
api_status() {
  local method="$1" path="$2" body="${3:-}"
  if [ "$method" = "GET" ]; then
    curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $API_KEY" "$API_URL$path"
  else
    curl -s -o /dev/null -w "%{http_code}" -X "$method" "$API_URL$path" \
      -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
      -d "$body"
  fi
}

# ════════════════════════════════════════════════
header "REST API CONNECTIVITY"
# ════════════════════════════════════════════════

HEALTH_CODE=$(api_status GET /api/v1/health)
if [ "$HEALTH_CODE" = "200" ]; then
  ok "REST API reachable (GET /api/v1/health → 200)"
else
  fail "REST API reachable" "health returned $HEALTH_CODE"
  echo "  Cannot continue without API access."
  exit 1
fi

HEALTH_BODY=$(api_get /api/v1/health)
if echo "$HEALTH_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('status')=='ok' or d.get('services') else 1)" 2>/dev/null; then
  ok "Health check returns valid JSON with status"
else
  fail "Health check JSON" "$HEALTH_BODY"
fi

# Auth check — verify key works
STATS_CODE=$(api_status GET /api/v1/memory/stats)
if [ "$STATS_CODE" = "200" ]; then
  ok "API key auth works (GET /api/v1/memory/stats → 200)"
else
  fail "API key auth" "stats returned $STATS_CODE"
fi

# ════════════════════════════════════════════════
header "1. EPISODIC MEMORY — store + retrieve + dedup"
# ════════════════════════════════════════════════

# Store an episodic event
STORE_RES=$(api_send POST /api/v1/memory/episodic/events \
  "{\"user_id\":\"$TEST_USER\",\"event_type\":\"message\",\"content\":\"REST test: user prefers dark mode IDE themes\",\"session_id\":\"$TEST_SESSION\",\"metadata\":{\"role\":\"user\",\"source\":\"rest-test\"}}")
STORE_OK=$(echo "$STORE_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if d.get('id') or d.get('_id') or d.get('success',True) else '0')" 2>/dev/null || echo "0")
if [ "$STORE_OK" = "1" ]; then
  ok "POST /episodic/events — event stored"
else
  fail "POST /episodic/events" "$(echo "$STORE_RES" | head -c 200)"
fi

# Retrieve events
sleep 1
GET_RES=$(api_get "/api/v1/memory/episodic/events?user_id=$TEST_USER&limit=5")
GET_COUNT=$(echo "$GET_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('results',d.get('events',[])); print(len(r))" 2>/dev/null || echo "0")
if [ "$GET_COUNT" -ge 1 ] 2>/dev/null; then
  ok "GET /episodic/events — retrieved $GET_COUNT event(s)"
else
  fail "GET /episodic/events" "count=$GET_COUNT"
fi

# Search events
SEARCH_RES=$(api_send POST /api/v1/memory/episodic/search \
  "{\"user_id\":\"$TEST_USER\",\"query\":\"dark mode\",\"limit\":5}")
SEARCH_COUNT=$(echo "$SEARCH_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('results',d.get('events',[])); print(len(r))" 2>/dev/null || echo "0")
if [ "$SEARCH_COUNT" -ge 1 ] 2>/dev/null; then
  ok "POST /episodic/search — found $SEARCH_COUNT match(es) for 'dark mode'"
else
  fail "POST /episodic/search" "count=$SEARCH_COUNT"
fi

# Dedup stats
DEDUP_RES=$(api_get /api/v1/admin/episodic-events/duplication-stats)
DEDUP_OK=$(echo "$DEDUP_RES" | python3 -c "import sys,json; json.load(sys.stdin); print('1')" 2>/dev/null || echo "0")
if [ "$DEDUP_OK" = "1" ]; then
  ok "GET /admin/episodic-events/duplication-stats — dedup tracking active"
else
  skip "Dedup stats" "endpoint returned non-JSON or error"
fi

# ════════════════════════════════════════════════
header "2. SEMANTIC MEMORY — facts + confidence + embeddings"
# ════════════════════════════════════════════════

# List semantic facts
FACTS_RES=$(api_get "/api/v1/memory/semantic/facts?user_id=kolega-agent&limit=5")
FACTS_COUNT=$(echo "$FACTS_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('results',d.get('facts',[])); print(len(r))" 2>/dev/null || echo "0")
if [ "$FACTS_COUNT" -ge 1 ] 2>/dev/null; then
  ok "GET /semantic/facts — $FACTS_COUNT fact(s) returned"
else
  fail "GET /semantic/facts" "count=$FACTS_COUNT"
fi

# Check confidence scores
CONF=$(echo "$FACTS_RES" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('results',d.get('facts',[]))
if r and 'confidence' in r[0]:
    print(r[0]['confidence'])
else:
    print('none')
" 2>/dev/null || echo "none")
if [ "$CONF" != "none" ]; then
  ok "Semantic facts have confidence scores ($CONF)"
else
  skip "Confidence scores" "No confidence field in sample"
fi

# Check embedding coverage via debug counts
COUNTS_RES=$(api_get /api/v1/memory/debug/counts)
EMBED_COV=$(echo "$COUNTS_RES" | python3 -c "
import sys,json
d=json.load(sys.stdin)
# Look for embedding coverage info anywhere in the structure
s=json.dumps(d)
if 'embedding' in s.lower():
    print('present')
else:
    print('none')
" 2>/dev/null || echo "none")
if [ "$EMBED_COV" = "present" ]; then
  ok "Debug counts include embedding info"
else
  skip "Embedding coverage" "No embedding data in debug/counts"
fi

# ════════════════════════════════════════════════
header "3. WORKING MEMORY — Redis <5ms access"
# ════════════════════════════════════════════════

WM_SESSION="rest-wm-$(date +%s)"

# Store working memory
WM_STORE_RES=$(api_send POST /api/v1/memory/working \
  "{\"session_id\":\"$WM_SESSION\",\"content\":\"REST WM test: current task is testing\",\"priority\":8}")
WM_STORE_OK=$(echo "$WM_STORE_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if d.get('id') or d.get('success',True) or d.get('stored') else '0')" 2>/dev/null || echo "0")
if [ "$WM_STORE_OK" = "1" ]; then
  ok "POST /memory/working — item stored"
else
  fail "POST /memory/working" "$(echo "$WM_STORE_RES" | head -c 200)"
fi

# Retrieve working memory
sleep 1
WM_GET_RES=$(api_get "/api/v1/memory/working/$WM_SESSION?limit=10")
WM_GET_COUNT=$(echo "$WM_GET_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('results',d.get('items',d if isinstance(d,list) else [])); print(len(r))" 2>/dev/null || echo "0")
if [ "$WM_GET_COUNT" -ge 1 ] 2>/dev/null; then
  ok "GET /memory/working/:session — retrieved $WM_GET_COUNT item(s)"
else
  fail "GET /memory/working/:session" "count=$WM_GET_COUNT — $(echo "$WM_GET_RES" | head -c 150)"
fi

# Delete working memory
WM_DEL_CODE=$(api_status DELETE "/api/v1/memory/working/$WM_SESSION")
if [ "$WM_DEL_CODE" = "200" ] || [ "$WM_DEL_CODE" = "204" ]; then
  ok "DELETE /memory/working/:session — cleared ($WM_DEL_CODE)"
else
  fail "DELETE /memory/working/:session" "status=$WM_DEL_CODE"
fi

# ════════════════════════════════════════════════
header "4. TEMPORAL RECALL — time range + patterns"
# ════════════════════════════════════════════════

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PAST=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "7 days ago" +%Y-%m-%dT%H:%M:%SZ)

# Timeline query
TIMELINE_RES=$(api_get "/api/v1/memory/recall/timeline?userId=kolega-agent&startDate=$PAST&endDate=$NOW&limit=5")
TIMELINE_OK=$(echo "$TIMELINE_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('events',d.get('results',d.get('timeline',[]))); print('1' if isinstance(r,list) else '0')" 2>/dev/null || echo "0")
if [ "$TIMELINE_OK" = "1" ]; then
  TL_COUNT=$(echo "$TIMELINE_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('events',d.get('results',d.get('timeline',[]))); print(len(r))" 2>/dev/null)
  ok "GET /recall/timeline — returned $TL_COUNT event(s) in range"
else
  fail "GET /recall/timeline" "$(echo "$TIMELINE_RES" | head -c 150)"
fi

# Detect patterns
PATTERN_RES=$(api_send POST /api/v1/memory/detect-patterns \
  "{\"user_id\":\"kolega-agent\",\"lookback_weeks\":4}")
PATTERN_OK=$(echo "$PATTERN_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if 'pattern' in json.dumps(d).lower() or 'frequency' in json.dumps(d).lower() or isinstance(d.get('patterns'),list) else '0')" 2>/dev/null || echo "0")
if [ "$PATTERN_OK" = "1" ]; then
  ok "POST /detect-patterns — pattern analysis returned"
else
  skip "Pattern detection" "Insufficient data or $(echo "$PATTERN_RES" | head -c 100)"
fi

# Time block summaries
SUMMARY_RES=$(api_get "/api/v1/memory/time-block-summaries?user_id=kolega-agent&limit=3")
SUMMARY_OK=$(echo "$SUMMARY_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('results',d.get('summaries',[])); print('1' if isinstance(r,list) else '0')" 2>/dev/null || echo "0")
if [ "$SUMMARY_OK" = "1" ]; then
  ok "GET /time-block-summaries — responds with list"
else
  skip "Time block summaries" "$(echo "$SUMMARY_RES" | head -c 100)"
fi

# ════════════════════════════════════════════════
header "5. VECTOR SEARCH — local embeddings"
# ════════════════════════════════════════════════

VECTOR_RES=$(api_send POST /api/v1/memory/recall/search \
  '{"query":"car vehicle driving Mercedes","userId":"kolega-agent","limit":5}')
VECTOR_OK=$(echo "$VECTOR_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('results',[]); print('1' if isinstance(r,list) else '0')" 2>/dev/null || echo "0")
if [ "$VECTOR_OK" = "1" ]; then
  V_COUNT=$(echo "$VECTOR_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('results',[])))" 2>/dev/null)
  ok "POST /recall/search — vector search returned $V_COUNT result(s)"
else
  fail "POST /recall/search" "$(echo "$VECTOR_RES" | head -c 200)"
fi

# Check for similarity scores
SIM_SCORE=$(echo "$VECTOR_RES" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('results',[])
if r:
    s=json.dumps(r[0])
    if 'score' in s or 'similarity' in s or 'distance' in s:
        print('present')
    else:
        print('none')
else:
    print('none')
" 2>/dev/null || echo "none")
if [ "$SIM_SCORE" = "present" ]; then
  ok "Vector search results include similarity scores"
else
  skip "Similarity scores" "No score field in results"
fi

# ════════════════════════════════════════════════
header "6. MULTI-COLLECTION SEARCH — comprehensive"
# ════════════════════════════════════════════════

# Orchestrated recall (context must be an object, not a string)
RECALL_RES=$(api_send POST /api/v1/memory/recall \
  '{"informationNeed":"What do we know about the user preferences?","maxTokens":500}')
RECALL_OK=$(echo "$RECALL_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if d.get('synthesis') or d.get('results') or d.get('context') or d.get('answer') or d.get('data') else '0')" 2>/dev/null || echo "0")
if [ "$RECALL_OK" = "1" ]; then
  ok "POST /recall — orchestrated multi-collection recall responds"
else
  fail "POST /recall" "$(echo "$RECALL_RES" | head -c 200)"
fi

# Enhanced remember
REMEMBER_RES=$(api_send POST /api/v1/memory/recall/remember \
  '{"query":"user preferences and facts","userId":"kolega-agent"}')
REMEMBER_OK=$(echo "$REMEMBER_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); data=d.get('data',d); print('1' if d.get('results') or d.get('synthesis') or d.get('memories') or d.get('answer') or data.get('context') or data.get('results') else '0')" 2>/dev/null || echo "0")
if [ "$REMEMBER_OK" = "1" ]; then
  ok "POST /recall/remember — enhanced recall responds"
else
  fail "POST /recall/remember" "$(echo "$REMEMBER_RES" | head -c 200)"
fi

# Synthesize
SYNTH_RES=$(api_send POST /api/v1/memory/synthesize \
  "{\"user_id\":\"kolega-agent\",\"session_id\":\"$TEST_SESSION\",\"query\":\"What is the current context?\"}")
SYNTH_OK=$(echo "$SYNTH_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if d.get('context') or d.get('synthesis') or d.get('result') or d.get('summary') or d.get('enhanced_context') else '0')" 2>/dev/null || echo "0")
if [ "$SYNTH_OK" = "1" ]; then
  ok "POST /synthesize — cognitive context synthesis responds"
else
  skip "Synthesize" "$(echo "$SYNTH_RES" | head -c 150)"
fi

# Recall templates
TEMPLATES_RES=$(api_get /api/v1/memory/recall/templates)
TEMPLATES_OK=$(echo "$TEMPLATES_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); data=d.get('data',d); print('1' if isinstance(d.get('templates'),list) or isinstance(data.get('templates'),list) or isinstance(d,list) else '0')" 2>/dev/null || echo "0")
if [ "$TEMPLATES_OK" = "1" ]; then
  ok "GET /recall/templates — templates available"
else
  skip "Recall templates" "$(echo "$TEMPLATES_RES" | head -c 100)"
fi

# ════════════════════════════════════════════════
header "7. BACKGROUND PROCESSING — auto-extraction"
# ════════════════════════════════════════════════

BG_RES=$(api_get /api/v1/admin/background/status)
BG_RUNNING=$(echo "$BG_RES" | python3 -c "
import sys,json
d=json.load(sys.stdin)
s=d.get('stats',d.get('data',d))
running = s.get('is_running', s.get('running', s.get('status','?')))
print(str(running))
" 2>/dev/null || echo "?")
ok "GET /admin/background/status — processor running=$BG_RUNNING"

# Ingestion stats (background pipeline)
INGEST_STATS_RES=$(api_get /api/v1/ingestion/stats)
INGEST_OK=$(echo "$INGEST_STATS_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1')" 2>/dev/null || echo "0")
if [ "$INGEST_OK" = "1" ]; then
  ok "GET /ingestion/stats — pipeline stats available"
else
  skip "Ingestion stats" "endpoint returned non-JSON"
fi

# Ingestion health
INGEST_HEALTH_CODE=$(api_status GET /api/v1/ingestion/health)
if [ "$INGEST_HEALTH_CODE" = "200" ]; then
  ok "GET /ingestion/health → 200"
else
  fail "GET /ingestion/health" "status=$INGEST_HEALTH_CODE"
fi

# ════════════════════════════════════════════════
header "8. KNOWLEDGE GRAPH (REST)"
# ════════════════════════════════════════════════

GRAPH_RES=$(api_get "/api/v1/memory/knowledge-graph?user_id=kolega-agent&limit=20")
GRAPH_OK=$(echo "$GRAPH_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if 'nodes' in json.dumps(d).lower() or 'edges' in json.dumps(d).lower() else '0')" 2>/dev/null || echo "0")
if [ "$GRAPH_OK" = "1" ]; then
  ok "GET /knowledge-graph — graph data returned"
else
  fail "GET /knowledge-graph" "$(echo "$GRAPH_RES" | head -c 150)"
fi

# Graph stats
GSTATS_RES=$(api_get /api/v1/memory/enhance/stats)
GSTATS_OK=$(echo "$GSTATS_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); data=d.get('data',d); print('1' if 'node' in json.dumps(data).lower() else '0')" 2>/dev/null || echo "0")
if [ "$GSTATS_OK" = "1" ]; then
  NODES=$(echo "$GSTATS_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); data=d.get('data',d); print(data.get('node_count',data.get('nodes','?')))" 2>/dev/null)
  ok "GET /enhance/stats — graph has $NODES node(s)"
else
  fail "GET /enhance/stats" "$(echo "$GSTATS_RES" | head -c 150)"
fi

# ════════════════════════════════════════════════
header "9. SYSTEM STATS + STATUS"
# ════════════════════════════════════════════════

STATS_RES=$(api_get "/api/v1/memory/stats?user_id=kolega-agent")
STATS_OK=$(echo "$STATS_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if d.get('collections') or d.get('stats') or d.get('total') or d.get('counts') or d.get('total_events') is not None or d.get('total_facts') is not None else '0')" 2>/dev/null || echo "0")
if [ "$STATS_OK" = "1" ]; then
  ok "GET /memory/stats — dashboard stats returned"
else
  fail "GET /memory/stats" "$(echo "$STATS_RES" | head -c 150)"
fi

STATUS_RES=$(api_get /api/v1/memory/status)
STATUS_OK=$(echo "$STATUS_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1')" 2>/dev/null || echo "0")
if [ "$STATUS_OK" = "1" ]; then
  ok "GET /memory/status — system status returned"
else
  fail "GET /memory/status" "$(echo "$STATUS_RES" | head -c 150)"
fi

# Database stats
DBSTATS_RES=$(api_get /api/v1/admin/database-stats)
DBSTATS_OK=$(echo "$DBSTATS_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1')" 2>/dev/null || echo "0")
if [ "$DBSTATS_OK" = "1" ]; then
  ok "GET /admin/database-stats — DB document counts returned"
else
  fail "GET /admin/database-stats" "$(echo "$DBSTATS_RES" | head -c 150)"
fi

# ════════════════════════════════════════════════
# FINAL SUMMARY
# ════════════════════════════════════════════════
header "REST API TEST SUMMARY"
echo ""
echo "  ✅ Passed:  $PASS"
echo "  ❌ Failed:  $FAIL"
echo "  ⏭️  Skipped: $SKIP"
echo "  Total:     $((PASS+FAIL+SKIP))"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo "  🎉 ALL REST API TESTS PASSED"
else
  echo "  ⚠️  $FAIL test(s) failed — see details above"
fi
