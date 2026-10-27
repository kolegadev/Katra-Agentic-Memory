/**
 * ITER-9 — the two MCP tools of the observability layer.
 * Contract: CONTRACT-iter9-observability.md §E.
 *
 * Three layers, matching the repo's convention for flag-gated tools:
 *   1. registration — the real tools array is inspected after loading
 *      mcp-server.ts per flag state (the flag is read at module load);
 *   2. dispatch-time re-check — with the flag off BOTH tools throw the plain
 *      `Unknown tool` error and touch nothing;
 *   3. caller pinning and the gate — the metrics read is pinned to the caller,
 *      the observation write is trusted-only, idempotent per
 *      {experiment, arm, metric, checkpoint}, and neither accepts a user_id
 *      that could aim it at another identity.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const holder = vi.hoisted(() => ({ db: null as any }));

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => holder.db,
  is_database_connected: () => holder.db !== null,
  connect_to_mongodb: async () => {},
  close_connection: async () => {},
}));

vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
  is_redis_healthy: async () => false,
  close_redis_connection: async () => {},
  get_redis_status: () => ({ connected: false }),
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import { runWithCaller } from '../../src/utils/caller-identity.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';
import {
  IMAGINATION_OBSERVABILITY_TOOL_DEFS,
  dispatchImaginationObservabilityTool,
  resolveMetricsUserId,
} from '../../src/services/processing/imagination-observability-tools.js';
import { registerExperiment } from '../../src/services/processing/imagination-experiments.js';

const OWNER = 'agent-a';
const TRUSTED: CallerIdentity = { user_id: OWNER, trusted: true };
const UNTRUSTED: CallerIdentity = { user_id: OWNER, trusted: false };
const OPERATOR: CallerIdentity = { user_id: 'operator', trusted: true };

let db: FakeDb;

/** Load mcp-server.ts under a flag state and return the registered names. */
async function registeredNames(env: Record<string, string | undefined>): Promise<string[]> {
  vi.resetModules();
  for (const key of ['PER_IDENTITY_PERSONALITY', 'FOCUSED_IMAGINATION', 'CREATIVE_BATON_PROMOTION', 'COGNITIVE_TEAM_ALLOCATION']) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  const mod = await import('../../src/mcp-server.js');
  return mod.registeredToolNames();
}

async function call(name: string, args: unknown, caller: CallerIdentity): Promise<string> {
  const result = await runWithCaller(caller, () => dispatchImaginationObservabilityTool(name, args, caller));
  return result.map((row) => row.text).join('\n');
}

function seedMetricRows(): void {
  db.collection('imagination_cycles').docs.push({
    cycle_id: 'cyc_tool',
    user_id: OWNER,
    mission_id: 'm_tool',
    mission_version: 1,
    trigger: 'plateau',
    status: 'completed',
    stop_reason: 'completed',
    stop_conditions: [],
    plateau: [],
    counts: { seeds_generated: 2, seeds_admitted: 2, seeds_below_incumbent: 0, seeds_rejected: 0, candidates_considered: 2, candidates_eligible: 2, new_cells: 2, cells_total: 2 },
    budget: { tokens_spent_this_cycle: 500 },
    created_at: new Date().toISOString(),
  });
  for (let index = 0; index < 5; index += 1) {
    db.collection('idea_candidate_outcomes').docs.push({
      outcome_id: `o${index}`,
      user_id: OWNER,
      mission_id: 'm_tool',
      seed_id: `seed_tool_${index}`,
      outcome: index < 3 ? 'useful_information' : 'mere_variance',
      recorded_at: new Date().toISOString(),
    });
  }
}

beforeEach(() => {
  db = new FakeDb();
  holder.db = db;
  process.env.FOCUSED_IMAGINATION = '1';
});

afterEach(() => {
  delete process.env.FOCUSED_IMAGINATION;
  delete process.env.CREATIVE_BATON_PROMOTION;
  delete process.env.COGNITIVE_TEAM_ALLOCATION;
});

