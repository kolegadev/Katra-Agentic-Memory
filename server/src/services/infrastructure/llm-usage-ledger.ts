// LLM usage ledger — REAL cost measurement (Phase 4 §2, option a).
// Mirrors kolega-code's runtime usage ledger (llm/ledger.py) in TypeScript,
// per Lilly's resolved-prerequisite directive (event_5f716a7a):
//   1. attribution by context scope: AsyncLocalStorage origin (Node's
//      equivalent of ContextVar) — child scopes shadow, teardown restores
//      automatically when the async context exits (no manual reset bug).
//   2. exactly-once settlement: begin() -> request_id; recordResponse or
//      recordFailure; first settle wins, later calls no-op. Nothing raises
//      into the request path; abandoned streams stay OPEN (visible).
//   3. snapshot deltas: UsageSnapshot.complete() and .since(earlier);
//      `open` is the CURRENT outstanding count (not a delta), and a
//      snapshot from a different run_id returns self, never a negative.
//   4. TOKENS, NOT CURRENCY: the unit is measured tokens. Pricing stays a
//      separate derivation; this module records token counts only.
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from 'mongodb';

export interface UsageOrigin {
  mission_id?: string;
  work_item_id?: string;
  agent_id?: string;
}

export interface UsageRecord {
  request_id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_write_input_tokens: number;
  reasoning_output_tokens: number;
  outcome: 'ok' | 'failed';
  error?: string;
  origin: UsageOrigin | null;
  created_at: string;
}

export interface UsageSnapshot {
  run_id: string;
  requests: number;   // begun
  responses: number;  // settled ok
  failed: number;     // settled failed
  open: number;       // begun but not settled
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_write_input_tokens: number;
  reasoning_output_tokens: number;
  complete: boolean;  // every begun request settled
}

const USAGE_COLLECTION = 'llm_usage';
const USAGE_TTL_SECONDS = 60 * 24 * 3600; // 60 days of cost telemetry

const origins = new AsyncLocalStorage<UsageOrigin | null>();

export function runWithUsageOrigin<T>(origin: UsageOrigin | null, fn: () => T): T {
  return origins.run(origin, fn);
}

export function currentUsageOrigin(): UsageOrigin | null {
  return origins.getStore() ?? null;
}

let _ensureIndexesPromise: Promise<void> | null = null;

export function ensureUsageIndexes(db: Db): Promise<void> {
  if (!_ensureIndexesPromise) {
    _ensureIndexesPromise = (async () => {
      await Promise.all([
        db.collection(USAGE_COLLECTION).createIndex({ request_id: 1 }, { unique: true, name: 'usage_request_unique' }),
        db.collection(USAGE_COLLECTION).createIndex({ mission_id: 1, created_at: -1 }, { name: 'usage_mission' }),
        db.collection(USAGE_COLLECTION).createIndex({ work_item_id: 1, created_at: -1 }, { name: 'usage_workitem' }),
        db.collection(USAGE_COLLECTION).createIndex({ _expires_at: 1 }, { expireAfterSeconds: 0, name: 'usage_ttl' }),
      ]);
    })().catch(() => { _ensureIndexesPromise = null; });
  }
  return _ensureIndexesPromise;
}

interface OpenRequest {
  request_id: string;
  provider: string;
  model: string;
  begun_at: string;
  settled: boolean;
}

interface LedgerState {
  run_id: string;
  requests: number;
  responses: number;
  failed: number;
  open: OpenRequest[];
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_write_input_tokens: number;
  reasoning_output_tokens: number;
}

let state: LedgerState = {
  run_id: randomUUID(),
  requests: 0,
  responses: 0,
  failed: 0,
  open: [],
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_write_input_tokens: 0,
  reasoning_output_tokens: 0,
};

export function beginUsageCall(provider: string, model: string): string {
  const request_id = randomUUID();
  state.requests += 1;
  state.open.push({ request_id, provider, model, begun_at: new Date().toISOString(), settled: false });
  return request_id;
}

function settle(requestId: string, patch: (r: OpenRequest) => void): void {
  const idx = state.open.findIndex(r => r.request_id === requestId);
  if (idx === -1) return;
  const r = state.open[idx];
  if (r.settled) return; // first settle wins; later calls no-op
  r.settled = true;
  patch(r);
  state.open.splice(idx, 1);
}

export interface NormalizedUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_write_input_tokens?: number;
  reasoning_output_tokens?: number;
}

/** Extract token counts from any provider-shaped response/usage payload. */
export function extractUsage(payload: unknown): NormalizedUsage {
  const u = (payload as any)?.usage ?? payload ?? {};
  const details = u.prompt_tokens_details ?? {};
  return {
    input_tokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0),
    output_tokens: Number(u.completion_tokens ?? u.output_tokens ?? 0),
    cache_read_input_tokens: Number(details.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens ?? 0),
    cache_write_input_tokens: Number(u.prompt_cache_miss_tokens ?? u.cache_write_input_tokens ?? 0),
    reasoning_output_tokens: Number(u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0),
  };
}

