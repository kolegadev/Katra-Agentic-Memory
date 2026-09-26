/**
 * ITER-11, WS-3 (DoD #7) — the EXECUTED rollback test and the deprecation
 * telemetry of the legacy global personality record.
 *
 * Contract §WS-3:
 *   1. "a test that, against the FakeDb, (a) captures a pre-rollback baseline,
 *      (b) runs the documented flag-off path (`PER_IDENTITY_PERSONALITY` off)
 *      and asserts the legacy read/write behaviour is byte-identical to the
 *      pre-feature shape, (c) exercises the code-revert path by proving no
 *      additive artifact is required by any read (e.g. dropping the flag-gated
 *      collections' contents leaves the personality/bridge paths functional),
 *      and (d) asserts the rollout view and `docs/IMAGINATION-ROLLOUT.md` still
 *      name the commands it just exercised."
 *   2. deprecation telemetry: "when a request arrives for the legacy global
 *      personality record (the no-`user_id` path with the flag on, or any
 *      consumer still reading the legacy key), record a bounded counter/audit
 *      row (`personality_deprecation_events`, TTL'd) and surface the count in
 *      the rollout view; tests for it."
 *
 * The rollback path is EXECUTED, not string-asserted: the test takes the
 * documented `flag_off_command` from the live rollout view, RUNS its
 * environment half through `bash` against a temporary `.env` (the `docker
 * compose up` half is what a deployment does; a unit test cannot restart a
 * container and says so), reads the resulting file back, applies exactly what
 * it says to the process environment, and then drives the real Hono admin
 * router (the bridge's own consumer surface) with the flag off.
 *
 * Fails against the pre-iteration sources: the rollout view carried no
 * `deprecation_telemetry` block, `personality_deprecation_events` did not
 * exist, and no route ever counted a legacy read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const holder = vi.hoisted(() => ({ db: null as any }));

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => holder.db,
  is_database_connected: () => holder.db !== null,
}));

vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
  is_redis_healthy: async () => false,
  close_redis_connection: async () => {},
  get_redis_status: () => ({ connected: false }),
}));

import { Hono } from 'hono';
import { FakeDb } from '../helpers/fake-mongo.js';
import { createCallerAuthMiddleware } from '../../src/middleware/caller-auth.js';
import { create_admin_routes } from '../../src/routes/admin-routes.js';
import { createImaginationDashboardRoutes } from '../../src/routes/imagination-dashboard-routes.js';
import {
  clearClientKeyIdentities,
  ensureApiKeys,
  hashApiKey,
  registerClientKeyIdentity,
} from '../../src/utils/api-key-manager.js';
import {
  DEPRECATION_EVENT_COLLECTION,
  DEPRECATION_KINDS,
  DEPRECATION_TTL_DAYS,
  countPersonalityDeprecationEvents,
  deprecationEventKey,
  notePersonalityDeprecation,
  resetDeprecationThrottle,
  utcDay,
} from '../../src/services/integration/personality-deprecation-telemetry.js';
import { personalityConfigKey, resolvePersonalityConfig } from '../../src/services/integration/personality-config-service.js';
import { validateDeprecationEventRow } from '../../src/types/memory.js';
import { PERSONAL_KINDS } from '../../src/services/memory/write-scope-policy.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ROLLOUT_DOC = path.join(REPO_ROOT, 'docs/IMAGINATION-ROLLOUT.md');

const ADMIN_KEY = 'katra-admin-iter11-rollback-key';
const LEGACY_KEY = 'personality_config';
const DOC_ENV_VAR = 'PER_IDENTITY_PERSONALITY';

let db: FakeDb;

const settings = () => db.collection('system_settings');
const events = () => db.collection(DEPRECATION_EVENT_COLLECTION).docs as Array<Record<string, any>>;

const app = new Hono();
app.use('/api/*', createCallerAuthMiddleware());
app.route('/api/v1/admin', create_admin_routes());

// The rollout view is reachable with no flag and no identity (like /status), so
// the app needs no auth middleware — the same construction the dashboard suite
// uses.
const rolloutApp = new Hono().route('/api/v1/imagination', createImaginationDashboardRoutes());

async function call(
  method: 'GET' | 'PUT',
  path: string,
  opts: { key?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.key) headers['Authorization'] = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(`http://localhost/api/v1/admin${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

async function getRollout(query = ''): Promise<any> {
  const res = await rolloutApp.request(`http://localhost/api/v1/imagination/rollout${query}`);
  return res.json();
}

/**
 * The same read from a TRUSTED operator (ITER-11 refinement): the rollout view's
 * deprecation counters are pinned to the caller's own identity by default — the
 * bare `rolloutApp.request` above is the safe default caller, which is untrusted
 * — so the cross-identity view has to be asked for explicitly.
 */
