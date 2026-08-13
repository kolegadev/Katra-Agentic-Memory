#!/usr/bin/env node
/**
 * Bulk drain of the episodic_events distillation backlog.
 *
 * The live background processor throttles conversation events to 12 per 30s
 * cycle by design, so a large backlog (e.g. 160k+ gas-law training events)
 * would take days to drain. This script runs the SAME pipeline — extraction
 * (tiered: skip <50 chars, regex 50-199, LLM >=200), entity resolution,
 * dispatch to memory stores, processing_log idempotency, Redis distributed
 * locks — but with no per-cycle bottleneck and bounded concurrency.
 *
 * Runs INSIDE the katra-server container so it reuses the exact same build
 * and services as live processing (vector parity, same LLM config, same DB).
 * Safe to run alongside the live server: Redis locks + processing_log
 * idempotency prevent double-processing. Embeddings are intentionally NOT
 * written here — run scripts/backfill-embeddings.mjs and
 * scripts/backfill-episodic-embeddings.mjs afterwards to cover all docs.
 *
 * Env:
 *   CONCURRENCY=4      parallel workers for the expensive extraction path
 *   MAX=0              cap for a smoke run (0 = all)
 *   BATCH=200          events fetched per loop iteration
 *   TRIAGE_SYSTEM=1    triage system events (heartbeat etc.) without LLM
 */
import { MemoryManager } from '/app/build/services/memory/memory-manager.js';
import { extraction_service } from '/app/build/services/processing/extraction-service.js';
import { dispatch_service } from '/app/build/services/processing/dispatch-service.js';
import { getEpisodicEventManager } from '/app/build/services/memory/episodic-event-manager.js';
import { stableContentHash } from '/app/build/services/infrastructure/content-hash-utils.js';
import { entityResolver } from '/app/build/services/integration/entity-resolver.js';
import { get_database, connect_to_mongodb } from '/app/build/database/connection.js';

const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '4', 10));
const MAX = parseInt(process.env.MAX || '0', 10);
const BATCH = Math.max(50, parseInt(process.env.BATCH || '1000', 10));
const TRIAGE_SYSTEM = process.env.TRIAGE_SYSTEM !== '0';

