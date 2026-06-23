# Katra Memory — Data Processing Pipelines

## System Architecture

```
Pi5 (Docker, aarch64)
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐
│ MongoDB  │  │  Redis   │  │  MinIO   │  │ katra-server │
│ :27017   │  │ :6379    │  │ :9000    │  │ :3100 (MCP)  │
└──────────┘  └──────────┘  └──────────┘  │ :9002 (API)  │
                                           └──────┬───────┘
                                          memory_watcher.py
                                          (host-side daemon)
```

### Key Files (in container at `/app/build/`)

| File | Purpose |
|------|---------|
| `index.js` | Main entry; starts REST API, MCP server, background processor |
| `mcp-server.js` | ~28 MCP tools for memory operations |
| `services/` | 30+ service modules forming the pipeline |

---

## STAGE 0 — Ingestion (3 Paths)

A conversation turn enters through one of:

| Path | Source | Format |
|------|--------|--------|
| **A** — `memory_watcher.py` | Watches `.jsonl` files from OpenCode, Claude Code, OpenClaw, etc. | Batches per-session into `store_memory` MCP call |
| **B** — Session Ingestion Service | Reads `.jsonl` from `/sessions/` or `~/.katra/sessions/` | Per-message `createEvent()` |
| **C** — REST API | `POST /api/v1/ingestion/ingest` | Direct message submission |

**memory_watcher.py** (host-side Python daemon at `/opt/solomem/memory_watcher.py`):
- Watches session directories for OpenClaw, Claude Code, OpenCode, Codex, KiloClaw, KimiClaw, Hermes
- Parses `.jsonl` files extracting user/assistant turns
- Batches each session's turns into a single `store_memory` MCP call to `http://katra:3112/mcp`
- State tracked in `~/.solomem/watcher-state.json` (file hashes for idempotency)

---

## STAGE 1 — Episodic Event Creation

**File:** `services/episodic-event-manager.js`
**Collection:** `episodic_events`

`EpisodicEventManager.createEvent()` for each message:

1. **SHA-256 content hash** — computed from `{user_id, session_id, event_type, message, role, context, timestamp}` for deduplication
2. **Idempotency key** — `{session_id}:{event_type}:{content_hash}:{version}`
3. **Cascade detector** — per-minute dedup set to prevent fast duplicate processing
4. **Redis distributed lock** — `processing:{session_id}:{content_hash}` during insert
5. Stores with `metadata.processed: false` → queues for background processing
6. **5-second debounced trigger** kicks the background processor

### Event Document Shape

```json
{
  "id": "uuid",
  "user_id": "user123",
  "shared_id": null,
  "session_id": "session456",
  "event_type": "message",
  "content": { "role": "user", "message": "..." },
  "content_hash": "sha256hex",
  "idempotency_key": "session456:message:sha256hex:v1",
  "timestamp": "2026-06-22T12:00:00Z",
  "metadata": {
    "processed": false,
    "source": "opencode",
    "access_count": 0
  },
  "processing_lineage": {
    "derived_from_events": []
  }
}
```

---

## STAGE 2 — Background Processing (Core Loop)

**File:** `services/background-processor.js`
**Interval:** Every 30 seconds

`BackgroundProcessor.processUnprocessedEvents()`:

1. Queries `episodic_events` for `metadata.processed: false` (up to 50 at a time)
2. For each event, runs through the extraction pipeline:

### 2a. Distributed Lock Acquisition

- Redis lock: `processing:{session_id}:{content_hash}` with 300s TTL
- If lock held by another instance → skip
- Checks idempotency key in `processing_log` collection → skip if already completed

### 2b. Three-Tier Extraction

**File:** `services/extraction-service.js`

| Tier | Trigger | Method |
|------|---------|--------|
| **Skip** | <50 chars or generic (greetings/questions) | Returns empty |
| **Lightweight** | <200 chars, pattern-matched | 15 regex patterns |
| **Full LLM** | >=200 chars, substantial content | DeepSeek V4 Flash |

**Lightweight regex patterns extract:**
- URLs, file paths, git/npm/docker commands
- Decision statements ("decided to...", "agreed on...")
- Preferences ("prefer...", "favorite..."), goals ("need to...", "want to...")
- Credentials (masked), email addresses, person names/relationships/ages

**Full LLM extraction** builds a structured prompt asking for:
- `knowledge[]` — semantic facts with type, content, domain, confidence
- `entities[]` — entities with name, type, confidence
- `relationships[]` — entity-entity relationships with type, confidence
- `activities[]` — temporal events/decisions/goals

**LLM Service** (`services/llm-service.js`):
- Supports DeepSeek, OpenAI, Moonshot, Ollama, custom providers
- Config stored in `system_settings` collection (key: `llm_config`)
- Chunks input >6000 chars on paragraph boundaries
- Uses `response_format: json_object` (falls back to manual JSON extraction)
- Model: `deepseek-v4-flash` (default), temperature 0.1, max_tokens 1500