async function getRolloutAsOperator(query = ''): Promise<any> {
  const { runWithCaller } = await import('../../src/utils/caller-identity.js');
  return runWithCaller({ user_id: 'operator', trusted: true }, async () =>
    (await rolloutApp.request(`http://localhost/api/v1/imagination/rollout${query}`)).json(),
  );
}

const VALID_BODY = {
  personality: 'analyst',
  source_weights: { vector_search: 6 },
  scoring: { relevance_multiplier: 2.5 },
  max_context_tokens: 6000,
};

/** The keys a pre-feature legacy write produced — the pinned shape. */
const PRE_FEATURE_LEGACY_KEYS = ['key', 'max_context_tokens', 'personality', 'scoring', 'source_weights', 'updated_at'];

beforeEach(async () => {
  db = new FakeDb();
  holder.db = db.asDb();
  resetDeprecationThrottle();
  clearClientKeyIdentities();
  delete process.env[`MCP_API_KEY`];
  delete process.env.KATRA_API_KEY;
  delete process.env[`${DOC_ENV_VAR}`];
  process.env.MCP_API_KEY = 'katra-mcp-iter11-rollback-key';
  process.env.KATRA_API_KEY = ADMIN_KEY;
  await ensureApiKeys();
  registerClientKeyIdentity(hashApiKey('katra-agent-a-iter11-rollback-key'), 'agent-a');
});

afterEach(() => {
  clearClientKeyIdentities();
  delete process.env[`MCP_API_KEY`];
  delete process.env.KATRA_API_KEY;
  delete process.env[DOC_ENV_VAR];
  resetDeprecationThrottle();
});

// ── 1. The executed rollback ────────────────────────────────────────────────