let _dbPromise: Promise<Db | null> | null = null;

async function dbRef(): Promise<Db | null> {
  if (_dbPromise === null) {
    _dbPromise = (async () => {
      try {
        const { get_database } = await import('../../database/connection.js');
        return get_database();
      } catch {
        return null;
      }
    })();
  }
  return _dbPromise;
}

/** Persist a settled record. Never throws into the request path. */
function persist(record: UsageRecord): void {
  dbRef()
    .then(async (db) => {
      if (!db) return;
      try {
        await ensureUsageIndexes(db);
        await db.collection(USAGE_COLLECTION).insertOne({
          ...record,
          mission_id: record.origin?.mission_id ?? null,
          work_item_id: record.origin?.work_item_id ?? null,
          agent_id: record.origin?.agent_id ?? null,
          _expires_at: new Date(Date.now() + USAGE_TTL_SECONDS * 1000),
        });
      } catch {
        /* ledger must never break the request path */
      }
    })
    .catch(() => {});
}

export function recordUsageResponse(requestId: string, usage: NormalizedUsage): void {
  const u = extractUsage(usage);
  settle(requestId, (r) => {
    state.responses += 1;
    state.input_tokens += u.input_tokens ?? 0;
    state.output_tokens += u.output_tokens ?? 0;
    state.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    state.cache_write_input_tokens += u.cache_write_input_tokens ?? 0;
    state.reasoning_output_tokens += u.reasoning_output_tokens ?? 0;
    persist({
      request_id: requestId,
      provider: r.provider,
      model: r.model,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_write_input_tokens: u.cache_write_input_tokens ?? 0,
      reasoning_output_tokens: u.reasoning_output_tokens ?? 0,
      outcome: 'ok',
      origin: currentUsageOrigin(),
      created_at: r.begun_at,
    });
  });
}

export function recordUsageFailure(requestId: string, error: unknown): void {
  settle(requestId, (r) => {
    state.failed += 1;
    persist({
      request_id: requestId,
      provider: r.provider,
      model: r.model,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: 0,
      outcome: 'failed',
      error: String((error as any)?.message ?? error).slice(0, 500),
      origin: currentUsageOrigin(),
      created_at: r.begun_at,
    });
  });
}

/** Snapshot of the aggregate at one moment. Immutable copy. */
export function usageSnapshot(): UsageSnapshot {
  return {
    run_id: state.run_id,
    requests: state.requests,
    responses: state.responses,
    failed: state.failed,
    open: state.open.filter(r => !r.settled).length,
    input_tokens: state.input_tokens,
    output_tokens: state.output_tokens,
    cache_read_input_tokens: state.cache_read_input_tokens,
    cache_write_input_tokens: state.cache_write_input_tokens,
    reasoning_output_tokens: state.reasoning_output_tokens,
    complete: state.open.every(r => r.settled),
  };
}

/** Delta since an earlier snapshot. `open` is CURRENT, not a difference. */
export function usageDeltaSince(earlier: UsageSnapshot): UsageSnapshot {
  const now = usageSnapshot();
  if (now.run_id !== earlier.run_id) return now; // different run: never nonsense negatives
  const sub = (a: number, b: number) => Math.max(0, a - b);
  return {
    run_id: now.run_id,
    requests: sub(now.requests, earlier.requests),
    responses: sub(now.responses, earlier.responses),
    failed: sub(now.failed, earlier.failed),
    open: now.open, // current outstanding count, NOT a difference
    input_tokens: sub(now.input_tokens, earlier.input_tokens),
    output_tokens: sub(now.output_tokens, earlier.output_tokens),
    cache_read_input_tokens: sub(now.cache_read_input_tokens, earlier.cache_read_input_tokens),
    cache_write_input_tokens: sub(now.cache_write_input_tokens, earlier.cache_write_input_tokens),
    reasoning_output_tokens: sub(now.reasoning_output_tokens, earlier.reasoning_output_tokens),
    complete: now.complete,
  };
}

/** Persisted measured tokens for a mission (and optionally one work item). */
export async function measuredTokensForScope(db: Db, missionId: string, workItemId?: string): Promise<number> {
  const filter: Record<string, unknown> = workItemId
    ? { mission_id: missionId, work_item_id: workItemId }
    : { mission_id: missionId };
  const rows = await db
    .collection(USAGE_COLLECTION)
    .find(filter, { projection: { _id: 0, input_tokens: 1, output_tokens: 1 } })
    .toArray();
  let total = 0;
  for (const r of rows as unknown as Array<{ input_tokens?: number; output_tokens?: number }>) {
    total += (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
  }
  return total;
}