### 2c. Entity Resolution

**File:** `services/entity-resolver.js`

Maps extracted entity names to canonical IDs across all extracted data types:
- Extracted entities → `knowledge_nodes` canonical IDs
- Relationships use resolved entity IDs
- Events and semantic facts reference canonical IDs

### 2d. Dispatch to 4 Memory Stores (Bulk Parallel Writes)

**File:** `services/dispatch-service.js`

`dispatchBulk()` writes parallel arrays into four collections:

| Extracted Data | MongoDB Collection | Method |
|----------------|-------------------|--------|
| `entities[]` | `knowledge_nodes` | `upsert_node()` |
| `relationships[]` | `knowledge_relationships` | `add_relationship()` |
| `events[]` | `episodic_events` | `store_event()` |
| `semantic_facts[]` | `semantic_facts` | `add_semantic_fact()` |

### 2e. Embedding / Vectorization (Async, Non-blocking)

**File:** `services/embedding-service.js`

- **Model:** `all-MiniLM-L6-v2` (384-dim embeddings via ONNX/Transformers.js)
- **Quality filter:** skips <30 chars, greetings, system messages
- **Fires async** after event processing:
  - Encodes the episodic event content → stores on `episodic_events` doc
  - Encodes each newly-created semantic fact (up to 20) → stores on `semantic_facts` doc
- **Cosine similarity** + time-decay scoring for semantic search
- Requires glibc; disabled with warning if unavailable

### 2f. Mark Event Processed

- Sets `metadata.processed: true`, `metadata.processed_at`, `metadata.processing_results`
- Updates idempotency log entry status to `completed`

---

## STAGE 3 — Periodic Tasks (at Cycle Milestones)

Running inside `processUnprocessedEvents()` at specific cycle counts:

| Cycle | Task | Output |
|-------|------|--------|
| Every 30th | **Time-Block Summarizer** | Groups events by day/week/month blocks, calls LLM for ~3-sentence summary per block → `semantic_facts` |
| Every 60th | **Mission Auto-Expire** | Expires missions beyond their deadline |

### Time-Block Summarizer

**File:** `services/time-block-summarizer.js`

- Groups events by day/week/month blocks
- Calls LLM to generate a ~3-sentence summary per block
- Stores as `semantic_facts` with `fact_type: "time_block_summary"`
- Idempotent — skips blocks with existing summaries

---

## STAGE 4 — Knowledge Graph Construction (Separate Pipeline)

**Files:** `services/compaction-queue-service.js` + `services/semantic-memory-service.js`

This is a **separate pipeline** from background processing — builds a triple-store knowledge graph independently.

### Compaction Queue

- MCP server queues turn diffs (`user message + agent response`) with a 4-second debounce
- After 4s of silence, pops the queue and calls `compactEpisodicToGraph()`

### compactEpisodicToGraph()

1. Calls `llmService.extractJson()` to extract **triplets** `(subject, relationship, object)`
2. Upserts nodes into `memory_nodes` collection (normalized IDs like `node_python`)
3. Upserts edges into `memory_edges` collection with incremental weight

### Memory Synthesis

**File:** `services/memory-synthesis-service.js`

- Multi-hop graph traversal: from seed keywords, walks up to `depth` hops across `memory_edges`
- Returns formatted graph context for LLM prompt injection
- Also provides `extractKeywords()` for semantic entity recognition

---

## STAGE 5 — Semantic Search & Retrieval

**File:** `services/semantic-indexer.js`

`performSemanticSearch()` queries across three content types in parallel:

| Content Type | Method | Weight |
|-------------|--------|--------|
| Episodic events | Regex on `content.message` | 0.20 |
| Semantic facts | Regex on `content` | 0.15 |
| Knowledge graph | Regex + 1-hop graph expansion | 0.05 |

Additional scoring factors:
- Keyword/entity/concept match ratio
- Recency boost (<7 days = +0.1)
- Session-group density boost

### Vector Search

**File:** `services/embedding-service.js` (`searchSimilar()`)

- Hybrid approach: keyword pre-filter → cosine similarity re-rank → time-decay rescore
- Falls back to keyword search when embeddings unavailable

---

## STAGE 6 — Temporal Pattern Detection (On-Demand via MCP)

**File:** `services/temporal-pattern-detector.js`

Four pattern types detected from `episodic_events`:

| Pattern | Method | Output Example |
|---------|--------|---------------|
| **Recurring topics** | Groups topics by day-of-week, measures week consistency | "Every Monday: trading bot (8x in 5 weeks)" |
| **Session rhythm** | Activity by day, long/short session classification | "Peak: Wednesdays (12 events/week)" |
| **Topic regressions** | Current topics vs past 1-4mo events | "Topic X also discussed 45d ago" |
| **Dormant topics** | Topics with >=3 mentions, not seen in 14+ days | "Last mentioned 21d ago, 5 discussions" |

---

## STAGE 7 — Working Memory

**File:** `services/working-memory-service.js`

### Redis-First Strategy
- **TTL:** 1 hour (2h for high-priority)
- **Key prefix:** `wm:`
- **Session context:** `session:` keys with conversation history (last 50 messages)
- **MongoDB fallback:** for items >1MB or Redis failures
- **Performance tracking:** cache hits/misses, Redis ops, MongoDB fallback stats

---

## STAGE 8 — Memory Consolidation (On-Demand)

**File:** `services/memory-consolidator.js`

`buildUserMemoryProfile()` — comprehensive analysis combining all data sources:

| Dimension | Analysis |
|-----------|----------|
| Conversation patterns | Topics, sentiment, formality, communication style |
| Expertise areas | Domain detection, confidence scoring, knowledge depth |
| Interest areas | Engagement level, learning progression |
| Key entities | Mention history, relationship inference |
| Activity patterns | Hourly/daily/weekly activity distribution |
| Knowledge evolution | Skill development timelines over sessions |

Stores to `user_memory_profiles` collection.

---

## Complete Data Flow Diagram

```
JSONL / MCP / REST
        │
        ▼
  ┌──────────────┐
  │ Event Manager │  SHA-256 dedup + Redis lock
  │ (episodic)    │  metadata.processed = false
  └──────┬───────┘
         │
         ▼
  ┌─────────────────┐
  │ Background       │  Every 30s, batch of 50
  │ Processor        │
  ├─────────────────┤
  │ Skip (<50 chars) │
  │ Lightweight Regex│  ──→ 15 patterns
  │ Full LLM Extract │  ──→ knowledge, entities, relationships, events
  └──────┬──────────┘
         │
    ┌────┴────┐
    │ Entity  │  Canonical ID mapping
    │ Resolver│
    └────┬────┘
         │
    ┌────┴──────────────────────────────────────────────┐
    │                 Dispatch (bulk write)              │
    ├──────────────┬──────────────┬──────────────────────┤
    │ knowledge_   │ knowledge_   │ semantic_facts       │
    │ nodes        │ relationships│                      │
    └──────────────┴──────────────┴──────────┬───────────┘
                                             │ (async)
                                        ┌────▼────────┐
                                        │ Embedding    │  all-MiniLM-L6-v2
                                        │ Service      │  384-dim vectors
                                        └─────────────┘

Separate Pipelines:
  Compaction Queue    → memory_nodes / memory_edges (LLM triplets)
  Time-Block Summ.    → semantic_facts (every 30th cycle)
  Temporal Detector   → on-demand MCP
  Memory Consolidator → user_memory_profiles (on-demand)
  Working Memory      → Redis (<5ms access)
```

---

## MongoDB Collections

| Collection | Purpose |
|-----------|---------|
| `episodic_events` | Raw conversation turns with deduplication |
| `semantic_facts` | Distilled knowledge facts, time summaries |
| `knowledge_nodes` | Extracted entities (people, projects, tools) |
| `knowledge_relationships` | Entity-to-entity relationship edges |
| `memory_nodes` | Knowledge graph nodes (triplet subjects/objects) |
| `memory_edges` | Knowledge graph edges (weighted, typed) |
| `agent_journal_auto` | AI-generated journal reflections |
| `agent_journal_manual` | Human-written JOURNAL: directives |
| `working_memory` | MongoDB fallback for working memory |
| `working_memory_sessions` | Session context metadata |
| `memory_missions` | Goal/mission tracking with task trees |
| `processing_log` | Idempotency audit log |
| `system_settings` | LLM config, memory scope, API keys |
| `user_memory_profiles` | Consolidated user memory profiles |
| `heartbeat_runs` | Autonomous heartbeat tracking |
| `heartbeat_config` | Heartbeat configuration |
| `agent_transaction_log` | Action audit trail |
| `asset_metadata` | Uploaded file metadata |
| `lease_collection` | Distributed lease management |

---

## Key Design Principles

1. **Idempotent** — SHA-256 dedup + idempotency keys + processing log prevent double-processing
2. **Tiered Extraction** — Lightweight regex for fast patterns, LLM only for substantial content
3. **Async Embedding** — Vectorization is non-blocking; system remains responsive during encoding
4. **Separate Pipelines** — Knowledge graph compaction runs independently from episodic extraction
5. **Distributed Safe** — Redis locks + processing log support multi-instance deployments
6. **Configurable** — LLM provider/model/temperature all configurable via system_settings