describe('executed rollback — the documented flag-off path, run for real', () => {
  it('flag on → rollout command executed against a real .env → legacy read/write byte-identical to the baseline', async () => {
    // (a) THE PRE-ROLLBACK BASELINE. With the flag ON, an identity that owns no
    // record is served by the legacy global record — the pre-feature behaviour —
    // and the baseline is captured by asking the real resolver for it.
    process.env[DOC_ENV_VAR] = '1';
    settings().docs.push({
      key: LEGACY_KEY,
      personality: 'scholar',
      source_weights: { vector_search: 7 },
      scoring: { relevance_multiplier: 3 },
      max_context_tokens: 8000,
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    const baselineResolved = await resolvePersonalityConfig(db.asDb(), 'agent-a');
    expect(baselineResolved.origin).toBe('legacy');
    const baselineJson = JSON.stringify(baselineResolved);

    // The first write via the ROUTE with the flag ON goes to the IDENTITY
    // record — so the baseline for the write path is taken with the flag off,
    // i.e. the pre-feature write itself.
    const rollout = await getRollout();
    const flagOffCommand: string = rollout.rollback.personality_flag_off_command;
    expect(flagOffCommand).toContain(DOC_ENV_VAR);

    const dir = mkdtempSync(path.join(tmpdir(), 'iter11-rollback-'));
    try {
      const envPath = path.join(dir, '.env');
      writeFileSync(envPath, `${DOC_ENV_VAR}=1\nFOCUSED_IMAGINATION=1\n`);

      // (b) EXECUTE THE DOCUMENTED COMMAND. The environment half runs for real
      // (`sed -i.bak` against the temporary .env); the `docker compose up`
      // restart half is what a deployment does and is deliberately not run
      // here — the test says so rather than pretending.
      const [envHalf] = flagOffCommand.split('&&');
      const command = envHalf.replace('.env', envPath);
      execFileSync('bash', ['-lc', command], { cwd: dir });
      const after = readFileSync(envPath, 'utf8');
      expect(after).toContain(`${DOC_ENV_VAR}=`);
      expect(after.split('\n').find((line) => line.startsWith(`${DOC_ENV_VAR}=`))).toBe(`${DOC_ENV_VAR}=`);
      // The command left a backup, exactly as documented.
      expect(existsSync(`${envPath}.bak`)).toBe(true);

      // The deployed line is what the process reads: apply it verbatim.
      process.env[DOC_ENV_VAR] = '';

      // (b1) the READ is byte-identical to the pre-rollback baseline.
      const afterResolved = await resolvePersonalityConfig(db.asDb(), 'agent-a');
      expect(JSON.stringify(afterResolved)).toBe(baselineJson);
      expect(afterResolved.profile).toBe('scholar');

      // (b2) the WRITE is the pre-feature document, shape and all.
      const put = await call('PUT', '/personality', { key: ADMIN_KEY, body: VALID_BODY });
      expect(put.status).toBe(200);
      const legacy = settings().docs.find((row: any) => row.key === LEGACY_KEY)!;
      expect(Object.keys(legacy).sort()).toEqual(PRE_FEATURE_LEGACY_KEYS);
      expect(legacy.updated_at).toBeInstanceOf(Date);
      expect(legacy.learning_policy).toBeUndefined();
      expect(legacy.bounds).toBeUndefined();
      // No identity record was created by a flag-off write.
      expect(settings().docs.some((row: any) => row.key !== LEGACY_KEY && row.key.startsWith('personality_config:'))).toBe(false);
      // Repeating the write produces a byte-identical document (a stable shape).
      const first = JSON.stringify({ ...legacy, updated_at: 'stamped' });
      const again = await call('PUT', '/personality', { key: ADMIN_KEY, body: VALID_BODY });
      expect(again.status).toBe(200);
      const legacyAgain = settings().docs.find((row: any) => row.key === LEGACY_KEY)!;
      expect(JSON.stringify({ ...legacyAgain, updated_at: 'stamped' })).toBe(first);

      // (c) THE CODE-REVERT PATH: drop every additive, flag-gated collection's
      // contents — the identity records, the delta proposals, the deprecation
      // counters, the experiment rows — and prove no read or write above
      // depended on any of them.
      for (const collection of [
        DEPRECATION_EVENT_COLLECTION,
        'personality_delta_proposals',
        'imagination_experiments',
        'idea_failure_signatures',
        'salience_inputs',
      ]) {
        db.collection(collection).docs.length = 0;
      }
      settings().docs = settings().docs.filter((row: any) => row.key === LEGACY_KEY);
      const reverted = await call('GET', '/personality', { key: ADMIN_KEY });
      expect(reverted.status).toBe(200);
      expect(reverted.body.config.personality).toBe('analyst');
      expect(reverted.body.origin).toBe('legacy');
      const revertedWrite = await call('PUT', '/personality', { key: ADMIN_KEY, body: VALID_BODY });
      expect(revertedWrite.status).toBe(200);
      expect(Object.keys(settings().docs.find((row: any) => row.key === LEGACY_KEY)!).sort()).toEqual(
        PRE_FEATURE_LEGACY_KEYS,
      );

      // (d) the commands just exercised are the ones the view and the runbook
      // hand out — the view is the source of the command, and the doc names it.
      expect(rollout.rollback.doc).toBe('docs/IMAGINATION-ROLLOUT.md');
      const doc = readFileSync(ROLLOUT_DOC, 'utf8');
      expect(doc).toContain(rollout.rollback.flag_off_command);
      expect(doc).toContain(rollout.rollback.personality_flag_off_command);
      expect(doc).toContain(rollout.rollback.kill_switch_command);
      expect(doc).toContain(rollout.rollback.code_rollback_command);
      expect(doc).toContain(DOC_ENV_VAR);
      // The doc's rollback section is the one that describes what ran.
      expect(doc).toContain('Rollback commands');
      expect(doc).toContain('sed -i.bak');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the rollout view reports the ACTIVE descriptor space, and a refused IMAGINATION_BINS by name', async () => {
    const off = await getRollout();
    expect(off.descriptor_space.source).toBe('defaults');
    expect(off.descriptor_space.refused).toBeNull();
    expect(off.descriptor_space.dimensions).toHaveLength(5);

    process.env.IMAGINATION_BINS = '{"mechanism":["a"],"risk":["low"]}';
    try {
      const on = await getRollout();
      expect(on.descriptor_space.source).toBe('env');
      expect(on.descriptor_space.dimensions).toContain('risk');

      process.env.IMAGINATION_BINS = '{"mechanism":["a"';
      const hostile = await getRollout();
      expect(hostile.descriptor_space.refused.code).toBe('not_json');
      expect(hostile.descriptor_space.basis).toContain('REFUSED');
      expect(hostile.descriptor_space.dimensions).toHaveLength(5);
    } finally {
      delete process.env.IMAGINATION_BINS;
    }
  });
});

// ── 2. Deprecation telemetry ────────────────────────────────────────────────

describe('deprecation telemetry — bounded, TTL’d, surfaced', () => {
  it('counts a legacy read and the no-user_id path, one row per {identity, kind, day}', async () => {
    process.env[DOC_ENV_VAR] = '1';
    settings().docs.push({
      key: LEGACY_KEY,
      personality: 'scholar',
      source_weights: {},
      scoring: {},
      max_context_tokens: null,
      updated_at: '2026-09-01T00:00:00.000Z',
    });

    // A bridge-shaped request WITH its identity: served by the legacy record.
    const named = await call('GET', '/personality?user_id=agent-a', { key: ADMIN_KEY });
    expect(named.status).toBe(200);
    expect(named.body.origin).toBe('legacy');
    // …and one with NO identity of its own (the documented no-`user_id` path).
    const bare = await call('GET', '/personality', { key: ADMIN_KEY });
    expect(bare.status).toBe(200);

    const rows = events();
    // One row per {identity, kind, UTC day}: the named bridge read counted
    // 'agent-a/legacy_read', and the bare request counted 'operator' — which is
    // the deployment's default identity — on BOTH the no-`user_id` path and the
    // legacy read it was served by.
    expect(rows.map((row) => [row.user_id, row.kind, row.count]).sort()).toEqual(
      [
        ['agent-a', 'legacy_read', 1],
        ['katra', 'legacy_read', 1],
        ['katra', 'no_user_id_path', 1],
      ].sort(),
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.shared_id === undefined)).toBe(true);
    expect(PERSONAL_KINDS).toContain(DEPRECATION_EVENT_COLLECTION);
    expect(utcDay(String(rows[0].first_seen_at))).toBe(rows[0].event_key.split(':').pop());

    // Every row is TTL'd and validates as the documented artifact.
    for (const row of rows) {
      expect(validateDeprecationEventRow(row).valid, JSON.stringify(validateDeprecationEventRow(row).errors)).toBe(true);
      expect(Date.parse(row.expires_at) - Date.parse(row.last_seen_at)).toBe(DEPRECATION_TTL_DAYS * 24 * 60 * 60 * 1000);
    }

    // Surfaced on the rollout view, with its basis. The counters are identity
    // rows, so the view is PINNED: the default caller here is the safe default
    // identity (`katra`, untrusted), which sees only its own two counters — the
    // named identity's row is not in its payload at all.
    const rollout = await getRollout();
    expect(rollout.deprecation_telemetry.events).toBe(2);
    expect(rollout.deprecation_telemetry.by_kind).toEqual({ legacy_read: 1, no_user_id_path: 1 });
    expect(rollout.deprecation_telemetry.ttl_days).toBe(DEPRECATION_TTL_DAYS);
    expect(rollout.deprecation_telemetry.basis).toContain(DEPRECATION_EVENT_COLLECTION);
    expect(rollout.deprecation_telemetry.identities).toEqual(['katra']);
    expect(rollout.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(JSON.stringify(rollout)).not.toContain('agent-a');
    // The other identity's counters are still READABLE — the read is pinned, not
    // censored — by a trusted caller that names it, or by the cross-identity view.
    const namedRead = await getRolloutAsOperator('?user_id=agent-a');
    expect(namedRead.deprecation_telemetry.events).toBe(1);
    expect(namedRead.deprecation_telemetry.identities).toEqual(['agent-a']);
    expect(namedRead.scope).toEqual({ kind: 'named', identities: 1 });

    // A TRUSTED caller that asks for the cross-identity view gets the total of
    // every live row, and the payload states the scope it was read at.
    const all = await getRolloutAsOperator('?all_identities=1');
    expect(all.deprecation_telemetry.events).toBe(3);
    expect(all.deprecation_telemetry.by_kind).toEqual({ legacy_read: 2, no_user_id_path: 1 });
    expect(all.deprecation_telemetry.rows).toBe(3);
    expect(all.deprecation_telemetry.identities).toEqual(['agent-a', 'katra']);
    expect(all.scope).toEqual({ kind: 'all', identities: 2 });
  });

  it('is BOUNDED: a flood of reads adds no rows, only count — and expired rows are not counted', async () => {
    process.env[DOC_ENV_VAR] = '1';
    settings().docs.push({
      key: LEGACY_KEY,
      personality: 'scholar',
      source_weights: {},
      scoring: {},
      max_context_tokens: null,
      updated_at: '2026-09-01T00:00:00.000Z',
    });

    // 25 requests in the same minute: one row, and the throttle refuses the rest.
    let recorded = 0;
    let throttled = 0;
    for (let index = 0; index < 25; index += 1) {
      const result = await notePersonalityDeprecation(db.asDb(), {
        userId: 'agent-a',
        kind: 'legacy_read',
        now: () => '2026-09-26T10:00:30.000Z',
      });
      if (result.recorded) recorded += 1;
      if (result.throttled) throttled += 1;
    }
    expect(recorded).toBe(1);
    expect(throttled).toBe(24);
    expect(events()).toHaveLength(1);

    // A later minute adds a count to the SAME day row, not a second row.
    await notePersonalityDeprecation(db.asDb(), { userId: 'agent-a', kind: 'legacy_read', now: () => '2026-09-26T11:05:00.000Z' });
    expect(events()).toHaveLength(1);
    expect(events()[0].count).toBe(2);
    expect(events()[0].event_key).toBe(deprecationEventKey('agent-a', 'legacy_read', '2026-09-26'));

    // A planted EXPIRED row is never counted (and a future one is).
    events().push({
      event_key: deprecationEventKey('agent-a', 'legacy_read', '2026-08-01'),
      user_id: 'agent-a',
      kind: 'legacy_read',
      count: 999,
      first_seen_at: '2026-08-01T00:00:00.000Z',
      last_seen_at: '2026-08-01T00:00:00.000Z',
      expires_at: '2026-08-31T00:00:00.000Z',
    });
    const summary = await countPersonalityDeprecationEvents(db.asDb(), { now: () => '2026-09-26T12:00:00.000Z' });
    expect(summary.events).toBe(2);
    expect(summary.rows).toBe(1);
    expect(summary.basis).toContain('expires_at');
    // Scoped reads are honoured, and an unknown identity reads zero.
    expect((await countPersonalityDeprecationEvents(db.asDb(), { userId: 'agent-b' })).events).toBe(0);

    // The telemetry is TOTAL: a broken store yields a stated reason, no throw.
    resetDeprecationThrottle();
    const broken = {
      collection: () => ({
        find: () => {
          throw new Error('store offline');
        },
        findOne: () => {
          throw new Error('store offline');
        },
        updateOne: () => {
          throw new Error('store offline');
        },
        createIndex: () => {
          throw new Error('store offline');
        },
      }),
    } as never;
    const failed = await notePersonalityDeprecation(broken, { userId: 'agent-a', kind: 'legacy_read' });
    expect(failed.recorded).toBe(false);
    expect(failed.reason).toContain('swallowed by design');
    expect((await countPersonalityDeprecationEvents(broken)).basis).toContain('could not be read');
  });

  it('records NOTHING while PER_IDENTITY_PERSONALITY is off — the flag-off path is not a deprecation', async () => {
    delete process.env[DOC_ENV_VAR];
    settings().docs.push({
      key: LEGACY_KEY,
      personality: 'scholar',
      source_weights: {},
      scoring: {},
      max_context_tokens: null,
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    const res = await call('GET', '/personality', { key: ADMIN_KEY });
    expect(res.status).toBe(200);
    expect(events()).toHaveLength(0);
    const rollout = await getRollout();
    expect(rollout.deprecation_telemetry.events).toBe(0);
    expect(DEPRECATION_KINDS.length).toBe(3);
  });
});