describe('get_imagination_metrics', () => {
  it('is registered only with FOCUSED_IMAGINATION on', async () => {
    const off = await registeredNames({});
    const on = await registeredNames({ FOCUSED_IMAGINATION: '1' });
    expect(off).not.toContain('get_imagination_metrics');
    expect(off).not.toContain('record_experiment_observation');
    expect(on).toContain('get_imagination_metrics');
    expect(on).toContain('record_experiment_observation');
    expect(on.filter((name) => IMAGINATION_OBSERVABILITY_TOOL_DEFS.some((tool) => tool.name === name))).toHaveLength(2);
    process.env.FOCUSED_IMAGINATION = '1';
  });

  it('reports every metric with its basis, and insufficient_data rather than a rate', async () => {
    const empty = await call('get_imagination_metrics', { mission_id: 'm_tool' }, TRUSTED);
    expect(empty).toContain('## Imagination metrics');
    expect(empty).toContain('INSUFFICIENT DATA');
    // The audit lines are always present, with the rows they scanned.
    expect(empty).toContain('Privacy leakage (audit)');
    expect(empty).toContain('Personality stability');
    expect(empty).toContain('**Bases**');

    seedMetricRows();
    const text = await call('get_imagination_metrics', { mission_id: 'm_tool' }, TRUSTED);
    // Three of five outcomes are useful; the basis states the window, the n and
    // the minimum beside the number.
    expect(text).toContain('"rate":0.6');
    expect(text).toContain('"useful_outcomes":3');
    expect(text).toContain('n=5');
    expect(text).toContain('minimum 5');
    expect(text).toContain('idea_candidate_outcomes');
    expect(text).toContain('Read-only: no cycle ran');
  });

  it('pins an untrusted caller to its own identity', async () => {
    seedMetricRows();
    expect(resolveMetricsUserId(UNTRUSTED, 'somebody-else')).toBe(OWNER);
    expect(resolveMetricsUserId(TRUSTED, 'somebody-else')).toBe('somebody-else');
    const text = await call('get_imagination_metrics', { user_id: 'somebody-else' }, UNTRUSTED);
    expect(text).toContain(`identity \`${OWNER}\``);
    expect(text).not.toContain('somebody-else');
  });

  it('with the flag off the dispatch re-check throws Unknown tool and reads nothing', async () => {
    delete process.env.FOCUSED_IMAGINATION;
    await expect(
      runWithCaller(TRUSTED, () => dispatchImaginationObservabilityTool('get_imagination_metrics', {}, TRUSTED)),
    ).rejects.toThrow('Unknown tool: get_imagination_metrics');
    await expect(
      runWithCaller(TRUSTED, () => dispatchImaginationObservabilityTool('record_experiment_observation', {}, TRUSTED)),
    ).rejects.toThrow('Unknown tool: record_experiment_observation');
  });
});

describe('record_experiment_observation', () => {
  const REGISTER = {
    name: 'Useful novelty',
    hypothesis: 'The treatment improves useful novelty.',
    checkpoints: ['cycle-1'],
    arms: [{ label: 'control', config: {} }, { label: 'treatment', config: {} }],
  };

  it('registers on first write, then is idempotent per key', async () => {
    const first = await call('record_experiment_observation', { register: REGISTER, arm: 'control', metric: 'useful_novelty_rate', value: 0.4, n: 10 }, TRUSTED);
    expect(first).toContain('Observation recorded');
    expect(first).toContain('idempotent per {experiment, arm, metric, checkpoint}');

    const repeat = await call('record_experiment_observation', { register: REGISTER, arm: 'control', metric: 'useful_novelty_rate', value: 0.4, n: 10 }, TRUSTED);
    expect(repeat).toContain('Unchanged');

    const rows = db.collection('imagination_experiments').docs.filter((row: any) => row.kind === 'observation');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(OWNER);
  });

  it('refuses an untrusted caller, an unknown key and an unknown experiment', async () => {
    const { experiment } = await registerExperiment(db.asDb(), {
      userId: OWNER,
      name: 'Gate probe',
      hypothesis: 'the gate holds',
      checkpoints: ['cycle-1'],
      arms: [{ label: 'control', config: {} }],
    });

    const untrusted = await call('record_experiment_observation', { experiment_id: experiment.experiment_id, arm: 'control', metric: 'm', value: 1, n: 1 }, UNTRUSTED);
    expect(untrusted).toContain('requires a trusted caller');

    const unknown = await call('record_experiment_observation', { experiment_id: 'impexp_nope', arm: 'control', metric: 'm', value: 1, n: 1 }, TRUSTED);
    expect(unknown).toContain('no experiment');

    // The tool's schema is CLOSED: an extra key is refused before dispatch.
    const extra = await call('record_experiment_observation', { experiment_id: experiment.experiment_id, arm: 'control', metric: 'm', value: 1, n: 1, user_id: 'somebody-else' }, TRUSTED);
    expect(extra).toContain('Invalid arguments');

    expect(db.collection('imagination_experiments').docs.filter((row: any) => row.kind === 'observation')).toHaveLength(0);
  });
});
