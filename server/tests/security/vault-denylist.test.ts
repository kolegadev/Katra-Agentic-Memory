/**
 * Security tests: Katra Vault no-LLM guarantees (F5) — pipeline denylist.
 *
 * Source of truth: docs/contracts/katra-vault/F5-vault-no-llm.md and
 * docs/katra-vault-design.md §7.1 (objective O3, guard 1 of 3).
 *
 * Three layers:
 *  1. Unit — denylist module interface (exact names, exact-match semantics,
 *     exact error message; no DB, no LLM).
 *  2. Structural wiring — every LLM-facing collection read choke point in the
 *     processing/embedding/graph pipeline calls assertVaultCollectionAllowed
 *     immediately before the read it guards (checked against the source so the
 *     suite runs without MongoDB and without any LLM).
 *  3. Behavioral containment (real MongoDB, skipped when unreachable) —
 *     marker documents are inserted into every denylisted collection in the
 *     test database and an LLM-facing processing path (time-block
 *     summarization over episodic_events) is executed with a recording mock
 *     LLM: the allowed-collection marker IS seen by the mock LLM (guards do
 *     not over-block) while no VAULT_MARKER from any denylisted collection
 *     ever reaches a prompt. The generic collection-parameterized reader
 *     (embeddingService.searchSimilar) is additionally driven against each
 *     denylisted collection and must throw the denylist error before any
 *     read/model work happens.
 *
 * Cleanup: all rows created by this suite carry unique f5vault- marker values
 * and are deleted in afterAll (and swept in beforeAll); no production data is
 * touched or mutated.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import {
  VAULT_DENYLISTED_COLLECTIONS,
  isVaultDenylisted,
  assertVaultCollectionAllowed,
} from '../../src/services/vault/denylist.js';
import { TimeBlockSummarizer } from '../../src/services/processing/time-block-summarizer.js';
import { embeddingService } from '../../src/services/infrastructure/embedding-service.js';
import { llmService } from '../../src/services/infrastructure/llm-service.js';
import { getTestDB, closeTestDB } from '../helpers/db.js';

// The guarded pipeline services read through the server connection singleton
// (src/database/connection.ts). We must NOT drive that singleton's real
// connect path here (its startup migration/index work hangs under vitest), so
// the connection module is mocked to serve the test database handle instead.
const connState = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock('../../src/database/connection.js', () => ({
  get_database: () => {
    if (!connState.db) throw new Error('test connection mock not initialized');
    return connState.db;
  },
  connect_to_mongodb: async () => connState.db,
  is_database_connected: () => connState.db !== null,
  close_connection: async () => {},
  get_connection_error: () => null,
  get_client: () => null,
  get_pool_health: () => ({
    totalConnectionsCreated: 0,
    totalConnectionsClosed: 0,
    currentActiveConnections: 0,
    maxConnectionsObserved: 0,
  }),
}));

const MONGO_URI =
  process.env.MONGODB_URI ||
  'mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin';

// Probe connectivity (incl. auth) up front; skip DB-dependent tests when
// unavailable, so the unit run stays green without a MongoDB.
let mongoAvailable = false;
try {
  const probe = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 2000,
    connectTimeoutMS: 2000,
  });
  await probe.connect();
  await probe.close();
  mongoAvailable = true;
} catch {
  mongoAvailable = false;
}

// ── Guarded choke point registry ────────────────────────────────────────
// file → [guard call, anchor that must appear AFTER the guard]. The anchor is
// the read statement (or the unique comment directly above it) that the guard
// protects. Derived from reading the pipeline (see F5 contract).
const GUARDED_CHOKE_POINTS: Array<{
  file: string;
  guard: string;
  anchor: string;
  start: string;
  end?: string;
  why: string;
}> = [
  {
    file: 'src/services/processing/background-processor.ts',
    guard: `assertVaultCollectionAllowed('episodic_events', 'background-processor:processUnprocessedEvents');`,
    anchor: 'get_unprocessed_events(200)',
    start: 'async processUnprocessedEvents()',
    end: 'private async processEvent(',
    why: 'ingestion scan pass 1 (events later triaged/extracted)',
  },
  {
    file: 'src/services/processing/background-processor.ts',
    guard: `assertVaultCollectionAllowed('episodic_events', 'background-processor:processUnprocessedEvents');`,
    anchor: 'get_unprocessed_events(100)',
    start: 'async processUnprocessedEvents()',
    end: 'private async processEvent(',
    why: 'ingestion scan pass 2 — conversation events feed LLM extraction',
  },
  {
    file: 'src/services/processing/background-processor.ts',
    guard: `assertVaultCollectionAllowed('episodic_events', 'background-processor:processUnprocessedEvents');`,
    anchor: "db2.collection('episodic_events')",
    start: 'async processUnprocessedEvents()',
    end: 'private async processEvent(',
    why: 'auto-journal distillation session scan (LLM summarization of turns)',
  },
  {
    file: 'src/services/processing/background-processor.ts',
    guard: `assertVaultCollectionAllowed('episodic_events', 'background-processor:processEvent');`,
    anchor: 'get_session_events(sessionId, 5)',
    start: 'private async processEvent(',
    end: 'private async embedEventAndFacts(',
    why: 'conversation history read feeding extraction_service (LLM)',
  },
  {
    file: 'src/services/processing/background-processor.ts',
    guard: `assertVaultCollectionAllowed('semantic_facts', 'background-processor:embedEventAndFacts');`,
    anchor: ".collection('semantic_facts')",
    start: 'private async embedEventAndFacts(',
    end: 'private async resolveExtractedEntities(',
    why: 'embedding read path — semantic facts encoded by the embedding service',
  },
  {
    file: 'src/services/processing/time-block-summarizer.ts',
    guard: `assertVaultCollectionAllowed('episodic_events', 'time-block-summarizer:summarizeTimeBlocks');`,
    anchor: "const events = await db.collection('episodic_events')",
    start: 'async summarizeTimeBlocks(',
    end: 'async getTimeBlockSummaries(',
    why: 'time-block events handed to LLM summary generation',
  },
  {
    file: 'src/services/processing/sleep-consolidation-service.ts',
    guard: `assertVaultCollectionAllowed('episodic_events', 'sleep-consolidation-service:gatherData');`,
    anchor: "const events = await db.collection('episodic_events')",
    start: 'private async gatherData(',
    end: 'private async callLLM(',
    why: 'sleep consolidation gathers events into the LLM reflection prompt',
  },
  {
    file: 'src/services/processing/sleep-consolidation-service.ts',
    guard: `assertVaultCollectionAllowed('semantic_facts', 'sleep-consolidation-service:gatherData');`,
    anchor: "const facts = await db.collection('semantic_facts')",
    start: 'private async gatherData(',
    end: 'private async callLLM(',
    why: 'sleep consolidation gathers semantic facts into the LLM reflection prompt',
  },
  {
    file: 'src/services/processing/sleep-consolidation-service.ts',
    guard: `assertVaultCollectionAllowed('knowledge_nodes', 'sleep-consolidation-service:gatherData');`,
    anchor: "const entities = await db.collection('knowledge_nodes')",
    start: 'private async gatherData(',
    end: 'private async callLLM(',
    why: 'sleep consolidation gathers entity names into the LLM reflection prompt',
  },
  {
    file: 'src/services/memory/prospective-memory-service.ts',
    guard: `assertVaultCollectionAllowed('episodic_events', 'prospective-memory-service:distillAgedTurns');`,
    anchor: "const events = await this.db.collection('episodic_events')",
    start: 'public async distillAgedTurns(',
    end: 'public async searchAutoJournal(',
    why: 'aged conversation turns are LLM-summarized into the auto-journal',
  },
  {
    file: 'src/services/memory/prospective-memory-service.ts',
    guard: `assertVaultCollectionAllowed('memory_missions', 'prospective-memory-service:updateMissionState');`,
    anchor: "const mission = await this.db.collection('memory_missions').findOne",
    start: 'public async updateMissionState(',
    end: 'public async getMissionContextAsString(',
    why: 'mission document content is sent to the LLM for state updates',
  },
  {
    file: 'src/services/memory/episodic-event-manager.ts',
    guard: `assertVaultCollectionAllowed('episodic_events', 'episodic-event-manager:searchEvents');`,
    anchor: '// Try text search first',
    start: 'async searchEvents(',
    end: 'async getEventsInTimeRange(',
    why: 'event documents ranked by llmService.rankByRelevance',
  },
  {
    file: 'src/services/infrastructure/llm-memory-curator.ts',
    guard: `assertVaultCollectionAllowed('episodic_events', 'llm-memory-curator:retrieveRelevantMemories');`,
    anchor: '// Try text search first (fastest, but requires index)',
    start: 'async retrieveRelevantMemories(',
    end: 'private async getRecentSessionContext(',
    why: 'cross-session events fed to LLM response synthesis',
  },
  {
    file: 'src/services/infrastructure/llm-memory-curator.ts',
    guard: `assertVaultCollectionAllowed('semantic_facts', 'llm-memory-curator:retrieveRelevantMemories');`,
    anchor: "facts = await db.collection('semantic_facts')",
    start: 'async retrieveRelevantMemories(',
    end: 'private async getRecentSessionContext(',
    why: 'semantic facts fed to LLM response synthesis',
  },
  {
    file: 'src/services/infrastructure/llm-memory-curator.ts',
    guard: `assertVaultCollectionAllowed('agent_journal_auto', 'llm-memory-curator:retrieveRelevantMemories');`,
    anchor: 'searchAutoJournal(userId, userInput, 5)',
    start: 'async retrieveRelevantMemories(',
    end: 'private async getRecentSessionContext(',
    why: 'auto-journal entries fed to LLM response synthesis',
  },
  {
    file: 'src/services/infrastructure/llm-memory-curator.ts',
    guard: `assertVaultCollectionAllowed('episodic_events', 'llm-memory-curator:getRecentSessionContext');`,
    anchor: "const events = await db.collection('episodic_events')",
    start: 'private async getRecentSessionContext(',
    end: 'private detectTemporalIntent(',
    why: 'recent session events feed LLM synthesis',
  },
  {
    file: 'src/services/memory/memory-synthesis-service.ts',
    guard: `assertVaultCollectionAllowed('memory_nodes', 'memory-synthesis-service:getGraphContextAsString');`,
    anchor: "const fuzzyNodes = await this.db.collection('memory_nodes')",
    start: 'public async getGraphContextAsString(',
    end: 'public async getDeepGraphContext(',
    why: 'graph nodes formatted into context injected into the LLM system prompt',
  },
  {
    file: 'src/services/memory/memory-synthesis-service.ts',
    guard: `assertVaultCollectionAllowed('memory_edges', 'memory-synthesis-service:getGraphContextAsString');`,
    anchor: "const fuzzyNodes = await this.db.collection('memory_nodes')",
    start: 'public async getGraphContextAsString(',
    end: 'public async getDeepGraphContext(',
    why: 'graph edges formatted into context injected into the LLM system prompt',
  },
  {
    file: 'src/services/memory/memory-synthesis-service.ts',
    guard: `assertVaultCollectionAllowed('memory_edges', 'memory-synthesis-service:getDeepGraphContext');`,
    anchor: '// BFS outward from seed nodes',
    start: 'public async getDeepGraphContext(',
    why: 'multi-hop graph context injected into the LLM system prompt',
  },
  {
    file: 'src/services/memory/memory-synthesis-service.ts',
    guard: `assertVaultCollectionAllowed('memory_nodes', 'memory-synthesis-service:getDeepGraphContext');`,
    anchor: '// BFS outward from seed nodes',
    start: 'public async getDeepGraphContext(',
    why: 'multi-hop graph context injected into the LLM system prompt',
  },
  {
    file: 'src/services/infrastructure/embedding-service.ts',
    guard: `assertVaultCollectionAllowed(collection, 'embedding-service:searchSimilar');`,
    anchor: '// Fetch candidates (brute-force over embedding docs)',
    start: 'async searchSimilar(',
    why: 'generic collection-parameterized reader returning document content',
  },
  {
    file: 'src/services/processing/skill-refinement-service.ts',
    guard: `assertVaultCollectionAllowed('skill_feedback', 'skill-refinement-service:getFeedbackHistory');`,
    anchor: "const collection = db.collection('skill_feedback');",
    start: 'async getFeedbackHistory(',
    end: 'private buildRefinementPrompt(',
    why: 'feedback documents built into the LLM refinement prompt',
  },
];

// ── 1. Unit tests: module interface (always run) ───────────────────────

describe('F5 vault denylist — module interface', () => {
  it('lists exactly the five vault collections', () => {
    expect(VAULT_DENYLISTED_COLLECTIONS).toEqual([
      'secrets',
      'vault_approvals',
      'vault_audit',
      'auth_sessions',
      'auth_totp',
    ]);
  });

  it('isVaultDenylisted is true for all five collections', () => {
    for (const c of VAULT_DENYLISTED_COLLECTIONS) {
      expect(isVaultDenylisted(c)).toBe(true);
    }
  });

  it('isVaultDenylisted is false for similar-but-different names (exact match only)', () => {
    for (const c of ['secrets_backup', 'vault', 'auth_totp_x', 'episodic_events', 'vault_approval', 'secret', 'auth_sessions_v2', 'my_secrets', 'secrets_2026', '']) {
      expect(isVaultDenylisted(c)).toBe(false);
    }
  });

  it('assertVaultCollectionAllowed returns undefined for allowed names', () => {
    expect(assertVaultCollectionAllowed('episodic_events', 'test:unit')).toBeUndefined();
    expect(assertVaultCollectionAllowed('semantic_facts', 'test:unit')).toBeUndefined();
    expect(assertVaultCollectionAllowed('knowledge_nodes', 'test:unit')).toBeUndefined();
    expect(assertVaultCollectionAllowed('', 'test:unit')).toBeUndefined();
  });

  it('assertVaultCollectionAllowed throws with the exact message for each denylisted collection', () => {
    for (const c of VAULT_DENYLISTED_COLLECTIONS) {
      expect(() => assertVaultCollectionAllowed(c, 'test:ctx')).toThrow(
        `vault: denylisted collection '${c}' blocked in test:ctx`
      );
      expect(() => assertVaultCollectionAllowed(c, 'test:ctx')).toThrowError(
        /^vault: denylisted collection /
      );
    }
  });
});

// ── 2. Structural wiring: every choke point consults the guard (always run)

describe('F5 vault denylist — guard wiring at every LLM-facing choke point', () => {
  const sources = new Map<string, string>();
  for (const cp of GUARDED_CHOKE_POINTS) {
    if (!sources.has(cp.file)) {
      sources.set(
        cp.file,
        readFileSync(new URL(`../../${cp.file}`, import.meta.url), 'utf8').toString()
      );
    }
  }

  for (const cp of GUARDED_CHOKE_POINTS) {
    it(`${cp.file} guards ${cp.guard.replace('assertVaultCollectionAllowed(', '').replace(');', '')} before the read (${cp.why})`, () => {
      const src = sources.get(cp.file)!;
      const startIdx = src.indexOf(cp.start);
      expect(startIdx, `function start ${cp.start} must exist in ${cp.file}`).toBeGreaterThanOrEqual(0);
      const endIdx = cp.end ? src.indexOf(cp.end, startIdx + cp.start.length) : src.length;
      expect(endIdx, `function end ${cp.end} must exist in ${cp.file} after its start`).toBeGreaterThan(startIdx);
      const region = src.slice(startIdx, endIdx);

      const anchorIdx = region.indexOf(cp.anchor);
      expect(anchorIdx, `anchor ${cp.anchor} must exist inside ${cp.start} in ${cp.file}`).toBeGreaterThanOrEqual(0);
      // Nearest guard occurrence immediately preceding the anchored read
      // (same guard string may protect several reads in one function).
      const guardIdx = region.lastIndexOf(cp.guard, anchorIdx);
      expect(guardIdx, `guard call must exist inside ${cp.start} before ${cp.anchor} in ${cp.file}`).toBeGreaterThanOrEqual(0);

      // The guard must be the statement immediately preceding the read: no
      // other LLM-facing collection read may sit between them.
      const between = region.slice(guardIdx + cp.guard.length, anchorIdx);
      for (const otherRead of ['.collection(', 'get_unprocessed_events(', 'get_session_events(']) {
        expect(between.includes(otherRead), `no intervening read (${otherRead}) between guard and ${cp.anchor}`).toBe(false);
      }
    });
  }

  it('no pipeline file may read a denylisted collection name in an LLM-facing service without the guard import', () => {
    // The five vault collection names must not appear as literal collection
    // reads anywhere in the processing/memory/infrastructure services that
    // call the LLM — if one ever does, its read must carry the guard import.
    const guardedFiles = [
      'src/services/processing/background-processor.ts',
      'src/services/processing/time-block-summarizer.ts',
      'src/services/processing/sleep-consolidation-service.ts',
      'src/services/processing/skill-refinement-service.ts',
      'src/services/processing/skill-synthesis-service.ts',
      'src/services/processing/goal-manager.ts',
      'src/services/memory/episodic-event-manager.ts',
      'src/services/memory/prospective-memory-service.ts',
      'src/services/memory/semantic-memory-service.ts',
      'src/services/memory/memory-synthesis-service.ts',
      'src/services/infrastructure/llm-memory-curator.ts',
      'src/services/infrastructure/embedding-service.ts',
    ];
    for (const file of guardedFiles) {
      const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').toString();
      for (const vaultColl of VAULT_DENYLISTED_COLLECTIONS) {
        const readPattern = `.collection('${vaultColl}')`;
        const hasRead = src.includes(readPattern);
        if (hasRead) {
          // If a future pipeline change reads a denylisted collection, the
          // file MUST consult the denylist guard (structural tripwire).
          expect(
            src.includes("assertVaultCollectionAllowed"),
            `${file} reads '${vaultColl}' but has no vault denylist guard`
          ).toBe(true);
        }
      }
    }
  });
});

// ── 3. Behavioral containment (real MongoDB) ────────────────────────────

const RAND = randomBytes(6).toString('hex');
const TEST_USER = `f5vault-${RAND}`;
const ALLOWED_MARKER = `VAULT_ALLOWED_MARKER_${RAND}`;
const VAULT_MARKERS = new Map<string, string>(); // collection -> marker

describe.skipIf(!mongoAvailable)('F5 vault denylist — behavioral containment (real Mongo)', () => {
  let recordedPrompts: string[] = [];
  let origIsServiceAvailable: typeof llmService.isServiceAvailable;
  let origGenerateResponse: typeof llmService.generateResponse;

  beforeAll(async () => {
    const testDb = await getTestDB();
    connState.db = testDb;
    // The guarded pipeline services read through the (mocked) server
    // connection singleton, which now serves this same database handle.

    // Sweep any leftovers from a previous crashed run.
    for (const c of VAULT_DENYLISTED_COLLECTIONS) {
      await testDb.collection(c).deleteMany({ f5_vault_marker: { $exists: true } });
    }
    await testDb.collection('episodic_events').deleteMany({ user_id: TEST_USER });
    await testDb.collection('semantic_facts').deleteMany({ user_id: TEST_USER });

    // Seed a marker document into every denylisted collection. The guard is
    // exact-match on collection name, so the marker must live in the real
    // collection; rows are uniquely tagged and removed after the run.
    for (const c of VAULT_DENYLISTED_COLLECTIONS) {
      const marker = `VAULT_MARKER_${RAND}_${c}`;
      VAULT_MARKERS.set(c, marker);
      await testDb.collection(c).insertOne({
        f5_vault_marker: marker,
        f5vault_seed: true,
        name: marker,
        content: `super-secret-value-${marker}-sk-live-deadbeef`,
        created_at: new Date(),
      });
    }

    // Seed the allowed-collection document that the guarded LLM path below is
    // supposed to read (regression: guards must not over-block).
    await testDb.collection('episodic_events').insertOne({
      id: `f5vault-event-${RAND}`,
      user_id: TEST_USER,
      session_id: `f5vault-session-${RAND}`,
      event_type: 'user_message',
      timestamp: new Date(Date.now() - 60 * 60 * 1000),
      content: { role: 'user', message: `${ALLOWED_MARKER}: this is an ordinary episodic event that the summarizer may read.` },
    });

    // Install the recording mock LLM on the shared singleton (the repo seam:
    // every LLM-facing service imports `llmService` from llm-service.js).
    origIsServiceAvailable = llmService.isServiceAvailable;
    origGenerateResponse = llmService.generateResponse;
    llmService.isServiceAvailable = (() => true) as typeof llmService.isServiceAvailable;
    llmService.generateResponse = (async (userPrompt: string, systemPrompt?: string) => {
      recordedPrompts.push(userPrompt || '');
      if (systemPrompt) recordedPrompts.push(systemPrompt);
      return `F5 test summary for ${TEST_USER}`;
    }) as typeof llmService.generateResponse;
  });

  afterAll(async () => {
    if (origIsServiceAvailable) llmService.isServiceAvailable = origIsServiceAvailable;
    if (origGenerateResponse) llmService.generateResponse = origGenerateResponse;

    if (connState.db) {
      for (const c of VAULT_DENYLISTED_COLLECTIONS) {
        await connState.db.collection(c).deleteMany({ f5_vault_marker: { $exists: true } });
      }
      await connState.db.collection('episodic_events').deleteMany({ user_id: TEST_USER });
      await connState.db.collection('semantic_facts').deleteMany({ user_id: TEST_USER });
    }
    connState.db = null;
    await closeTestDB();
  });

  it('denylisted marker documents exist in the database before the run', async () => {
    const testDb = connState.db!;
    for (const c of VAULT_DENYLISTED_COLLECTIONS) {
      const doc = await testDb.collection(c).findOne({ f5_vault_marker: VAULT_MARKERS.get(c) });
      expect(doc, `marker doc seeded in '${c}'`).not.toBeNull();
    }
  });

  it('the guarded generic reader throws the denylist error for every denylisted collection and never reads', async () => {
    for (const c of VAULT_DENYLISTED_COLLECTIONS) {
      await expect(
        embeddingService.searchSimilar(c, TEST_USER, `query ${ALLOWED_MARKER}`, { limit: 3 })
      ).rejects.toThrow(`vault: denylisted collection '${c}' blocked in embedding-service:searchSimilar`);
    }
  });

  it('the guarded LLM path runs for an allowed collection and the mock LLM sees only allowed content', async () => {
    const summarizer = new TimeBlockSummarizer();
    const result = await summarizer.summarizeTimeBlocks({
      user_id: TEST_USER,
      block_type: 'day',
      lookback_days: 2,
      max_blocks: 5,
    });

    // Regression: the allowed-collection document flowed through (its content
    // was read and handed to the mock LLM) — guards do not over-block.
    expect(result.summaries_generated).toBeGreaterThanOrEqual(1);
    const allPrompts = recordedPrompts.join('\n');
    expect(allPrompts).toContain(ALLOWED_MARKER);
  });

  it('no VAULT_MARKER from any denylisted collection ever reached the mock LLM', () => {
    const allPrompts = recordedPrompts.join('\n');
    for (const c of VAULT_DENYLISTED_COLLECTIONS) {
      expect(allPrompts).not.toContain(`VAULT_MARKER_${RAND}_${c}`);
      expect(allPrompts).not.toContain(VAULT_MARKERS.get(c));
    }
  });

  it('every guarded pipeline read names an allowed collection (containment by construction)', () => {
    // All fixed-name LLM-facing reads in the pipeline consult the guard with
    // an allowed collection today, so the five denylisted collections can only
    // reach an LLM-facing read through the parameterized reader
    // (embeddingService.searchSimilar), which throws (asserted above). If a
    // future pipeline change adds a read of a denylisted collection, this
    // assertion fails and the new read must carry its own guard.
    for (const cp of GUARDED_CHOKE_POINTS) {
      const match = cp.guard.match(/assertVaultCollectionAllowed\(([^,]+), '([^']+)'\)/);
      if (!match) continue;
      const collection = match[1].replace(/'/g, '').trim();
      if (collection === 'collection') continue; // parameterized — covered above
      expect(isVaultDenylisted(collection), `${collection} must not be denylisted (${match[2]})`).toBe(false);
    }
  });
});
