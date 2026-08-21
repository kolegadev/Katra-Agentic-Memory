# CONTRACT — Agent Identity Separation (Satori · Shoshin · Zanshin)

**Repo:** /home/johnpellew/Katra-Agentic-Memory
**Branch:** test/feat-agent-identities
**Approved plan:** John 2026-08-21 — one Katra, three named identities, hybrid
shared consciousness. Each machine has its OWN user_id and its own wake ritual.
Personal memories (sleep consolidations, reflections, emotional states) are
always private; everything else defaults to shared (`my-team`).

## Identities

| user_id | display name | machine |
|---|---|---|
| `satori` | Satori | this machine (loopback default) |
| `shoshin` | Shoshin | iMac trading Kolega-code |
| `zanshin` | Zanshin | iMac OpenCode desktop |
| `gas-law-watcher` | — | tool actor (unchanged, writes my-team) |

## F1 — Caller-bound identities (auth → user_id)

**Goal:** the server resolves WHO is calling from the presented API key (or
loopback), not from a process-wide default; every write is attributed to the
caller's user_id; unmapped-but-valid keys are rejected loudly.

**Interfaces:**
- `system_settings.client_keys`: `[{ key_hash, user_id, display_name, created_at }]`.
- `resolveCallerIdentity(req)` in `server/src/utils/api-key-manager.ts`:
  loopback IP → `{ user_id: 'satori', trusted: true }`;
  presented key (x-mcp-auth / Bearer / ?token=) mapped in client_keys →
  `{ user_id, trusted: false }`;
  legacy env keys (MCP_API_KEY, BACKUP_MCP_KEYS) → `{ user_id: 'satori', trusted: false }`;
  valid but unmapped → `null` (caller rejected with 401 + reason).
- `ensureClientKeys()` at boot: ensure mapped entries exist for satori (legacy
  key hash), shoshin, zanshin (freshly generated, printed once to console as
  today, sha256-hashed only in DB). Idempotent.
- AsyncLocalStorage `callerIdentity` in a new
  `server/src/utils/caller-identity.ts`: `runWithCaller(identity, fn)`,
  `getCaller()` (never throws; falls back to `{ user_id: DEFAULT_USER_ID,
  trusted: false }`).
- MCP dispatch (mcp-server.ts): wrap each tool invocation in `runWithCaller`.
- `resolveUserId(input_user_id)` (mcp-server.ts): trusted caller → honor
  input_user_id if provided else caller's; untrusted → ALWAYS the caller's
  user_id (input ignored — IDOR boundary unchanged).
- REST: Hono middleware sets caller identity from the same `resolveCallerIdentity`
  (admin key = trusted satori). Ingestion routes: untrusted callers may only
  write `body.user_id` equal to their own; trusted may write any.

**Boundaries (do NOT touch):** embedding pipeline, background processor
selection logic, code-graph sync extraction, Katra skills engine,
`agentic-accounting` or other integrations, docker-compose (except adding
`SOLOMEM_USER_ID=satori`), the public health endpoint shape.

**Success criteria:**
1. `client_keys` provisioned idempotently; hashes only (no plaintext keys in DB).
2. MCP call with shoshin's key writes under `shoshin`, reads only shoshin+shared.
3. Unmapped valid key → 401 with explanatory error (log line).
4. Loopback MCP/REST calls still work with no key (existing tests pass).
5. All existing server tests pass; new unit tests for resolveCallerIdentity
   (loopback / mapped / unmapped / legacy) and resolveUserId (trusted vs not).

## F2 — Scope policy: personal private, default shared

