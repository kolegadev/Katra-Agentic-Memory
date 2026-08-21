# Katra Python SDK

[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue)](https://www.python.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Katra** is a standalone cognitive memory server for agentic LLMs.  This
SDK provides a clean, type-annotated Python interface to the core MCP memory
tools over the streamable-http MCP endpoint. The current Katra server
registers 66 MCP tools; the SDK wraps the core memory subset listed below,
and every registered tool is reachable through `list_tools()` /
`call_tool()` on the low-level client.

## Identity & auth

- Katra resolves the calling identity from the API key presented on each
  request (`X-MCP-Auth` header, `Authorization: Bearer`, or `?token=` URL
  param) — never from a client-declared `user_id`. The SDK sends
  `Authorization: Bearer <api_key>`.
- `api_key` must be a valid client key provisioned by the server (the admin
  `KATRA_API_KEY` authenticates as the trusted `satori` identity; per-agent
  keys exist for `shoshin` and `zanshin`). A valid-but-unmapped key is
  rejected with 401 — no silent fallback. The legacy `MCP_API_KEY` /
  `BACKUP_MCP_KEYS` env keys no longer authenticate.
- `user_id` arguments are scoping hints within what your identity may see:
  Katra runs in hybrid mode (`shared_id` `my-team`), reads return your own
  private memories plus the shared team scope, and personal kinds (journal,
  reflection, emotional, insight) are always private. Pass a named identity
  (`"satori"`, `"shoshin"`, `"zanshin"`) to query that identity's slice of
  the shared scope.

## Installation

```bash
pip install satori-sdk
```

For development:

```bash
pip install -e ".[dev]"
```

## Quick Start

```python
from satori import KatraClient

# Connect to your Katra server (host-mapped MCP port). The api_key is this
# identity's client key — Katra resolves the identity from the key, not from
# the user_id arguments below.
client = KatraClient("http://localhost:3112", api_key="<client-key-for-this-identity>")

# ── Store & recall ─────────────────────────────────
client.store_memory("User is a Python developer", category="fact")
results = client.search_memories("Python", limit=5)

# ── Vector search ──────────────────────────────────
similar = client.vector_search("machine learning pipelines")

# ── Temporal memory ────────────────────────────────
history = client.temporal_recall("satori", from_date="2026-05-01")
ctx = client.get_temporal_context("satori", "sess-456")

# ── Patterns & summaries ───────────────────────────
patterns = client.detect_patterns("satori", lookback_weeks=4)
blocks = client.get_time_block_summaries("satori", block_type="week")

# ── Journal ────────────────────────────────────────
client.store_journal("satori", "Finished the API refactor",
                     tags=["coding", "milestone"])
entries = client.get_journal("satori", source="auto")

# ── Missions ───────────────────────────────────────
mission = client.create_mission("satori", "Build a trading bot",
                                tasks=["Research APIs", "Implement core"])
client.update_mission_task("satori", mission["id"], "task-1", "completed")

# ── Health ─────────────────────────────────────────
health = client.get_health()
diag = client.get_memory_diagnostics()

# ── Working memory ─────────────────────────────────
client.working_memory("sess-456", "store", content="user is debugging")
wm = client.working_memory("sess-456", "get")

# ── Knowledge graph ────────────────────────────────
graph = client.explore_graph(query="Docker", include_edges=True)

# ── Assets & audit log ─────────────────────────────
assets = client.list_assets(content_type="image/")
log = client.get_transaction_log(since="2026-01-01")
```

## API Reference

`KatraClient(url, api_key=None, timeout=30.0, auto_init=True, verify=True)`

### Core Memory

| Method | Description |
|---|---|
| `store_memory(content, user_id?, category?, confidence?)` | Store a fact/preference/insight/event |
| `search_memories(query, user_id?, limit?)` | Keyword search across episodic + semantic |
| `vector_search(query, user_id?, limit?)` | Semantic vector similarity search |
| `get_conversation_history(session_id, limit?)` | Raw conversation log |

### Temporal Memory

| Method | Description |
|---|---|
| `temporal_recall(user_id, from?, to?, limit?, event_type?, role?)` | Events in a time range |
| `temporal_search(user_id, query, limit?)` | Keyword search with timestamps |
| `get_time_block_summaries(user_id, from?, to?, block_type?, limit?)` | Pre-computed AI summaries |
| `summarize_time_blocks(user_id, block_type?, lookback_days?, max_blocks?, dry_run?)` | Trigger LLM summarization |
| `detect_patterns(user_id, lookback_weeks?, min_confidence?, dormant_threshold_days?)` | Recurring topics, rhythm, regressions |
| `get_temporal_context(user_id, session_id)` | Current session context |

### Journal

| Method | Description |
|---|---|
| `get_journal(user_id, source?, limit?)` | Read journal entries |
| `store_journal(user_id, entry, source?, tags?)` | Write a journal entry |
| `get_auto_journal(user_id, since?, limit?)` | AI-distilled auto-entries |

### Missions

| Method | Description |
|---|---|
| `list_missions(user_id, limit?)` | List all goals |
| `get_mission(user_id, mission_id)` | Full mission details |
| `create_mission(user_id, goal, title?, tasks?)` | Create a new goal |
| `update_mission_task(user_id, mission_id, task_id, status)` | Update task status |

### Working Memory

| Method | Description |
|---|---|
| `working_memory(session_id, action, content?, limit?)` | get / store / delete |

### Knowledge Graph

| Method | Description |
|---|---|
| `explore_graph(query?, limit?, include_edges?)` | Entities + relationships |

### Diagnostics

| Method | Description |
|---|---|
| `get_memory_diagnostics(user_id?)` | Collection counts, embeddings, backlog |
| `get_background_status()` | Queue depth, processing interval |
| `get_health()` | MongoDB, Redis, LLM, embeddings |
| `get_heartbeat_status()` | Scheduler status + run history |

### Assets & Audit

| Method | Description |
|---|---|
| `list_assets(user_id?, content_type?, limit?)` | Uploaded files index |
| `get_transaction_log(user_id?, action?, since?, limit?)` | Agent action audit trail |

## Low-Level MCP Client

For direct JSON-RPC control:

```python
from katra import KatraMCPClient

mcp = KatraMCPClient("http://localhost:3112", api_key="key")
mcp.initialize()                         # handshake → session ID
tools = mcp.list_tools()                 # discover available tools
result = mcp.call_tool("search_memories", {"query": "AI"})
text = mcp.call_tool_text("get_health", {})
```

## Requirements

- Python ≥ 3.10
- `requests` ≥ 2.28

## License

MIT — see the [LICENSE](../LICENSE) file.
