# @katra/sdk

TypeScript SDK for [Katra](https://github.com/katra-ai/katra) — Cognitive Memory as a Service.

Access all 29 Katra memory tools with a fully-typed async API. Built on the
MCP (Model Context Protocol) Streamable HTTP transport with automatic session
handling.

## Quick Start

```bash
npm install @katra/sdk
```

```ts
import { KatraClient } from '@katra/sdk';

const katra = new KatraClient({
  url: 'http://localhost:3112',
  apiKey: process.env.KATRA_API_KEY, // optional if server allows unauthenticated
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
  user_id: 'alice',
});
console.log(`${hits.episodic.length} events, ${hits.semantic.length} facts`);

// Semantic vector search
const similar = await katra.vectorSearch({
  query: 'deployment pipeline',
  limit: 5,
});

// Create a mission with tasks
const mission = await katra.createMission({
  user_id: 'alice',
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
import { KatraClient, KatraAuthError, KatraConnectionError } from '@katra/sdk';

const katra = new KatraClient({ url: 'http://localhost:3112', apiKey: 'sk-...' });

try {
  await katra.storeMemory({ content: 'Hello' });
} catch (err) {
  if (err instanceof KatraAuthError) {
    console.error('Auth failed — check your API key');
  } else if (err instanceof KatraConnectionError) {
    console.error('Server unreachable');
  } else {
    throw err;
  }
}
```

## Advanced: Low-Level MCP Client

For advanced scenarios, use `MCPClient` directly:

```ts
import { MCPClient } from '@katra/sdk';

const mcp = new MCPClient({ url: 'http://localhost:3112', apiKey: 'sk-...' });
await mcp.initialize();

const result = await mcp.callTool('search_memories', { query: 'React' });
console.log(result);

await mcp.close();
```

## Requirements

- Node.js ≥ 20.0.0 (uses native `fetch` and `AbortSignal.timeout`)
- TypeScript ≥ 5.5 (for development / type checking)

## License

MIT — see the [LICENSE](../../LICENSE) file.

## Related

- [Katra Documentation](https://github.com/katra-ai/katra)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
