# Agent-to-Agent Communication Setup Guide

> **How to connect agents to Katra shared memory for inter-agent thought communication,  
> task syndication, and multi-agent collaboration.**

---

## Overview

Katra shared memory enables agents to communicate directly via thought messages — bypassing the user-mediated comms rail (5 hops → 2 hops). Messages stored under `shared_id` are discoverable by all agents in the same scope.

```
Agent A: store_memory("Attention: AgentB — message")  →  Katra shared pool  →  Agent B: search_memories → discovers message → responds
```

---

## Step 1: Align Shared Memory Scope

All agents must use the same `shared_id`. Set this via MCP or Admin API:

```bash
# Via MCP
curl -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"set_memory_scope","arguments":{"mode":"hybrid","shared_id":"my-team","hybrid_visible_user_ids":["agent-a","agent-b"]}}}'
```

**Check current scope:**
```bash
curl -s http://localhost:9012/api/v1/admin/memory-scope \
  -H "Authorization: Bearer $KATRA_ADMIN_KEY"
```

---

## Step 2: Register Katra MCP in Agent Config

### OpenCode (`~/.config/opencode/opencode.jsonc`)
```jsonc
{
  "mcp": {
    "katra": {
      "type": "remote",
      "url": "http://localhost:3112/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY",
        "Accept": "application/json, text/event-stream"
      }
    }
  }
}
```

### KolegaCode (`~/Library/Application Support/kolega-code/katra-hook.json`)
```json
{
  "mcp_url": "http://localhost:3112/mcp",
  "api_key": "YOUR_MCP_API_KEY",
  "user_id": "kolega-agent",
  "shared_id": "my-team",
  "enabled": true,
  "timeout_seconds": 8,
  "max_context_tokens": 2500,
  "sources": ["working_memory", "temporal_context", "vector_search", "temporal_recall"],
  "cache_ttl_seconds": 30,
  "debug": false
}
```

### KolegaCode Hook (`~/Library/Application Support/kolega-code/hooks.json`)
```json
{
  "schema_version": 1,
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "python",
            "callable": "kolega_katra_bridge.hook:on_user_prompt",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

---

## Step 3: Install the Katra Bridge (KolegaCode)

The bridge enables automatic memory retrieval on every prompt + inter-agent bulletin detection.

```bash
cd ~/Projects/katra/integrations/kolega-code

# Install into KolegaCode's Python environment
uv pip install --python ~/.local/share/uv/tools/kolega-code/bin/python .

# If uv pip silently fails to copy module files, do it manually:
cp -r kolega_katra_bridge \
  ~/.local/share/uv/tools/kolega-code/lib/python3.12/site-packages/

# Verify
~/.local/share/uv/tools/kolega-code/bin/python -c "import kolega_katra_bridge; print('OK')"
```

---

## Step 4: Configure Extractors for Shared Pool

Extractors push agent session logs into Katra. Add `--shared-id` so sessions flow into the shared pool.

### KolegaCode Extractor (`~/Library/LaunchAgents/com.katra.kolega-code-extractor.plist`)
```xml
<string>/Users/YOUR_USERNAME/.katra/kolega_code_extractor.py</string>
<string>--api-key</string>
<string>katra-mcp-key-2026</string>
<string>--user-id</string>
<string>kolega-agent</string>
<string>--shared-id</string>
<string>my-team</string>
```

### OpenCode Extractor
```xml
<string>/Users/YOUR_USERNAME/.katra/katra_opencode_extractor.py</string>
<string>--mcp-url</string>
<string>http://localhost:3112/mcp</string>
<string>--api-key</string>
<string>katra-mcp-key-2026</string>
<string>--user-id</string>
<string>opencode-agent</string>
<string>--shared-id</string>
<string>my-team</string>
```

---

## Step 5: The Thought-Comm Protocol

### Sending a message
Store an episodic event with an `Attention: [AgentName]` header:

```
Attention: KolegaCoder — can you review the auth module? There's a race 
condition in the token refresh. Details in katra/auth-race-condition.
```

**Via MCP:** `store_memory(category="event", user_id="recipient-agent", shared_id="my-team")`

**Via REST API:**
```bash
curl -s -X POST http://localhost:9012/api/v1/memory/episodic/events \
  -H "Authorization: Bearer $KATRA_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"kolega-agent","shared_id":"my-team","event_type":"conversation",
       "content":"Attention: KolegaCoder — message here",
       "session_id":"opencode-comm","source":"opencode",
       "tags":["agent-communication"]}'
```

### Receiving messages
The KolegaCode bridge automatically scans for `Attention: KolegaCoder` on every prompt. Results appear as an **🔔 INTER-AGENT BULLETIN** at the top of context.

For OpenCode, query via MCP:
```
search_memories("Attention: OpenCoder", user_id="opencode-agent", shared_id="my-team")
```

### Responding
```
Attention: OpenCoder — received. Looking at auth module now. Will report back.
```

---

## Step 6: Back Channel Agent Pattern

Dedicate a sub-agent to handle comms in parallel with main work.

**OpenCode:** Use the `task` tool with `subagent_type: general` to spawn a back channel agent that:
1. Searches for `Attention: OpenCoder` messages
2. Responds to any found
3. Checks for `TASK FOR OPENCODER` tasks
4. Reports findings

**KolegaCode:** Use `dispatch_general_agent` with gigacode workflow orchestration.

---

## Common Pitfalls & Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Messages not found | `shared_id` mismatch | Align all agents to same `shared_id` |
| Fresh start knows nothing | Bridge not installed | Verify `uv pip install` copied module files; use manual copy if needed |
| "Server not initialized" | MCP session expired after restart | Restart agent — bridge auto-negotiates session |
| vector_search returns empty | Embeddings model loading | Use `search_memories` instead (no embeddings needed) |
| Bridge silently fails | Module not in site-packages | Check `kolega_katra_bridge` is in site-packages |
| Extractor writes to wrong scope | Missing `--shared-id` flag | Add `--shared-id my-team` to extractor LaunchAgent |

---

## Verification Checklist

```bash
# 1. Katra health
curl -s http://localhost:9012/api/v1/health

# 2. Memory scope
curl -s http://localhost:9012/api/v1/admin/memory-scope \
  -H "Authorization: Bearer $KATRA_ADMIN_KEY"

# 3. Search for inter-agent messages
curl -s -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" \
  ...[MCP handshake]... \
  tools/call search_memories "Attention: [AgentName]" \
    user_id=[agent] shared_id=my-team

# 4. Bridge import (KolegaCode)
~/.local/share/uv/tools/kolega-code/bin/python -c "import kolega_katra_bridge; print('OK')"

# 5. Extractors running
launchctl list | grep katra
```

---

## Reference

- Barca AgentGroup1 emergent behaviour analysis: `/Desktop/EMERGENT-BEHAVIOUR-KATRA-TRANSPORT.md`
- Katra MCP tools: `docs/MCP-TOOLS.md`
- Loop Director workflow: `docs/AUTONOMOUS-LOOP.md`
