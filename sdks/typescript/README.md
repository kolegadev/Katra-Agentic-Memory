# @satori/sdk

TypeScript SDK for [Satori](../../README.md) — the Katra memory system's
founding identity name — Cognitive Memory as a Service.

Typed async API for the core Satori memory tools, built on the MCP (Model
Context Protocol) Streamable HTTP transport with automatic session
handling. The current Katra server registers 66 MCP tools; this SDK wraps
the core memory subset listed below, and any registered tool is reachable
through the low-level `MCPClient`.

## Identity & auth

- Katra resolves the calling identity from the API key presented on each
  request (`X-MCP-Auth` header, `Authorization: Bearer`, or `?token=` URL
  param) — never from a client-declared `user_id`. The SDK sends
  `Authorization: Bearer <apiKey>`.
- The key must be a valid client key provisioned by the server (the admin
  `KATRA_API_KEY` authenticates as the trusted `satori` identity; per-agent
  keys exist for `shoshin` and `zanshin`). A valid-but-unmapped key is
  rejected with 401 — no silent fallback. The legacy `MCP_API_KEY` /
  `BACKUP_MCP_KEYS` env keys no longer authenticate.
- `user_id` fields are scoping hints within what your identity may see:
  Katra runs in hybrid mode (`shared_id` `my-team`), reads return your own
  private memories plus the shared team scope, and personal kinds (journal,
  reflection, emotional, insight) are always private. Use a named identity
  (`'satori'`, `'shoshin'`, `'zanshin'`) to address that identity's slice
  of the shared scope.

## Quick Start

```bash
npm install @satori/sdk
```

```ts
import { SatoriClient } from '@satori/sdk';

const katra = new SatoriClient({
  url: 'http://localhost:3112', // the SDK appends /mcp
  apiKey: process.env.KATRA_API_KEY, // a valid client key; identity is resolved from it
});

// Store a memory
const result = await katra.storeMemory({
  content: 'The team decided to use Bun for the new API',
  category: 'fact',
  confidence: 0.9,
});
console.log(`Stored: ${result.insertedId}`);

// Search memories
const hits = await katra.searchMemories({
  query: 'Bun API',
  user_id: 'satori',
});
console.log(`${hits.episodic.length} events, ${hits.semantic.length} facts`);

// Semantic vector search
const similar = await katra.vectorSearch({
  query: 'deployment pipeline',
  limit: 5,
});

// Create a mission with tasks
const mission = await katra.createMission({
  user_id: 'satori',
  goal: 'Migrate to Bun',
  title: 'Bun Migration',
  tasks: ['Benchmark', 'Write tests', 'Deploy'],
});

// Check health
const health = await katra.getHealth();
console.log(health); // { mongodb: true, redis: true, llm: {...}, ... }

// Close when done
await katra.close();
```

## API Overview

### Core Memory
- `storeMemory()` — Store a fact, preference, insight, or event
- `searchMemories()` — Keyword search across episodic and semantic memory
- `vectorSearch()` — Semantic vector similarity search
- `getConversationHistory()` — Raw conversation history for a session

### Temporal Memory
- `temporalRecall()` — Query events in a date range
- `temporalSearch()` — Keyword search within events
- `getTimeBlockSummaries()` — AI summaries by day/week/month
- `summarizeTimeBlocks()` — Trigger summarization
- `detectPatterns()` — Recurring topics, rhythm, regressions, dormant topics
- `getTemporalContext()` — Full context snapshot for a session

### Journal
- `getJournal()` — Read auto/manual journal entries
- `storeJournal()` — Write a reflection or observation

### Missions (Goals)
- `listMissions()` — List all missions with status
- `getMission()` — Full mission details with task tree
- `createMission()` — Create with optional task list
- `updateMissionTask()` — Update task status

### Diagnostics
- `getMemoryDiagnostics()` — Document counts, embedding coverage, index status
- `getBackgroundStatus()` — Processing queue, last run, model status
- `getHealth()` — MongoDB, Redis, LLM, embedding health

### Knowledge Graph
- `exploreGraph()` — Browse entity-relationship graph

### Working Memory
- `workingMemory()` — Read, store, or delete short-term session memory

### Auto Journal
- `getAutoJournal()` — AI-distilled conversation insights

### Transaction Log
- `getTransactionLog()` — Audit trail of agent actions

### Heartbeat & Assets
- `getHeartbeatStatus()` — Scheduler status and recent runs
- `listAssets()` — Uploaded files (images, documents)

## Error Handling

```ts
import { SatoriClient, SatoriAuthError, SatoriConnectionError } from '@satori/sdk';

const katra = new SatoriClient({ url: 'http://localhost:3112', apiKey: 'sk-...' });

try {
  await katra.storeMemory({ content: 'Hello' });
} catch (err) {
  if (err instanceof SatoriAuthError) {
    console.error('Auth failed — check your API key');
  } else if (err instanceof SatoriConnectionError) {
    console.error('Server unreachable');
  } else {
    throw err;
  }
}
```

## Advanced: Low-Level MCP Client

For advanced scenarios, use `MCPClient` directly:

```ts
import { MCPClient } from '@satori/sdk';

const mcp = new MCPClient({ url: 'http://localhost:3112', apiKey: 'sk-...' });
await mcp.initialize();

const result = await mcp.callTool('search_memories', { query: 'React' });
console.log(result);

await mcp.close();
```

## Requirements

- Node.js ≥ 20.0.0 (uses native `fetch` and `AbortSignal.timeout`)
- TypeScript ≥ 5.9 (dev dependency, for development / type checking)

## License

MIT — see the [LICENSE](../../LICENSE) file.

## Related

- [Katra repository](../../README.md)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