const SYSTEM_EVENT_TYPES = new Set([
  'heartbeat_action',
  'task_execution',
  'autonomous_action',
  'system_update',
  'agent_bulletin',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function eventContent(event) {
  return event.content?.message || event.content?.description || (typeof event.content === 'string' ? event.content : JSON.stringify(event.content || ''));
}

async function getDb() {
  return get_database();
}

/** Compute + persist content_hash if missing (mirrors background processor). */
async function ensureContentHash(event) {
  const content = eventContent(event);
  if (event.content_hash || !content) return event.content_hash || '';
  const hash = stableContentHash(event.user_id || 'unknown', content);
  try {
    const db = await getDb();
    await db.collection('episodic_events').updateOne(
      { id: event.id },
      { $set: { content_hash: hash } }
    );
  } catch { /* non-critical — recomputed next pass */ }
  return hash;
}

/** Hard dedup: content_hash already completed in processing_log. */
async function isHardDeduped(event, contentHash) {
  if (!contentHash) return false;
  try {
    const db = await getDb();
    const existing = await db.collection('processing_log').findOne({
      idempotency_key: { $regex: new RegExp(contentHash.slice(0, 16)) },
      status: 'completed',
    });
    if (existing) {
      await memoryManager.mark_event_processed(event.id, {
        processed_at: new Date(),
        extraction_result: {
          entities_count: 0, relationships_count: 0, facts_count: 0,
          reason: 'hard_dedup_backfill',
        },
      }).catch(() => {});
      return true;
    }
  } catch { /* non-critical */ }
  return false;
}

async function checkIdempotency(idempotencyKey) {
  try {
    const db = await getDb();
    const entry = await db.collection('processing_log').findOne({
      idempotency_key: idempotencyKey,
      status: { $in: ['processing', 'completed'] },
    });
    return entry !== null;
  } catch {
    return false; // err on the side of processing
  }
}

async function createProcessingLogEntry(idempotencyKey, eventId, sessionId) {
  try {
    const db = await getDb();
    await db.collection('processing_log').insertOne({
      idempotency_key: idempotencyKey,
      event_id: eventId,
      session_id: sessionId,
      status: 'processing',
      started_at: new Date(),
      processor_id: `bulk-drain-${process.pid}`,
    });
  } catch (e) {
    console.warn('⚠️ Failed to create processing log entry:', e.message);
  }
}

async function updateProcessingLogEntry(idempotencyKey, status, results) {
  try {
    const db = await getDb();
    const updateData = { status, updated_at: new Date() };
    if (status === 'completed' && results) {
      updateData.completed_at = new Date();
      updateData.processing_results = results;
    } else if (status === 'failed' && results) {
      updateData.failed_at = new Date();
      updateData.error = results;
    }
    await db.collection('processing_log').updateOne(
      { idempotency_key: idempotencyKey },
      { $set: updateData }
    );
  } catch (e) {
    console.warn('⚠️ Failed to update processing log entry:', e.message);
  }
}

async function resolveExtractedEntities(extractionResult, userId, sessionId) {
  const idMapping = new Map();
  if (!extractionResult.entities || extractionResult.entities.length === 0) return;

  for (const entity of extractionResult.entities) {
    try {
      const resolved = await entityResolver.resolveEntity({
        userId,
        sessionId,
        entityText: entity.name,
        entityType: entity.type,
        confidence: entity.confidence,
        contextTerms: entity.properties?.context_terms || entity.properties?.keywords || [],
        preferredId: entity.id,
      });
      idMapping.set(entity.id, resolved.canonicalId);
    } catch {
      idMapping.set(entity.id, entity.id);
    }
  }
  for (const entity of extractionResult.entities) {
    const canonical = idMapping.get(entity.id);
    if (canonical) entity.id = canonical;
  }
  if (extractionResult.relationships) {
    for (const rel of extractionResult.relationships) {
      const from = idMapping.get(rel.from_entity_id);
      const to = idMapping.get(rel.to_entity_id);
      if (from) rel.from_entity_id = from;
      if (to) rel.to_entity_id = to;
    }
  }
  if (extractionResult.events) {
    for (const evt of extractionResult.events) {
      if (Array.isArray(evt.entities_involved)) {
        evt.entities_involved = evt.entities_involved.map((id) => idMapping.get(id) || id);
      }
    }
  }
  if (extractionResult.semantic_facts) {
    for (const fact of extractionResult.semantic_facts) {
      if (fact.properties?.source_entity_id) {
        const canonical = idMapping.get(fact.properties.source_entity_id);
        if (canonical) fact.properties.source_entity_id = canonical;
      }
    }
  }
}

const memoryManager = MemoryManager.get_instance();

/** Full pipeline for a non-system event. Returns 'processed' | 'skipped' | 'failed'. */
async function processEvent(event) {
  const eventId = event.id;
  const sessionId = event.session_id;
  const userId = event.user_id;
  const content = eventContent(event);

  const contentHash = await ensureContentHash(event);
  if (!eventId || !sessionId || !userId || !contentHash) {
    throw new Error(`Event missing required fields: id=${!!eventId}, session=${!!sessionId}, user=${!!userId}, contentHash=${!!contentHash}`);
  }

  // Redis distributed lock (same keyspace as the live processor)
  const episodicManager = getEpisodicEventManager();
  const lockManager = episodicManager.lockManager;
  const lockKey = `processing:${sessionId}:${contentHash}`;
  const lockAcquired = await lockManager.acquireLock(lockKey, 300);
  if (!lockAcquired) return 'skipped'; // another instance is handling it

  const idempotencyKey = event.idempotency_key;
  try {
    // Re-check processed state under the lock
    const db = await getDb();
    const current = await db.collection('episodic_events').findOne({ id: eventId });
    if (current?.metadata?.processed === true) return 'skipped';

    if (idempotencyKey) {
      if (await checkIdempotency(idempotencyKey)) return 'skipped';
      await createProcessingLogEntry(idempotencyKey, eventId, sessionId);
    }

    // Conversation history context (last 3 messages, same as live)
    const recentEvents = await memoryManager.get_session_events(sessionId, 5);
    const conversationHistory = recentEvents
      .filter((e) => e.content?.message && e.id !== eventId)
      .map((e) => e.content.message)
      .slice(-3);

    const extractionContext = {
      session_id: sessionId,
      user_id: userId,
      timestamp: new Date(event.timestamp || Date.now()),
      conversation_history: conversationHistory,
      extraction_focus: 'comprehensive_extraction_with_specifics',
    };

    const extractionResult = await extraction_service.extractStructuredData(content, extractionContext);
    if (!extractionResult) throw new Error('Extraction service returned null/undefined result');

    if (extractionResult.entities.length === 0 &&
        extractionResult.relationships.length === 0 &&
        extractionResult.semantic_facts.length === 0) {
      await memoryManager.mark_event_processed(eventId, {
        processed_at: new Date(),
        extraction_result: {
          entities_count: 0, relationships_count: 0, facts_count: 0,
          reason: 'no_meaningful_information',
        },
      });
      return 'processed';
    }

    try {
      await resolveExtractedEntities(extractionResult, userId, sessionId);
    } catch (e) {
      console.warn(`⚠️ Entity resolution failed for ${eventId}, proceeding raw:`, e.message);
    }

    const dispatchResult = await dispatch_service.dispatchToMemory(extractionResult, {
      session_id: sessionId,
      user_id: userId,
      source_event_id: eventId,
      source_event_timestamp: new Date(event.timestamp || Date.now()),
      timestamp: new Date(event.timestamp || Date.now()),
      batch_id: `bulk-drain-${eventId}`,
      priority: 'low',
    });

    await memoryManager.mark_event_processed(eventId, {
      processed_at: new Date(),
      extraction_result: {
        entities_count: extractionResult.entities.length,
        relationships_count: extractionResult.relationships.length,
        facts_count: extractionResult.semantic_facts.length,
        processing_time_ms: extractionResult.processing_metadata?.extraction_time,
      },
      dispatch_result: {
        operations_completed: dispatchResult.operations_completed,
        operations_failed: dispatchResult.operations_failed,
      },
    });

    if (idempotencyKey) {
      await updateProcessingLogEntry(idempotencyKey, 'completed', {
        processed_at: new Date(),
        extraction_summary: {
          entity_count: extractionResult.entities.length,
          relationship_count: extractionResult.relationships.length,
          fact_count: extractionResult.semantic_facts.length,
        },
        dispatch_summary: {
          operations_completed: dispatchResult.operations_completed,
          operations_failed: dispatchResult.operations_failed,
        },
      });
    }
    return 'processed';
  } catch (e) {
    console.error(`❌ Failed to process ${eventId}:`, e.message);
    try {
      await memoryManager.mark_event_processing_failed(eventId, e.message);
    } catch { /* non-critical */ }
    if (idempotencyKey) {
      await updateProcessingLogEntry(idempotencyKey, 'failed', e.message);
    }
    return 'failed';
  } finally {
    await lockManager.releaseLock(lockKey).catch(() => {});
  }
}

/** Cheap triage for system events (no LLM) — mirrors processSystemEvent. */
async function triageEvent(event) {
  const eventId = event.id;
  await ensureContentHash(event);
  try {
    await memoryManager.mark_event_processed(eventId, {
      processed_at: new Date(),
      extraction_result: {
        entities_count: 0, relationships_count: 0, facts_count: 0,
        reason: 'system_event_triaged',
      },
    });
    return 'processed';
  } catch (e) {
    console.error(`❌ Failed to triage ${eventId}:`, e.message);
    try { await memoryManager.mark_event_processing_failed(eventId, e.message); } catch { /* non-critical */ }
    return 'failed';
  }
}

async function main() {
  const started = Date.now();
  const startedAt = new Date();
  let processed = 0, failed = 0, skipped = 0, triaged = 0;

  await connect_to_mongodb(); // initializes the shared singleton used by all services
  const db = await getDb();

  /**
   * Clear idempotency entries stuck in 'processing' (e.g. from crashed/killed
   * drain instances or server restarts). Extraction takes seconds; anything
   * older than 30 min is orphaned and would block its events forever.
   */
  async function clearStaleProcessingEntries() {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    const res = await db.collection('processing_log').updateMany(
      { status: 'processing', started_at: { $lt: cutoff } },
      { $set: { status: 'failed', updated_at: new Date(), error: 'stale_timeout_bulk_drain' } }
    );
    if (res.modifiedCount > 0) console.log(`[drain] cleared ${res.modifiedCount} stale processing entries`);
  }

  /**
   * Dispatched (extracted) activity records re-enter the queue via store_event
   * (content.description, no content.message) and would be re-distilled by the
   * LLM — a self-perpetuating refill. They're already-distilled records, so
   * mark them processed without re-extraction. Real ingested messages
   * (content.message) are never touched.
   */
  async function shortCircuitDispatched() {
    const res = await db.collection('episodic_events').updateMany(
      {
        'metadata.processed': { $ne: true },
        timestamp: { $gte: startedAt },
        'content.message': { $exists: false },
        'content.description': { $exists: true },
      },
      {
        $set: {
          'metadata.processed': true,
          'metadata.processed_at': new Date(),
          'metadata.processing_metadata': {
            extraction_result: {
              entities_count: 0, relationships_count: 0, facts_count: 0,
              reason: 'dispatch_record_short_circuit',
            },
          },
        },
      }
    );
    if (res.modifiedCount > 0) {
      console.log(`[drain] short-circuited ${res.modifiedCount} dispatched records`);
      skipped += res.modifiedCount;
    }
  }
  const total = await db.collection('episodic_events').countDocuments({
    'metadata.processed': { $ne: true },
    'metadata.terminal_failure': { $ne: true },
    id: { $exists: true, $ne: null },
    user_id: { $exists: true, $ne: null },
    session_id: { $exists: true, $ne: null },
  });
  console.log(`[drain] backlog: ${total} unprocessed events (concurrency=${CONCURRENCY}, max=${MAX || 'all'})`);

  // Clear any dispatched records and stale idempotency entries already sitting in the queue from prior runs.
  try { await shortCircuitDispatched(); } catch (e) { console.warn('[drain] initial short-circuit sweep failed:', e.message); }
  try { await clearStaleProcessingEntries(); } catch (e) { console.warn('[drain] initial stale-entry sweep failed:', e.message); }

  // ── Pass 1: triage system events at full speed ──
  if (TRIAGE_SYSTEM) {
    while (true) {
      const events = await memoryManager.get_unprocessed_events(BATCH);
      const sysEvents = events.filter((e) => SYSTEM_EVENT_TYPES.has(e.event_type));
      if (sysEvents.length === 0) break;
      for (const ev of sysEvents) {
        const r = await triageEvent(ev);
        triaged++;
        if (r === 'failed') failed++;
      }
      console.log(`[drain] triaged ${triaged} system events so far`);
    }
    if (triaged > 0) console.log(`[drain] pass 1 complete: ${triaged} system events triaged`);
  }

  // ── Pass 2: conversation events via bounded worker pool ──
  let nextIdx = 0;
  let eventsBuf = [];
  let done = false;
  let fetching = false;
  let progressSinceFetch = 0;
  const inFlight = new Set(); // event ids currently being processed — prevents re-taking events from an overlapping refetch window

  async function fetchMore() {
    if (fetching) return;
    fetching = true;
    try {
      // Back off if the last full buffer produced no progress — the same
      // events are being skipped (e.g. stale idempotency entries, locks held
      // by another instance). Avoids a hot spin loop on a stuck window.
      if (progressSinceFetch === 0 && nextIdx > 0) await sleep(3000);
      const events = await memoryManager.get_unprocessed_events(BATCH);
      const conv = events.filter((e) => !SYSTEM_EVENT_TYPES.has(e.event_type));
      if (conv.length === 0) {
        done = true;
        return;
      }
      eventsBuf = conv;
      nextIdx = 0;
      progressSinceFetch = 0;
    } finally {
      fetching = false;
    }
  }

  async function worker(id) {
    while (true) {
      if (MAX && processed + failed >= MAX) return;
      if (nextIdx >= eventsBuf.length && !done) {
        try { await fetchMore(); } catch (e) { console.error('[drain] fetch failed:', e.message); await sleep(2000); }
      }
      if (nextIdx >= eventsBuf.length && done) return;
      if (nextIdx >= eventsBuf.length) await sleep(100);
      const event = eventsBuf[nextIdx++];
      if (!event) continue;
      if (inFlight.has(event.id)) { skipped++; continue; } // overlap from previous window — already being handled
      inFlight.add(event.id);

      // Cheap pre-checks before the lock (mirror isEventRecentlyProcessed)
      if (event.metadata?.processed === true || event.processed === true) { skipped++; continue; }
      const contentHash = event.content_hash || (await ensureContentHash(event));
      if (await isHardDeduped(event, contentHash)) { skipped++; continue; }

      let result = 'skipped';
      try {
        result = await processEvent(event);
      } finally {
        inFlight.delete(event.id);
      }
      if (result === 'processed') { processed++; progressSinceFetch++; }
      else if (result === 'failed') { failed++; progressSinceFetch++; }
      else skipped++;

      // Periodically short-circuit dispatched records and clear stale entries
      // so the queue cannot be refilled or blocked by stale idempotency state.
      if ((processed + failed) % 200 === 0) {
        try { await shortCircuitDispatched(); } catch (e) { console.warn('[drain] short-circuit sweep failed:', e.message); }
        try { await clearStaleProcessingEntries(); } catch (e) { console.warn('[drain] stale-entry sweep failed:', e.message); }
      }

      if ((processed + failed + skipped) % 50 === 0 || MAX) {
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        const rate = ((processed + failed) / (Date.now() - started) * 1000).toFixed(1);
        console.log(`[drain] progress: ${processed} processed, ${failed} failed, ${skipped} skipped, ${triaged} triaged in ${secs}s (~${rate}/s)`);
      }
    }
  }

  await fetchMore();
  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i));
  await Promise.all(workers);

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`[drain] DONE: ${processed} processed, ${failed} failed, ${skipped} skipped, ${triaged} triaged in ${secs}s`);
  try { await shortCircuitDispatched(); } catch { /* non-critical */ }
  const remaining = await db.collection('episodic_events').countDocuments({ 'metadata.processed': { $ne: true } });
  console.log(`[drain] remaining unprocessed: ${remaining}`);
  process.exit(0); // resumable — failures are logged and retryable
}

main().catch((e) => { console.error('[drain] FATAL:', e); process.exit(1); });