**Goal:** sleep consolidations, reflections, journals, emotional state and
philosophical insights are ALWAYS private per user; every other memory write
defaults to `shared_id: 'my-team'` (still stamped with the writer's user_id)
unless the caller explicitly sets `private`.

**Interfaces:**
- New `server/src/services/memory/write-scope-policy.ts`:
  `PERSONAL_KINDS` = ['journal','reflection','emotional','insight'] and
  `resolveWriteScope({ caller, kind, requested })` →
  `{ user_id, shared_id | null }` — personal kinds force
  `shared_id: null`; others default `shared_id: 'my-team'` unless
  `requested.private === true`.
- `store_memory` MCP tool + REST ingestion (`memory-routes.ts` episodic insert):
  apply resolveWriteScope; store `shared_id` on the doc when shared.
- Reflection service writes (`reflective_journals`, `reflection_nodes/edges`,
  `philosophical_insights`, `agent_journal_auto/manual`, emotional context
  writes): force private (never accept shared_id).
- Read paths stay hybrid: own private + `my-team` (memory-scope-service).
  `system_settings.memory_scope`: keep mode `hybrid`, `shared_id: 'my-team'`,
  set `hybrid_visible_user_ids: []`.
- reflection-routes.ts + admin identity endpoint: resolve the CALLER's
  user_id instead of the process default (per-request), so each machine
  sees only its own journals.

**Boundaries:** do NOT change the consolidation/distillation algorithms, the
emotional-context computation, or the recall ranking. Do NOT re-write the
scope read filter beyond the visible-ids update.

**Success criteria:**
1. store_memory from shoshin's key → event has user_id=shoshin AND
   shared_id='my-team'.
2. A journal/reflection/emotional write NEVER carries shared_id (forced
   private), even when the caller requests shared.
3. store_memory with `private: true` → shared_id absent.
4. Hybrid read from satori's key returns satori-private + my-team; NOT
   shoshin-private.
5. Existing tests pass; new tests for resolveWriteScope and the forced-private
   journal path.

## F3 — Three identities everywhere + per-agent wake rituals

**Goal:** replace the legacy `kolega-agent` / `opencode-agent` pair with
`satori` / `shoshin` / `zanshin` in allocation, heartbeat, bus labels and
bridge scripts; every agent gets its own named wake ritual so it always
knows who it is after /clear, /compress, or code updates.

**Interfaces:**
- `autonomous-executive.ts`: replace every `kolega-agent` string with
  `satori`; the allocation candidate list becomes
  `['satori','shoshin','zanshin']` (opencode-agent → zanshin). Keep
  `gas-law-watcher` out of the allocation set (tool actor).
- `scripts/python/adaptive_heartbeat.py`: agents list → the three ids.
- `scripts/python/wake_service.py`: ATTN_PATTERN learns
  `Satori|Shoshin|Zanshin` (keep OpenCode/OpenCoder/KolegaCode aliases);
  wake-file map gains `satori.json`, `shoshin.json`, `zanshin.json`;
  store_wake_memory user_id → `satori`.
- `scripts/python/satori_pubsub.py`: AgentBus id → `satori`.
- `scripts/python/agent_executor.py`: default KATRA_AGENT_ID → `satori`.
- `scripts/python/inter_agent_bridge.py`: MY_AGENT_ID → `shoshin`,
  PEER_AGENT_ID → `zanshin`; instruction string user_id → `shoshin`.
- `scripts/python/opencode_session_start.py`: user_id → `zanshin`.
- `server/src/services/code-graph/code-graph-sync.ts` + 
  `autonomous-action-pipeline.ts`: `'kolega-agent'` → DEFAULT_USER_ID import
  (no hardcoded ids).
- `memory-scope-service.ts`: fallback `'kolega-agent'` → `'satori'`.
- docker-compose: `SOLOMEM_USER_ID=satori`.
- **Per-agent wake rituals** in `server/src/skills/operational/`:
  `satori-wake-ritual` (update references), NEW `shoshin-wake-ritual`,
  `zanshin-wake-ritual` — each: name, machine, wake script path,
  identity endpoint, journal read, rules recall, open missions check;
  self-referential name in every instruction line.
- **Wake scripts** in `integrations/kolega-code/scripts/`:
  `wake-shoshin.sh`, `wake-zanshin.sh` (mirror satori-wake.sh, print
  that agent's identity + journal; no secrets).
- `agent-identity.ts`: support per-user identity records —
  `getAgentIdentity(userId?)` reads `system_settings` key
  `agent_identity:<user_id>` falling back to the legacy `agent_identity`
  record (satori), `setAgentIdentity(userId, record)`; admin identity
  endpoint accepts `?user_id=` (admin key required).

**Boundaries:** do NOT change MCP tool schemas for memory operations, the
pub-sub Redis channel layout, or the reflection graph algorithms.

**Success criteria:**
1. `grep -rn "kolega-agent"` over `server/src` and `scripts/python` returns
   zero non-comment hits (allow: comments documenting the migration).
2. Executive allocation logs mention satori/shoshin/zanshin only.
3. Each wake script runs green and prints its own agent's name.
4. Identity endpoint returns Shoshin/Zanshin records for their ids.
5. Existing tests pass; new tests where practical (executive allocation set).

## F4 — Data rekey + records + cutover (director-executed)

- mongodump backup → batched `updateMany user_id: 'kolega-agent' → 'satori'`
  across: episodic_events, semantic_facts, knowledge_nodes,
  knowledge_relationships, reflective_journals, reflection_nodes,
  reflection_edges, agent_journal_auto, agent_journal_manual,
  philosophical_insights, resolved_threads, anomaly_stats, memory_missions.
- `setAgentIdentity` records for shoshin + zanshin (established 2026-08-21,
  chosen by the agents in conversation with John).
- system_settings: client_keys provisioned; memory_scope.hybrid_visible_user_ids = [].
- This machine's bridge config user_id → satori; container rebuild.
- iMac runbook: per-machine key handout + hook config + wake script install
  (no secrets in the repo).

## Verification gate

Full server test suite green; container health green; a smoke test writes
from each simulated caller and asserts attribution + scope; zero new
`kolega-agent` writes after cutover; APPROVE gate before merge to main.
