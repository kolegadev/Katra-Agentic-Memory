/**
 * ITER-11 — THE FULL LOOP, END TO END, AS ONE BOUNDED LIVE INSTRUMENT.
 *
 * `server/tests/live/imagination-baseline-live.test.ts` is the A/B instrument:
 * four arms on FOUR throwaway missions it seeds itself, judged blind, to answer
 * "is the focused engine ≥30% better than the pre-engine path". This file
 * answers a different question, and it is the one the A/B run cannot answer:
 *
 *   does the WHOLE loop work, in order, ON A REAL PARKED MISSION, with the real
 *   model — consolidation → plateau → cycle → verification → baton → promotion
 *   → controller adapter → outcome → resume?
 *
 * The mission is NOT seeded here. It is a real, pre-existing mission of the live
 * store (the caller names it in `IMAGINATION_LOOP_MISSION`): its ledger, its
 * deltas, its events and its history are the store's own. This run is the
 * engine's FIRST cycle on it, and the instrument walks every stage the loop
 * claims to have, recording each stage's own numbers, the rows it wrote and the
 * stores it read.
 *
 * ── IT RUNS NOTHING UNLESS ASKED ───────────────────────────────────────────
 *
 * With `IMAGINATION_LOOP_LIVE` unset (or not `1`) the whole file skips and says
 * why in the run output. Importing this file in a normal test run therefore
 * opens no connection and spends no token:
 *
 *   npx vitest run tests/live/imagination-loop-live.test.ts     # → skipped
 *
 * ── WHAT IT IS, STATEMENT BY STATEMENT ─────────────────────────────────────
 *
 * NO MOCKS. There is no FakeDb and no `vi.mock` of `src/database/connection.js`
 * or of `llmService`: the driver calls the REAL `connect_to_mongodb()` and the
 * REAL `llmService`, and it refuses to start if the model is not available
 * (naming the status it saw). Every row it writes goes into the deployment's own
 * collections, in the mission's own scope.
 *
 * THE FLAGS LIVE IN THIS PROCESS ONLY. `FOCUSED_IMAGINATION` and
 * `CREATIVE_BATON_PROMOTION` are set here, in this file's module body, BEFORE
 * the services are imported (every `src` import below is a dynamic
 * `await import()` inside the test, so nothing loads before the flags are set).
 * The deployment runs with all four flags OFF — the instrument is what turns
 * them on, for one process, and the capture's disclosure says so in those words.
 *
 * THE RUN IS REGISTERED BY A FRESH TOKEN. `IMAGINATION_LOOP_RUN` is REQUIRED and
 * is recorded in the capture: it is the handle a person uses to find this run's
 * rows afterwards. The mission itself is NOT namespaced (it is real, and it is
 * the subject) — so this instrument must not be pointed at a mission whose
 * history you are unwilling to extend. Nothing is deleted: the capture carries a
 * `written` summary (collection → count, with the FILTER each count used) so the
 * rows this run added can be reviewed, and removed later, deliberately, by a
 * person.
 *
 * THE CEILINGS COME FROM THE DEPLOYMENT'S ENV. The engine's knobs (the
 * `FOCUSED_*` ceilings and the `IMAGINATION_CYCLE_*` window budget) are READ
 * here, never set: the deployment's `.env` supplies them (the runner refuses a
 * run whose ceilings are missing), and the capture records both the raw values
 * this process saw and the EFFECTIVE values the services' own accessors resolved
 * them to — so an unrecorded override cannot produce an unreproducible run. A
 * ceiling that is unset is named as unset, because the documented defaults
 * truncate a reasoning model and that is a rollout finding, not a neutral fact.
 *
 * THE JUDGE IS BLIND, AND ITS BLINDNESS IS DISCLOSED. Stage 4 reuses the A/B
 * instrument's judge (`server/tests/helpers/imagination-blind-judge.ts`): the
 * cases are the payloads `blindCases` builds (five fields, opaque ids, seeded
 * shuffle), the question is the frozen `JUDGE_SYSTEM_PROMPT`, and the reply is
 * parsed by `parseJudgeReply`, which refuses by name rather than coercing. The
 * prompt's sha256, the shuffle seed, every raw reply and every call's token
 * usage are in the capture. The residual risk — a model judging model-written
 * text — is a property of the instrument and is disclosed, not hidden.
 *
 * IT IS BOUNDED. At most `MAX_JUDGED_CANDIDATES` candidates are judged (the
 * driver counts them BEFORE the first judge call and refuses by name above the
 * bound), the judge's calls are batched, and EVERY gate refusal is reported
 * VERBATIM: the gate is what normally bounds the engine to one cycle per
 * plateau, so the instrument never silently forces past it. `RunCycleArgs.force`
 * is used ONLY when the real gate refuses for a plateau/cooldown/window reason
 * AND `IMAGINATION_LOOP_FORCE=1`, and the capture then says the gate was
 * bypassed by an explicit override. Without that flag a gated run FAILS LOUDLY
 * and names the reason, rather than pretending the loop completed.
 *
 * ── HOW TO RUN IT (on the deployment host; the ceilings come from .env) ────
 *
 *   cd server
 *   export IMAGINATION_LOOP_LIVE=1 \
 *          IMAGINATION_LOOP_USER=<identity, e.g. agent-b> \
 *          IMAGINATION_LOOP_MISSION=<mission id> \
 *          IMAGINATION_LOOP_RUN=loop-$(date -u +%Y%m%d-%H%M%S) \
 *          IMAGINATION_LOOP_OUT=/tmp/imagination-loop-live.json
 *   # optional: IMAGINATION_LOOP_CYCLE=<label>  IMAGINATION_LOOP_FORCE=0|1
 *   npx vitest run tests/live/imagination-loop-live.test.ts
 *
 * THE CAPTURE IS AN OPERATIONAL ARTEFACT, NOT REPO CONTENT: it carries the run's
 * host name, the model id, the store's database name and the mission's own ids.
 * Write it outside the repository.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

import type { Db } from 'mongodb';

import type { IdeaSeed } from '../../src/services/processing/idea-archive-service.js';
import type { CandidateOutcome } from '../../src/services/processing/imagination-outcome-service.js';
import type { CreativeBaton } from '../../src/services/processing/creative-baton-compiler.js';
import {
  DEFAULT_SHUFFLE_SEED,
  JUDGE_BATCH_SIZE,
  JUDGE_SYSTEM_PROMPT,
  blindCases,
  judgePrompt,
  judgePromptSha256,
  parseJudgeReply,
  type BlindCase,
  type CaseMapping,
  type JudgeCandidateInput,
  type JudgeParseResult,
} from '../helpers/imagination-blind-judge.js';

/** The instrument, as the capture names it. */
const DRIVER = 'server/tests/live/imagination-loop-live.test.ts (the imagination-loop live instrument)';

/** The capture's schema version (this file's shape, not the engine's). */
export const LOOP_VERSION = '1.0';

const LIVE = process.env.IMAGINATION_LOOP_LIVE === '1';

// ── The flags, IN THIS PROCESS ONLY, before any service is imported ────────
//
// The module body runs before the test's dynamic imports, so the services first
// see these values already set. They are what the DEPLOYMENT does not have: the
// rollout runs with the flags off, and this instrument is the only thing that
// turns them on (for one process, for the length of one run).
if (LIVE) {
  process.env.FOCUSED_IMAGINATION = '1';
  process.env.CREATIVE_BATON_PROMOTION = '1';
}

const SKIP_REASON =
  'IMAGINATION_LOOP_LIVE is not set to 1 — this file is the LIVE instrument (real MongoDB, real model, real ' +
  'pre-existing mission, flags turned on in-process); it is skipped so that a normal test run neither connects to a ' +
  'store nor spends a token. See the file header for the command line.';

if (!LIVE) console.log(`[imagination-loop-live] SKIPPED: ${SKIP_REASON}`);

type Row = Record<string, any>;

// ── The configuration guard ────────────────────────────────────────────────
//
// EVERY name here is deployment data, so a missing identity, mission, run token
// or output path is a NAMED refusal — this instrument never defaults one (a
// default identity would write under the wrong owner, a default mission would
// run the loop against the wrong mission, a default path would overwrite
// whatever is there). The guard runs BEFORE the store is touched: a run with no
// configuration must fail naming the variable, not connect anywhere.

export interface LoopConfig {
  /** The identity to run as (the mission's owner). */
  user: string;
  /** The REAL, pre-existing mission this run walks the loop on. */
  mission: string;
  /** The run token: a fresh handle for this run's rows (recorded, never defaulted). */
  run: string;
  /** Where the capture is written. */
  out: string;
  /** The cycle label this run's stage-2 focused consolidation is keyed by. */
  cycle: string;
  /** Whether an explicit `force: true` may bypass the PLATEAU gate. */
  force: boolean;
}

export type LoopConfigResult = { ok: true; config: LoopConfig } | { ok: false; reason: string };

/**
 * Read the run's configuration from the environment.
 *
 * `IMAGINATION_LOOP_USER`, `IMAGINATION_LOOP_MISSION`, `IMAGINATION_LOOP_RUN`
 * and `IMAGINATION_LOOP_OUT` are REQUIRED. `IMAGINATION_LOOP_CYCLE` defaults to a
 * label derived from the run token (it names stage 2's focused-consolidation
 * run; the cycle's own id is the engine's derived one — see stage 3).
 * `IMAGINATION_LOOP_FORCE` defaults to `0` (the gate is NOT bypassed) and any
 * other value than `0`/`1` is refused by name rather than coerced.
 */
export function loopConfigFromEnv(env: Record<string, string | undefined>): LoopConfigResult {
  const text = (name: string): string | null => {
    const value = String(env[name] ?? '').trim();
    return value.length > 0 ? value : null;
  };
  const required: Array<[string, string | null]> = [
    ['IMAGINATION_LOOP_USER', text('IMAGINATION_LOOP_USER')],
    ['IMAGINATION_LOOP_MISSION', text('IMAGINATION_LOOP_MISSION')],
    ['IMAGINATION_LOOP_RUN', text('IMAGINATION_LOOP_RUN')],
    ['IMAGINATION_LOOP_OUT', text('IMAGINATION_LOOP_OUT')],
  ];
  const missing = required.filter(([, value]) => value === null).map(([name]) => name);
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `the imagination-loop live run is REFUSED: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} ` +
        'unset — this instrument never defaults an identity, a mission, a run token or an output path (they are ' +
        'deployment data, and a default would silently run the loop against the wrong mission, as the wrong owner, ' +
        'or over the wrong file). Nothing was connected and nothing was read.',
    };
  }
  const user = required[0][1]!;
  const mission = required[1][1]!;
  const run = required[2][1]!;
  const out = required[3][1]!;

  // The run token is a handle a person will use to find this run's rows: it has
  // to be an id, not prose.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(run)) {
    return {
      ok: false,
      reason:
        `the imagination-loop live run is REFUSED: IMAGINATION_LOOP_RUN '${run}' is not a run token — it must match ` +
        '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ because it is the handle this run\'s rows are reported under',
    };
  }

  const rawForce = String(env.IMAGINATION_LOOP_FORCE ?? '0').trim() || '0';
  if (rawForce !== '0' && rawForce !== '1') {
    return {
      ok: false,
      reason:
        `the imagination-loop live run is REFUSED: IMAGINATION_LOOP_FORCE '${rawForce}' is not 0 or 1 — the forced ` +
        'path bypasses the PLATEAU gate, so it is switched on explicitly or not at all (never coerced from prose)',
    };
  }

  return {
    ok: true,
    config: {
      user,
      mission,
      run,
      out,
      cycle: text('IMAGINATION_LOOP_CYCLE') ?? `imagination_loop:${run}`,
      force: rawForce === '1',
    },
  };
}

// ── The stores and the knobs this run reads ────────────────────────────────

/** The mission-scoped collections stage 1 counts, and stage 9's `written` view. */
const BEFORE_COLLECTIONS: Record<string, string> = {
  epistemic_entries: 'epistemic_entries',
  state_deltas: 'state_deltas',
  cognitive_work_items: 'cognitive_work_items',
  salience_traces: 'salience_traces',
  focused_consolidation_runs: 'focused_consolidation_runs',
  imagination_cycles: 'imagination_cycles',
  idea_seeds: 'idea_seeds',
  idea_archive_cells: 'idea_archive_cells',
  creative_batons: 'creative_batons',
  creative_baton_promotions: 'creative_baton_promotions',
  idea_candidate_outcomes: 'idea_candidate_outcomes',
};

/**
 * The engine's knobs, with the defaults its accessors document. Read, never
 * written: the deployment's `.env` is the source of the ceilings (the runner
 * refuses a run whose ceilings are missing). The same eleven names the A/B
 * instrument records — kept as a local table on purpose, so this file's capture
 * can be read without the other instrument's source.
 */
const CEILING_DEFAULTS: Record<string, string> = {
  FOCUSED_CONSOLIDATION_MAX_TOKENS: '2000',
  FOCUSED_CONSOLIDATION_TIMEOUT_MS: '60000',
  FOCUSED_IMAGINATION_MAX_TOKENS: '3000',
  FOCUSED_IMAGINATION_TIMEOUT_MS: '60000',
  FOCUSED_IMAGINATION_MAX_LLM_CALLS: '3',
  FOCUSED_IMAGINATION_MAX_SEEDS: '8',
  FOCUSED_IMAGINATION_MAX_OPERATORS: '6',
  IMAGINATION_CYCLE_COOLDOWN_MS: '900000',
  IMAGINATION_CYCLE_MAX_PER_WINDOW: '3',
  IMAGINATION_CYCLE_MAX_TOKENS_PER_WINDOW: '20000',
  IMAGINATION_MAX_CONCURRENT_CYCLES: '2',
};

/** The driven bound on the judged set (the driver refuses above it, by name). */
export const MAX_JUDGED_CANDIDATES = 30;

/** The gate reasons a plateau/cooldown/window refusal can carry (stage 3). */
const PLAN_GATE_REFUSALS = ['no_plateau', 'cooldown', 'budget_cycles', 'budget_tokens'];

/** The max_tokens one judge batch asks for: the shape plus reasoning headroom. */
function judgeMaxTokens(cases: number): number {
  const override = Number(process.env.IMAGINATION_LOOP_JUDGE_MAX_TOKENS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  // The estate's canonical model is a REASONING model: it spends output tokens
  // on its own reasoning before the JSON, so a ceiling sized for the JSON alone
  // truncates the batch (observed live by the A/B instrument). Per case and
  // generous, capped at the provider's accepted maximum.
  return Math.min(16000, 3000 + 1000 * cases);
}

function messageOf(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Wait (bounded) for the real provider to finish its own availability probe. */
async function waitForModel(
  llmService: { getServiceStatus(): { available: boolean; provider: string; model: string; providers: string[] } },
  timeoutMs: number,
): Promise<{ available: boolean; provider: string; model: string; providers: string[]; waited_ms: number }> {
  const startedMs = Date.now();
  let status = llmService.getServiceStatus();
  while (!status.available && Date.now() - startedMs < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    status = llmService.getServiceStatus();
  }
  return { ...status, waited_ms: Date.now() - startedMs };
}

describe.skipIf(!LIVE)('imagination loop — the full loop, end to end, on a REAL mission (LIVE)', () => {
  it(
    'walks consolidation → plateau → cycle → verification → baton → promotion → adapter → outcome → resume',
    { timeout: 30 * 60 * 1000 },
    async () => {
      // ── the configuration guard, BEFORE anything is connected ──────────
      const configResult = loopConfigFromEnv(process.env);
      if (!configResult.ok) throw new Error(configResult.reason);
      const config = configResult.config;
      const user = config.user;
      const missionId = config.mission;
      const run = config.run;
      const cycleLabel = config.cycle;
      const caller = { user_id: user, trusted: true };
      const startedAt = new Date().toISOString();

      const progressPath = `${config.out}.progress.log`;
      const pipeline: Array<{ step: string; at: string; detail?: string }> = [];
      const mark = (step: string, detail?: string): void => {
        const entry = { step, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
        pipeline.push(entry);
        const line = `${entry.at} ${step}${detail ? ` — ${detail}` : ''}`;
        console.error(`[loop] ${line}`);
        try {
          mkdirSync(path.dirname(progressPath), { recursive: true });
          appendFileSync(progressPath, `${line}\n`);
        } catch (error) {
          console.error(`[loop] the progress file could not be appended: ${messageOf(error)}`);
        }
      };

      const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
      const check = (name: string, ok: boolean, detail: string): void => {
        checks.push({ name, ok, detail });
        mark(`check ${ok ? 'ok' : 'FAILED'}`, `${name} — ${detail}`);
      };

      // ── the services, imported AFTER the flags are set (see the header) ──
      const connection = await import('../../src/database/connection.js');
      const { llmService } = await import('../../src/services/infrastructure/llm-service.js');
      const { usageDeltaSince, usageSnapshot } = await import('../../src/services/infrastructure/llm-usage-ledger.js');
      const { runFocusedConsolidation, focusedConsolidationMaxTokens, focusedConsolidationTimeoutMs } = await import(
        '../../src/services/processing/focused-consolidation-service.js'
      );
      const { runImaginationCycle, evaluatePlateau, readCycleState, windowAt } = await import(
        '../../src/services/processing/imagination-cycle-service.js'
      );
      const {
        cycleCooldownMs,
        cycleBudgetWindowMs,
        maxCyclesPerWindow,
        maxTokensPerWindow,
        maxConcurrentCycles,
        candidateFloor,
      } = await import('../../src/services/processing/imagination-cycle-config.js');
      const { environmentBudget } = await import('../../src/services/processing/imagination-service.js');
      const { rankCheapTests, executePermittedTest } = await import(
        '../../src/services/processing/idea-verification-service.js'
      );
      const { recordCandidateOutcome, batonCandidatesToWorkItems, CANDIDATE_OUTCOMES } = await import(
        '../../src/services/processing/imagination-outcome-service.js'
      );
      const {
        CreativeBatonService,
        validateCreativeBaton,
        verifyStoredBaton,
        creativeBatonPayloadHash,
        CREATIVE_BATON_VERSION,
      } = await import('../../src/services/processing/creative-baton-compiler.js');
      const { promoteCreativeBaton } = await import('../../src/services/processing/creative-baton-promotion.js');
      const { CREATIVE_BATON_COLLECTIONS } = await import(
        '../../src/services/processing/creative-baton-collections.js'
      );
      const { FOCUSED_CONSOLIDATION_COLLECTIONS } = await import(
        '../../src/services/processing/focused-consolidation-collections.js'
      );
      const { IMAGINATION_COLLECTIONS } = await import('../../src/services/processing/imagination-collections.js');
      const { COLLECTIONS } = await import('../../src/services/mission-cognition/collections.js');
      const { MissionStateService } = await import('../../src/services/mission-cognition/mission-state-service.js');
      const { buildResumeReport } = await import('../../src/services/mission-cognition/resume.js');

      // ── the real store ─────────────────────────────────────────────────
      let db: Db | null = null;
      try {
        db = await connection.connect_to_mongodb();
        if (!db && connection.is_database_connected()) db = connection.get_database();
      } catch (error) {
        throw new Error(
          `the loop is REFUSED: the store could not be reached — ${messageOf(error)} (MONGODB_URI / DATABASE_NAME must ` +
            'name the store this instrument is allowed to write to)',
        );
      }
      if (!db) {
        throw new Error(
          'the loop is REFUSED: connect_to_mongodb() returned no database — MONGODB_URI (and DATABASE_NAME) must name ' +
            'the store this instrument is allowed to write to',
        );
      }
      if (!connection.is_database_connected()) {
        throw new Error('the loop is REFUSED: the connection reports it is not connected');
      }
      mark('store connected', `database '${db.databaseName}' on ${hostname()} (the REAL live store)`);

      // ── the real model, named and required ─────────────────────────────
      const model = await waitForModel(llmService, 120_000);
      if (!model.available) {
        throw new Error(
          'the loop is REFUSED: llmService.getServiceStatus().available is false — ' +
            `${JSON.stringify({ provider: model.provider, model: model.model, providers: model.providers, waited_ms: model.waited_ms })}. ` +
            'Every stage of this loop needs the real provider; run this in a process whose LLM configuration is applied ' +
            '(env keys or reconfigure_from_db), or fix the provider before re-running.',
        );
      }

      const countOf = async (collection: string, filter: Record<string, unknown>): Promise<number> =>
        Number(await db!.collection(collection).countDocuments(filter));
      const countMap = async (spec: Record<string, string>): Promise<Record<string, number>> =>
        Object.fromEntries(
          await Promise.all(Object.entries(spec).map(async ([key, collection]) => [key, await countOf(collection, { mission_id: missionId })])),
        );

      try {
        // ══ STAGE 1 — BEFORE: the mission as the store holds it ══════════
        const missionService = new MissionStateService(db);
        const missionState = await missionService.getMissionState(missionId);
        if (!missionState) {
          throw new Error(
            `the loop is REFUSED: mission state not found: ${missionId} — IMAGINATION_LOOP_MISSION must name a mission ` +
              'that exists in THIS store (this instrument never creates one)',
          );
        }
        const missionRow = (await db
          .collection(COLLECTIONS.missionStates)
          .findOne({ mission_id: missionId }, { projection: { _id: 0 } })) as Row | null;
        const beforeCounts = await countMap(BEFORE_COLLECTIONS);
        const stageBefore = {
          mission: {
            mission_id: String(missionState.mission_id),
            title: String(missionState.title ?? ''),
            intent_excerpt: String(missionState.intent ?? '').slice(0, 400),
            status: String(missionState.status ?? ''),
            version: Number(missionState.version),
            authority_class: String(missionState.authority_class ?? ''),
            owner_id: String(missionState.owner_id ?? ''),
            shared_id: missionRow?.shared_id ?? null,
            checkpoint_id: (missionState as Row).checkpoint_id ?? null,
            success_criteria: ((missionState as Row).success_criteria ?? []).map((criterion: Row) => ({
              id: String(criterion.id),
              description: String(criterion.description),
              status: String(criterion.status),
            })),
            constraints_count: ((missionState as Row).constraints ?? []).length,
            constraints: ((missionState as Row).constraints ?? []).map((constraint: Row) => ({
              id: String(constraint.id),
              kind: String(constraint.kind),
            })),
            objectives_count: ((missionState as Row).objectives ?? []).length,
            objectives: ((missionState as Row).objectives ?? []).map((objective: Row) => ({
              id: String(objective.id),
              status: String(objective.status),
            })),
            active_baton_ids: ((missionState as Row).active_baton_ids ?? []).map((id: unknown) => String(id)),
            updated_at: (missionState as Row).updated_at ?? null,
          },
          counts: beforeCounts,
          identity_check: {
            ran_as: user,
            mission_owner_id: String(missionState.owner_id ?? ''),
            matches_owner: String(missionState.owner_id ?? '') === user,
            note:
              'the services below are identity-scoped: a mismatch does not stop the run, it makes each service refuse ' +
              'BY NAME (each refusal is quoted verbatim in its stage rather than hidden)',
          },
          read_from: `mission_states (the stored checkpoint) + a countDocuments per collection in ${
            Object.keys(BEFORE_COLLECTIONS).length
          } collections, all filtered by mission_id '${missionId}'`,
        };
        mark(
          'stage 1 — before snapshot',
          `mission ${missionId} v${missionState.version} (${missionState.status}, authority ${missionState.authority_class}, owner ${missionState.owner_id}) — ` +
            `${beforeCounts.epistemic_entries} ledger entr(ies), ${beforeCounts.state_deltas} delta(s), ${beforeCounts.cognitive_work_items} work item(s), ` +
            `${beforeCounts.imagination_cycles} cycle(s), ${beforeCounts.idea_seeds} seed(s)`,
        );
        if (String(missionState.owner_id ?? '') !== user) {
          mark(
            'stage 1 — IDENTITY WARNING',
            `IMAGINATION_LOOP_USER '${user}' is not the mission's owner '${missionState.owner_id}': the identity-scoped ` +
              'stages will refuse by name (verbatim) rather than write under the wrong identity',
          );
        }

        // ══ STAGE 2 — FOCUSED CONSOLIDATION (the real model) ═════════════
        const focusedUsageBefore = usageSnapshot();
        const focused = await runFocusedConsolidation(db, {
          userId: user,
          missionId,
          cycleId: cycleLabel,
          actorId: user,
        });
        const focusedUsage = usageDeltaSince(focusedUsageBefore);
        if (focused.status !== 'completed') {
          throw new Error(
            `the loop is REFUSED at stage 2: runFocusedConsolidation returned '${focused.status}' ` +
              `(reused ${String(focused.reused)}) — the service's own error text: ` +
              `'${focused.error ?? '(none)'}'${focused.warning ? ` / warning: '${focused.warning}'` : ''}. ` +
              'A consolidation that did not complete is not evidence, so the run stops here rather than continuing.',
          );
        }
        const trace = focused.trace;
        const stageFocused = {
          call: `runFocusedConsolidation(db, { userId: '${user}', missionId: '${missionId}', cycleId: '${cycleLabel}', actorId: '${user}' })`,
          status: focused.status,
          reused: focused.reused,
          reused_note: focused.reused
            ? 'REUSED: the run ledger already held this {mission, cycle} run, so NO model call happened — the trace below is the stored row'
            : 'fresh: the model call of this run produced the trace below',
          run_id: focused.run_id,
          trace_id: focused.trace_id,
          cycle_id: focused.cycle_id,
          mission_version: focused.mission_version,
          problem_state_digest: focused.problem_state_digest,
          model: focused.model,
          llm_calls: focused.llm_calls,
          input_tokens: focused.input_tokens,
          output_tokens: focused.output_tokens,
          duration_ms: focused.duration_ms,
          signal_count: focused.signal_count,
          signal_counts_by_kind: trace?.calibration?.by_kind ?? focused.run?.output_counts?.by_kind ?? {},
          calibration: trace?.calibration ?? null,
          evidence: trace?.evidence
            ? {
                total_refs: trace.evidence.total_refs,
                resolved_refs: trace.evidence.resolved_refs,
                unresolved_ref_count: trace.evidence.unresolved_ref_count,
                unresolved_evidence_count: trace.evidence.unresolved_evidence_count,
                flagged_refs_count: (trace.evidence.flagged_refs ?? []).length,
                resolvable_collections: trace.evidence.resolvable_collections ?? [],
                warning: trace.evidence.warning ?? null,
              }
            : null,
          evidence_refs_count: Number(trace?.evidence?.total_refs ?? 0),
          input_counts: trace?.input_counts ?? focused.run?.input_counts ?? null,
          output_counts: focused.run?.output_counts ?? null,
          unresolved_evidence_count: focused.unresolved_evidence_count,
          unresolved_ref_count: focused.unresolved_ref_count,
          clamped_values: focused.clamped_values,
          coerced_values: focused.coerced_values,
          truncated_fields: focused.truncated_fields,
          low_confidence_count: focused.low_confidence_count,
          orphan_trace_id: focused.orphan_trace_id,
          run_ledger: focused.run
            ? {
                run_id: focused.run.run_id,
                idempotency_key: focused.run.idempotency_key,
                trigger: focused.run.trigger,
                actor_id: focused.run.actor_id,
                status: focused.run.status,
                created_at: focused.run.created_at,
                completed_at: focused.run.completed_at,
              }
            : null,
          usage: {
            input_tokens: focusedUsage.input_tokens,
            output_tokens: focusedUsage.output_tokens,
            requests: focusedUsage.requests,
            responses: focusedUsage.responses,
            failed: focusedUsage.failed,
          },
          warning: focused.warning ?? null,
          error: focused.error ?? null,
        };
        mark(
          'stage 2 — focused consolidation completed',
          `trace ${focused.trace_id} — ${focused.signal_count} signal(s), ${stageFocused.evidence_refs_count} evidence ref(s), ` +
            `${focused.llm_calls} call(s), ${focused.input_tokens}+${focused.output_tokens} token(s)${focused.reused ? ' (REUSED, no call)' : ''}`,
        );

        // ══ STAGE 3 — PLATEAU + THE CYCLE ═══════════════════════════════
        //
        // The evaluation is the cycle service's OWN path: `evaluatePlateau` is
        // exactly what the MCP tool `run_imagination_cycle` runs for
        // `mode: 'evaluate_only'` (or its `dry_run` alias) — it writes nothing
        // (see `src/services/processing/creative-baton-tools.ts`, the
        // evaluate-only branch). Every condition and the numbers that decided it
        // are recorded below, so a refusal is readable rather than asserted.
        const plateauEvaluation = await evaluatePlateau(db, { userId: user, missionId });
        const cycleStateBefore = await readCycleState(db, user, missionId);
        const windowBefore = windowAt(
          cycleStateBefore,
          Date.parse(plateauEvaluation.evaluated_at),
          plateauEvaluation.evaluated_at,
        );
        const stagePlateau = {
          call: `evaluatePlateau(db, { userId: '${user}', missionId: '${missionId}' }) — the cycle service's own evaluate path, the one the MCP tool's mode: 'evaluate_only' / dry_run invokes (no writes, no model call)`,
          evaluated_at: plateauEvaluation.evaluated_at,
          plateau: plateauEvaluation.plateau,
          conditions: plateauEvaluation.conditions.map((condition: Row) => ({
            name: String(condition.name),
            met: Boolean(condition.met),
            evidence: condition.evidence ?? {},
          })),
          cooldown_remaining_ms: plateauEvaluation.cooldown_remaining_ms,
          cycle_state_before: cycleStateBefore
            ? {
                cycle_count: cycleStateBefore.cycle_count,
                last_ordinal: cycleStateBefore.last_ordinal,
                cycles_in_window: cycleStateBefore.cycles_in_window,
                tokens_in_window: cycleStateBefore.tokens_in_window,
                window_started_at: cycleStateBefore.window_started_at,
                cooldown_until: cycleStateBefore.cooldown_until,
                last_run_at: cycleStateBefore.last_run_at,
                last_cycle_id: cycleStateBefore.last_cycle_id,
                last_baton_id: cycleStateBefore.last_baton_id,
                last_stop_reason: cycleStateBefore.last_stop_reason,
                consecutive_no_new_cells: cycleStateBefore.consecutive_no_new_cells,
                novelty_history: cycleStateBefore.novelty_history,
              }
            : null,
          window_before: windowBefore,
          thresholds_in_force: {
            cooldown_ms: cycleCooldownMs(),
            window_ms: cycleBudgetWindowMs(),
            max_cycles_per_window: maxCyclesPerWindow(),
            max_tokens_per_window: maxTokensPerWindow(),
            max_concurrent_cycles: maxConcurrentCycles(),
            candidate_floor: candidateFloor(),
          },
        };
        mark(
          'stage 3 — plateau evaluated',
          `plateau=${plateauEvaluation.plateau} — ${plateauEvaluation.conditions
            .map((condition: Row) => `${condition.name}:${condition.met ? 'met' : 'not-met'}`)
            .join(', ')}; cooldown ${plateauEvaluation.cooldown_remaining_ms}ms`,
        );

        // The cycle's id is the ENGINE's own derived id (mission scope + version
        // + ordinal): the instrument does not name it, so the mission's
        // canonical cycle sequence stays intact. `IMAGINATION_LOOP_CYCLE` names
        // stage 2's consolidation run, not this.
        const firstUsageBefore = usageSnapshot();
        const firstAttempt = await runImaginationCycle(db, { userId: user, missionId, actorId: user, caller });
        let cycle = firstAttempt;
        let cycleUsage = usageDeltaSince(firstUsageBefore);
        const gateRefusal =
          firstAttempt.status !== 'ran' && PLAN_GATE_REFUSALS.includes(firstAttempt.reason)
            ? {
                verbatim: `runImaginationCycle returned status '${firstAttempt.status}' / reason '${firstAttempt.reason}'`,
                status: firstAttempt.status,
                reason: firstAttempt.reason,
                error: firstAttempt.error ?? null,
                cycle_id: firstAttempt.cycle_id,
                cooldown_remaining_ms: firstAttempt.cooldown_remaining_ms,
                plateau: firstAttempt.plateau
                  ? {
                      plateau: firstAttempt.plateau.plateau,
                      evaluated_at: firstAttempt.plateau.evaluated_at,
                      conditions: firstAttempt.plateau.conditions.map((condition: Row) => ({
                        name: String(condition.name),
                        met: Boolean(condition.met),
                        evidence: condition.evidence ?? {},
                      })),
                    }
                  : null,
                budget: firstAttempt.budget,
                concurrency: firstAttempt.concurrency,
              }
            : null;
        let overrideRun: Row | null = null;
        if (gateRefusal) {
          mark('stage 3 — cycle REFUSED by the gate', `${gateRefusal.verbatim} (recorded verbatim)`);
          if (!config.force) {
            throw new Error(
              `the loop is REFUSED at stage 3: the cycle's own gate refused (${gateRefusal.verbatim}) and ` +
                'IMAGINATION_LOOP_FORCE is 0. The gate is what normally bounds the engine to one cycle per plateau, so ' +
                'this instrument does not bypass it by itself: re-run with IMAGINATION_LOOP_FORCE=1 to force the ' +
                'PLATEAU gate by an explicit override (the capture will say the gate was bypassed).',
            );
          }
          mark(
            'stage 3 — FORCED rerun',
            'IMAGINATION_LOOP_FORCE=1 — re-running with force: true (the documented RunCycleArgs.force override of the ' +
              'PLATEAU gate only); the capture marks the gate as bypassed by an explicit override',
          );
          const forcedUsageBefore = usageSnapshot();
          const forced = await runImaginationCycle(db, {
            userId: user,
            missionId,
            actorId: user,
            caller,
            force: true,
            trigger: 'force_imagination_loop_instrument',
          });
          cycle = forced;
          cycleUsage = usageDeltaSince(firstUsageBefore);
          overrideRun = {
            gate_bypassed: true,
            force: true,
            trigger: 'force_imagination_loop_instrument',
            status: forced.status,
            reason: forced.reason,
            cycle_id: forced.cycle_id,
            error: forced.error ?? null,
            stop_reason: forced.stop_reason,
            plateau: forced.plateau
              ? {
                  plateau: forced.plateau.plateau,
                  conditions: forced.plateau.conditions.map((condition: Row) => ({
                    name: String(condition.name),
                    met: Boolean(condition.met),
                  })),
                }
              : null,
            budget: forced.budget,
            concurrency: forced.concurrency,
            usage: {
              input_tokens: usageDeltaSince(forcedUsageBefore).input_tokens,
              output_tokens: usageDeltaSince(forcedUsageBefore).output_tokens,
            },
          };
        }
        if (cycle.status !== 'ran') {
          throw new Error(
            `the loop is REFUSED at stage 3: the cycle did not run to a completed row — status '${cycle.status}' / ` +
              `reason '${cycle.reason}'${cycle.error ? ` / error '${cycle.error}'` : ''}` +
              `${cycle.status === 'skipped' ? ' (a skipped cycle writes NOTHING; the capture was not written)' : ''}`,
          );
        }
        const cycleId = String(cycle.cycle_id);
        const cycleRow = (await db
          .collection(CREATIVE_BATON_COLLECTIONS.cycles)
          .findOne({ mission_id: missionId, cycle_id: cycleId }, { projection: { _id: 0 } })) as Row | null;
        const cycleAdmitted = Number(cycleRow?.counts?.seeds_admitted ?? cycle.portfolio?.seeds_admitted ?? 0);
        mark(
          'stage 3 — cycle ran',
          `cycle ${cycleId} — stop '${cycle.stop_reason}' — generated ${cycleRow?.counts?.seeds_generated ?? cycle.portfolio?.seeds_generated ?? 0}, ` +
            `admitted ${cycleAdmitted}, rejected ${cycleRow?.counts?.seeds_rejected ?? cycle.portfolio?.seeds_rejected ?? 0}, ` +
            `below-incumbent ${cycleRow?.counts?.seeds_below_incumbent ?? cycle.portfolio?.seeds_below_incumbent ?? 0}, ` +
            `new cells ${cycleRow?.counts?.new_cells ?? cycle.portfolio?.new_cells ?? 0}, ${cycleUsage.input_tokens + cycleUsage.output_tokens} token(s)` +
            `${overrideRun ? ' (GATE BYPASSED BY EXPLICIT OVERRIDE)' : ''}`,
        );

        // ── the cycle's own seed rows, read back ──────────────────────────
        let seedsFilter = `{ user_id: '${user}', mission_id: '${missionId}', cycle_id: '${cycleId}' }`;
        let seeds = (await db
          .collection(IMAGINATION_COLLECTIONS.ideaSeeds)
          .find({ user_id: user, mission_id: missionId, cycle_id: cycleId }, { projection: { _id: 0 } })
          .toArray()) as Row[];
        if (seeds.length === 0) {
          // Defensive: the seeds are identity+mission scoped by their own index;
          // if the archive did not stamp this cycle's id on them, the run's rows
          // are still the mission's whole seed set (this is the mission's FIRST
          // cycle, so there is nothing else to confuse them with) — and the
          // fallback is NAMED in the capture rather than silently applied.
          seeds = (await db
            .collection(IMAGINATION_COLLECTIONS.ideaSeeds)
            .find({ user_id: user, mission_id: missionId }, { projection: { _id: 0 } })
            .toArray()) as Row[];
          seedsFilter = `{ user_id: '${user}', mission_id: '${missionId}' } (FALLBACK: no seed carried cycle_id '${cycleId}')`;
        }
        const admitted = seeds.filter((seed) => seed.state !== 'rejected');
        const rejected = seeds.filter((seed) => seed.state === 'rejected');
        const seedIds = seeds.map((seed) => String(seed.seed_id));
        const cycleCoverage = (cycleRow?.coverage ?? {}) as Row;
        const stageCycle = {
          call: `runImaginationCycle(db, { userId: '${user}', missionId: '${missionId}', actorId: '${user}', caller: {user_id: '${user}', trusted: true} }${overrideRun ? ', force: true' : ''})`,
          gate_refusal: gateRefusal,
          override: overrideRun,
          gate_note: gateRefusal
            ? 'the real gate REFUSED first; the second call carried the documented force override, so this cycle RAN WITH THE PLATEAU GATE BYPASSED BY AN EXPLICIT OVERRIDE'
            : 'the real gate did not refuse: this cycle is the engine\'s own, unforced decision — no override was used',
          status: cycle.status,
          reason: cycle.reason,
          cycle_id: cycleId,
          trace_id: cycle.trace_id,
          stop_reason: cycle.stop_reason,
          stop_conditions: (cycle.stop_conditions ?? []).map((condition: Row) => ({
            name: String(condition.name),
            met: Boolean(condition.met),
            evidence: condition.evidence ?? {},
          })),
          counts: {
            seeds_generated: Number(cycleRow?.counts?.seeds_generated ?? cycle.portfolio?.seeds_generated ?? 0),
            seeds_admitted: cycleAdmitted,
            seeds_rejected: Number(cycleRow?.counts?.seeds_rejected ?? cycle.portfolio?.seeds_rejected ?? 0),
            seeds_below_incumbent: Number(
              cycleRow?.counts?.seeds_below_incumbent ?? cycle.portfolio?.seeds_below_incumbent ?? 0,
            ),
            candidates_considered: Number(cycleRow?.counts?.candidates_considered ?? cycle.portfolio?.candidates_considered ?? 0),
            candidates_eligible: Number(cycleRow?.counts?.candidates_eligible ?? cycle.portfolio?.candidates_eligible ?? 0),
            new_cells: Number(cycleRow?.counts?.new_cells ?? cycle.portfolio?.new_cells ?? 0),
            cells_total: Number(cycleRow?.counts?.cells_total ?? cycle.portfolio?.cells_total ?? 0),
          },
          rejections: rejected.map((seed) => ({
            seed_id: String(seed.seed_id),
            reason: String(seed.rejection?.reason ?? 'rejected'),
            detail: seed.rejection?.detail ?? null,
            duplicate_of: seed.rejection?.duplicate_of ?? null,
          })),
          coverage: {
            source: `the cycle row's own coverage view (${CREATIVE_BATON_COLLECTIONS.cycles}.coverage)`,
            cells_total: Number(cycleCoverage.cells_total ?? 0),
            new_cells_this_cycle: Number(cycleCoverage.new_cells_this_cycle ?? 0),
            occupancy: cycleCoverage.occupancy ?? null,
            scan: cycleCoverage.scan ?? null,
            gaps: cycleCoverage.gaps ?? null,
          },
          portfolio_digest: cycle.portfolio?.portfolio_digest ?? cycleRow?.portfolio_digest ?? null,
          baton_id: cycle.baton_id,
          baton_reused: Boolean(cycleRow?.baton_reused),
          promoted: cycle.promoted,
          promotion_skipped: cycle.promotion_skipped,
          tokens: {
            measured_this_cycle: Number(cycle.budget?.tokens_spent_this_cycle ?? 0),
            usage_delta_input: cycleUsage.input_tokens,
            usage_delta_output: cycleUsage.output_tokens,
            usage_delta_reasoning_output: cycleUsage.reasoning_output_tokens,
            usage_delta_requests: cycleUsage.requests,
            window_max_tokens: cycle.budget?.max_tokens ?? maxTokensPerWindow(),
            window_tokens_before: cycle.budget?.tokens_in_window_before ?? null,
            window_tokens_after: cycle.budget?.tokens_in_window_after ?? null,
          },
          budget: cycle.budget,
          concurrency: cycle.concurrency,
          novelty: cycleRow?.novelty ?? {
            mean_this_cycle: null,
            previous_mean: null,
            gain: 0,
          },
          duration_ms: cycleRow?.duration_ms ?? null,
          created_at: cycleRow?.created_at ?? null,
          completed_at: cycleRow?.completed_at ?? null,
          error: cycleRow?.error ?? cycle.error ?? null,
          privacy_audit: cycleRow?.privacy_audit ?? null,
          seeds_filter_used: seedsFilter,
        };

        // ══ STAGE 4 — VERIFICATION: RANK, THEN EXECUTE THE PERMITTED TEST ═
        const ranked = rankCheapTests(admitted as unknown as IdeaSeed[], {
          missionAuthority: String(missionState.authority_class ?? '') || null,
          limit: 25,
        });
        const rankedList = ranked.tests.map((test) => ({
          rank: test.rank,
          seed_id: test.seed_id,
          operator: test.operator,
          cheapest_test: test.cheapest_test,
          expected_information_gain: test.expected_information_gain,
          cost: test.cost,
          cost_source: test.cost_source,
          test_strategy: test.test_strategy,
          score: test.score,
          authority_required: test.authority_required,
          permitted: test.permitted,
        }));
        const permittedTests = ranked.tests.filter((test) => test.permitted);
        const refusedByAuthority = ranked.tests.filter((test) => !test.permitted);
        mark(
          'stage 4 — cheap tests ranked',
          `${ranked.considered} admitted candidate(s) ranked, ${permittedTests.length} permitted by authority ` +
            `${String(missionState.authority_class)} , ${refusedByAuthority.length} refused by it` +
            `${ranked.omitted_by_limit > 0 ? `, ${ranked.omitted_by_limit} beyond the reporting limit` : ''}`,
        );

        // ── the blinded judge over THIS cycle's admitted candidates ───────
        const judgeModel = model.model;
        const judgeCalls: Row[] = [];
        const verdicts: JudgeParseResult['verdicts'] = [];
        const judgeRefusals: string[] = [];
        let caseMapping: CaseMapping[] = [];
        let judgeCaseCount = 0;
        let judgePromptHash: string | null = null;
        let judgeUsage = { input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, requests: 0 };
        let judgeSkippedReason: string | null = null;
        if (admitted.length === 0) {
          judgeSkippedReason =
            'no admitted candidate in this cycle — there is nothing to judge (an empty candidate set is a fact about ' +
            'the cycle, reported in counts/rejections, not hidden behind a judge call)';
        } else {
          const candidates: JudgeCandidateInput[] = admitted.map((seed) => ({
            seed_id: String(seed.seed_id),
            hypothesis: String(seed.hypothesis ?? ''),
            mechanism: String(seed.mechanism ?? ''),
            cheapest_test: String(seed.cheapest_test ?? ''),
            evidence_refs: (Array.isArray(seed.evidence_refs) ? seed.evidence_refs : []).map((ref: unknown) => String(ref)),
            descriptor_bins: { ...(seed.bins ?? {}) },
          }));
          const blinded = blindCases([{ label: cycleId, candidates }], { shuffleSeed: DEFAULT_SHUFFLE_SEED });
          const cases: BlindCase[] = blinded.cases;
          caseMapping = blinded.mapping;
          judgeCaseCount = cases.length;
          if (cases.length > MAX_JUDGED_CANDIDATES) {
            throw new Error(
              `the loop is REFUSED at stage 4: ${cases.length} candidate(s) would be judged, above ` +
                `MAX_JUDGED_CANDIDATES=${MAX_JUDGED_CANDIDATES} — the instrument is BOUNDED, so it stops here rather ` +
                'than spending an unbounded run; nothing was judged and no verdict was recorded',
            );
          }
          const batches: BlindCase[][] = [];
          for (let index = 0; index < cases.length; index += JUDGE_BATCH_SIZE) {
            batches.push(cases.slice(index, index + JUDGE_BATCH_SIZE));
          }
          mark('stage 4 — judge started', `${batches.length} batch(es) of at most ${JUDGE_BATCH_SIZE} case(s) with ${judgeModel}`);
          for (const [index, batch] of batches.entries()) {
            const prompt = judgePrompt(batch);
            if (index === 0) judgePromptHash = sha256(prompt);
            const usageBefore = usageSnapshot();
            const raw = await llmService.extractJson(JUDGE_SYSTEM_PROMPT, prompt, judgeMaxTokens(batch.length));
            const callUsage = usageDeltaSince(usageBefore);
            const parsed = parseJudgeReply(raw, batch);
            verdicts.push(...parsed.verdicts);
            judgeRefusals.push(...parsed.refusals);
            judgeCalls.push({
              batch: index + 1,
              model: judgeModel,
              case_ids: batch.map((item) => item.case_id),
              max_tokens: judgeMaxTokens(batch.length),
              usage: {
                input_tokens: callUsage.input_tokens,
                output_tokens: callUsage.output_tokens,
                reasoning_output_tokens: callUsage.reasoning_output_tokens,
                requests: callUsage.requests,
              },
              refused: parsed.refusals,
              reply: raw,
            });
            judgeUsage = {
              input_tokens: judgeUsage.input_tokens + callUsage.input_tokens,
              output_tokens: judgeUsage.output_tokens + callUsage.output_tokens,
              reasoning_output_tokens: judgeUsage.reasoning_output_tokens + callUsage.reasoning_output_tokens,
              requests: judgeUsage.requests + callUsage.requests,
            };
            mark(
              'stage 4 — judge batch done',
              `batch ${index + 1}/${batches.length} — ${parsed.verdicts.length} verdict(s), ${parsed.refusals.length} refusal(s), ` +
                `${callUsage.input_tokens} input / ${callUsage.output_tokens} output token(s)`,
            );
          }
        }
        const mappingByCase = new Map(caseMapping.map((row) => [row.case_id, row]));
        const verdictBySeedId = new Map<string, JudgeParseResult['verdicts'][number]>();
        for (const verdict of verdicts) {
          const target = mappingByCase.get(String(verdict.case_id));
          if (target) verdictBySeedId.set(target.seed_id, verdict);
        }

        // ── the shipped verification path, on the TOP permitted ranked test ─
        const targetTest = permittedTests.find((test) => verdictBySeedId.has(test.seed_id)) ?? null;
        let execution: Row | null = null;
        let executionRefusalReason: string | null = null;
        let consumedSeedId: string | null = null;
        if (!targetTest) {
          executionRefusalReason =
            ranked.tests.length === 0
              ? 'NO RANKED TEST: no admitted candidate of this cycle carries a cheap test, so there is nothing the ' +
                'verification path could be pointed at'
              : permittedTests.length === 0
                ? `NO PERMITTED TEST: all ${ranked.tests.length} ranked test(s) need an authority class above this ` +
                  `mission's own (${String(missionState.authority_class)}); the mission's authority is recorded with each ` +
                  'ranked row, and the service refuses rather than downgrading a test'
                : `NO PERMITTED TEST WITH A VERDICT: ${permittedTests.length} permitted test(s) were ranked but the judge ` +
                  'returned no verdict for any of them (its refusals are recorded verbatim)';
          mark('stage 4 — no permitted test executed', executionRefusalReason);
        } else {
          const verdict = verdictBySeedId.get(targetTest.seed_id)!;
          const detail =
            `${DRIVER}: blinded judge (${judgeModel}) verdict for ${verdict.case_id} — ${verdict.reason} ` +
            `[novelty ${verdict.novelty}, coherence ${verdict.coherence}, testability ${verdict.testability}, ` +
            `information_gain ${verdict.information_gain}]`;
          consumedSeedId = targetTest.seed_id;
          const executed = await executePermittedTest(db, {
            userId: user,
            missionId,
            seedId: targetTest.seed_id,
            outcome: verdict.verdict as CandidateOutcome,
            batonId: cycle.baton_id,
            detail,
            authorityRequired: targetTest.authority_required,
            caller,
          });
          execution = {
            call: `executePermittedTest(db, { seedId: '${targetTest.seed_id}', outcome: '${verdict.verdict}', authorityRequired: '${targetTest.authority_required}', batonId: '${cycle.baton_id}', caller: {user_id: '${user}', trusted: true} })`,
            rank: targetTest.rank,
            permitted: executed.permitted,
            code: executed.code,
            reason: executed.reason,
            mission_authority: executed.mission_authority,
            test: executed.test,
            outcome_channel: executed.outcome
              ? {
                  recorded: executed.outcome.recorded,
                  repeated: executed.outcome.repeated,
                  outcome: executed.outcome.outcome?.outcome ?? null,
                  outcome_id: executed.outcome.outcome?.outcome_id ?? null,
                  recorded_at: executed.outcome.outcome?.recorded_at ?? null,
                  novelty_replenished: executed.outcome.novelty_replenished,
                  telemetry_evaluation_id: executed.outcome.telemetry_evaluation_id,
                  lineage_updated: executed.outcome.lineage_updated,
                  reason: executed.outcome.reason,
                }
              : null,
            failure_signature: executed.failure_signature ?? null,
            judged_verdict: {
              case_id: verdict.case_id,
              verdict: verdict.verdict,
              novelty: verdict.novelty,
              coherence: verdict.coherence,
              testability: verdict.testability,
              information_gain: verdict.information_gain,
              reason: verdict.reason,
            },
            detail,
          };
          mark(
            'stage 4 — permitted test executed',
            `seed ${targetTest.seed_id} (rank ${targetTest.rank}, authority ${targetTest.authority_required}) — recorded '${verdict.verdict}' ` +
              `(permitted=${executed.permitted}${executed.code ? `, code ${executed.code}` : ''})`,
          );
        }

        // ── the outcome channel for every other verdict (bounded, verbatim) ─
        //
        // The verdict the verification path consumed is NOT re-recorded when
        // that path recorded it (the channel is idempotent per {seed, outcome},
        // so a second call would report a repeat). When the path REFUSED (its
        // own gates: authority, a terminal mission, a seed that is not
        // admitted), the channel is exercised DIRECTLY for that verdict too —
        // the task of this stage is to show the outcome feedback loop closed,
        // and a refusal is reported beside the row rather than instead of it.
        const executionRecorded = Boolean(execution?.permitted && execution?.outcome?.recorded);
        const outcomeRecords: Row[] = [];
        for (const verdict of verdicts) {
          const target = mappingByCase.get(String(verdict.case_id));
          if (!target) continue;
          const viaVerificationPath = target.seed_id === consumedSeedId && executionRecorded;
          if (viaVerificationPath) {
            outcomeRecords.push({
              seed_id: target.seed_id,
              case_id: verdict.case_id,
              verdict: verdict.verdict,
              recorded: true,
              repeated: false,
              note:
                'recorded through executePermittedTest (the shipped verification path) above — deliberately NOT ' +
                're-recorded here',
            });
            continue;
          }
          const recorded = await recordCandidateOutcome(db, {
            userId: user,
            seedId: target.seed_id,
            outcome: verdict.verdict as CandidateOutcome,
            batonId: cycle.baton_id,
            detail:
              `${DRIVER}: blinded judge (${judgeModel}) verdict for ${verdict.case_id} — ${verdict.reason} ` +
              `[novelty ${verdict.novelty}, coherence ${verdict.coherence}, testability ${verdict.testability}, ` +
              `information_gain ${verdict.information_gain}]`,
          });
          outcomeRecords.push({
            seed_id: target.seed_id,
            case_id: verdict.case_id,
            verdict: verdict.verdict,
            recorded: recorded.recorded,
            repeated: recorded.repeated,
            reason: recorded.reason,
            novelty_replenished: recorded.novelty_replenished,
            telemetry_evaluation_id: recorded.telemetry_evaluation_id,
            lineage_updated: recorded.lineage_updated,
            note:
              target.seed_id === consumedSeedId
                ? `the verification path did NOT record this verdict (${execution?.code ?? 'no execution'}), so the channel was exercised directly for it`
                : undefined,
          });
        }
        const outcomeReached = outcomeRecords.filter((row) => row.recorded === true || row.repeated === true);
        const outcomeRefusals = outcomeRecords.filter((row) => row.recorded === false && row.repeated === false);
        const stageVerification = {
          ranked: {
            basis: ranked.basis,
            considered: ranked.considered,
            omitted_by_limit: ranked.omitted_by_limit,
            refused_by_authority: ranked.refused_by_authority,
            mission_authority: String(missionState.authority_class ?? ''),
            candidate_floor_note:
              'the ranked set is the cycle’s ADMITTED candidates (every seed whose state was not rejected), read back from idea_seeds',
            tests: rankedList,
          },
          execution,
          execution_refused: execution ? null : { reason: executionRefusalReason, ranked_tests: rankedList.length },
          judge: {
            instrument: 'server/tests/helpers/imagination-blind-judge.ts',
            model: judgeModel,
            provider: model.provider,
            system_prompt_sha256: judgePromptSha256(),
            prompt_sha256: judgePromptHash,
            prompt_note:
              'the system instruction is hashed over the frozen constant (JUDGE_SYSTEM_PROMPT); the user prompt (the ' +
              'batched case lines) is hashed over the first batch actually sent',
            shuffle_seed: DEFAULT_SHUFFLE_SEED,
            batch_size: JUDGE_BATCH_SIZE,
            cases: judgeCaseCount,
            mapping: caseMapping,
            verdicts,
            refusals: judgeRefusals,
            skipped_reason: judgeSkippedReason,
            calls: judgeCalls,
            usage: judgeUsage,
            max_tokens_per_call: judgeCalls.map((call) => call.max_tokens),
          },
          outcomes_recorded: outcomeRecords,
          outcomes_reached: outcomeReached.length,
          outcome_refusals: outcomeRefusals,
        };
        if (verdicts.length > 0) {
          mark('stage 4 — outcomes recorded', `${outcomeRecords.length} verdict(s) attributed to seeds, ${outcomeRefusals.length} refusal(s)`);
        }

        // ══ STAGE 5 — THE BATON, ITS PROMOTION, AND ITS READ-BACK ════════
        const baton = cycle.baton as CreativeBaton | null;
        if (!baton) {
          throw new Error(
            `the loop is REFUSED at stage 5: the cycle ran (${cycleId}) but returned no compiled baton — status ` +
              `'${cycle.status}' / reason '${cycle.reason}' / stop '${cycle.stop_reason}'. The baton is the loop's ` +
              'hand-off to the controller, so a run without one cannot be reported as a completed loop.',
          );
        }
        const storedBatonDoc = (await db
          .collection(CREATIVE_BATON_COLLECTIONS.creativeBatons)
          .findOne({ baton_id: baton.baton_id }, { projection: { _id: 0 } })) as Row | null;
        const integrity = verifyStoredBaton(storedBatonDoc as unknown as Record<string, unknown> | null);
        const validation = validateCreativeBaton(storedBatonDoc ?? baton);
        const recomputedHash = storedBatonDoc ? creativeBatonPayloadHash(storedBatonDoc) : null;
        // The cycle promotes the baton itself when the flags are on and the
        // caller is trusted. This call is the GATED promoter run beside it: it
        // reports `reused: true` for an already-promoted baton, which is the
        // promotion's own idempotency proof (and a fresh promotion otherwise).
        const promotion = await promoteCreativeBaton(db, { userId: user, batonId: baton.baton_id, caller });
        const promotionAuditRow = (await db
          .collection(CREATIVE_BATON_COLLECTIONS.batonPromotions)
          .findOne({ baton_id: baton.baton_id }, { projection: { _id: 0 } })) as Row | null;
        const readResult = await new CreativeBatonService(db).readCreativeBaton(baton.baton_id, caller);
        const readerView = (await new CreativeBatonService(db).getCreativeBaton(
          baton.baton_id,
          caller,
        )) as CreativeBaton | null;
        const fingerprint = (region: Row): string => sha256(`${String(region.pattern ?? '')}|${String(region.reason ?? '')}`);
        const stageBaton = {
          compiled_by: 'the cycle itself: CreativeBatonService.compileAndStore (step 4 of runImaginationCycle) — read back from the cycle result, never recompiled here',
          baton_id: baton.baton_id,
          cycle_id: baton.cycle_id,
          mission_id: baton.mission_id,
          mission_version: baton.mission_version,
          creative_baton_version: baton.creative_baton_version,
          schema_version: baton.schema_version,
          created_at: baton.created_at,
          trigger: baton.trigger,
          problem_state_digest: baton.problem_state_digest,
          attention_targets: (baton.attention_targets ?? []).map((target: Row) => ({
            cue: String(target.cue),
            why_operationally_relevant: String(target.why_operationally_relevant),
            operator_families: (target.operator_families ?? []).map((family: unknown) => String(family)),
          })),
          excluded_regions: (baton.excluded_regions ?? []).map((region: Row) => ({
            pattern: String(region.pattern),
            reason: String(region.reason),
            unless: String(region.unless),
            fingerprint: fingerprint(region),
            fingerprint_basis: 'sha256 over "pattern|reason" — the region’s own identity, recorded so two runs can be compared without comparing prose',
          })),
          candidate_portfolio: (baton.candidate_portfolio ?? []).map((candidate: Row) => ({
            seed_id: String(candidate.seed_id),
            descriptor_bins: (candidate.descriptor_bins ?? []).map((bin: unknown) => String(bin)),
            novelty_score: Number(candidate.novelty_score),
            coherence_score: Number(candidate.coherence_score),
            expected_information_gain: Number(candidate.expected_information_gain),
            cheapest_test: String(candidate.cheapest_test),
            lineage_ref: String(candidate.lineage_ref),
            privacy_safe: candidate.privacy_safe === true,
          })),
          coverage_summary: baton.coverage_summary ?? null,
          coverage_gaps: (baton.coverage_gaps ?? []).map((gap: Row) => ({
            dimension: String(gap.dimension),
            unoccupied_bins: (gap.unoccupied_bins ?? []).map((bin: unknown) => String(bin)),
          })),
          next_round_budget: baton.next_round_budget ?? null,
          counts: baton.counts ?? null,
          privacy: baton.privacy ?? null,
          stop_reason: baton.stop_reason ?? null,
          payload_hash: baton.payload_hash,
          payload_hash_recomputed: recomputedHash,
          payload_hash_matches_store: recomputedHash !== null && recomputedHash === baton.payload_hash,
          version_in_force: CREATIVE_BATON_VERSION,
          validation: {
            valid: validation.valid,
            errors: validation.errors,
            basis:
              'validateCreativeBaton(stored row): the registered (CLOSED) JSON schema, then the secret-shape scan ' +
              '(assertNoSecretMaterial over the serialised document) — the same two checks the compiler and the promoter run',
          },
          integrity: {
            ok: integrity.ok,
            code: integrity.code,
            reason: integrity.reason,
            basis: 'verifyStoredBaton(stored row): version → closed schema → secret scan → recomputed payload hash',
          },
          stored_row_present: storedBatonDoc !== null,
          cycle_promoted: cycle.promoted,
          cycle_promotion_skipped: cycle.promotion_skipped,
          promotion: {
            call: `promoteCreativeBaton(db, { userId: '${user}', batonId: '${baton.baton_id}', caller: {user_id: '${user}', trusted: true} })`,
            promoted: promotion.promoted,
            reused: promotion.reused,
            reused_note: promotion.reused
              ? 'REUSED: this baton (this payload) was already promoted — no second write, which is the GATED promotion’s own idempotency proof'
              : 'fresh promotion: this call wrote the promotion audit row',
            shared_id: promotion.shared_id,
            code: promotion.code,
            reason: promotion.reason,
            promotion_row: promotion.promotion,
          },
          promotion_audit_row: promotionAuditRow
            ? {
                promotion_id: promotionAuditRow.promotion_id,
                baton_id: promotionAuditRow.baton_id,
                mission_id: promotionAuditRow.mission_id,
                cycle_id: promotionAuditRow.cycle_id,
                user_id: promotionAuditRow.user_id,
                promoted_by: promotionAuditRow.promoted_by,
                promoted_at: promotionAuditRow.promoted_at,
                payload_hash: promotionAuditRow.payload_hash,
                shared_id: promotionAuditRow.shared_id,
                baton_schema_version: promotionAuditRow.baton_schema_version,
                creative_baton_version: promotionAuditRow.creative_baton_version,
              }
            : null,
          reader_view: {
            basis: 'getCreativeBaton(baton_id, caller) — the caller-aware, integrity-checked read a controller performs',
            readable: readerView !== null,
            refusal: readResult.refusal
              ? { code: readResult.refusal.code, reason: readResult.refusal.reason }
              : null,
            baton: readerView
              ? {
                  baton_id: readerView.baton_id,
                  mission_id: readerView.mission_id,
                  cycle_id: readerView.cycle_id,
                  mission_version: readerView.mission_version,
                  created_at: readerView.created_at,
                  shared_id: readerView.shared_id ?? null,
                  promotion_id: readerView.promotion_id ?? null,
                  promoted_at: readerView.promoted_at ?? null,
                  promoted_by: readerView.promoted_by ?? null,
                  privacy: readerView.privacy,
                  payload_hash: readerView.payload_hash,
                  attention_targets: (readerView.attention_targets ?? []).map((target: Row) => String(target.cue)),
                  portfolio_seed_ids: (readerView.candidate_portfolio ?? []).map((candidate: Row) => String(candidate.seed_id)),
                  counts: readerView.counts,
                }
              : null,
          },
        };
        mark(
          'stage 5 — baton compiled and promoted',
          `baton ${baton.baton_id} — ${(baton.candidate_portfolio ?? []).length} candidate(s), ${(baton.attention_targets ?? []).length} attention target(s), ` +
            `${(baton.excluded_regions ?? []).length} excluded region(s) — validated ${validation.valid}/integrity ${integrity.ok} — ` +
            `promotion ${promotion.promoted ? 'promoted' : 'REFUSED'}${promotion.reused ? ' (reused)' : ''} shared '${promotion.shared_id ?? 'none'}'`,
        );

        // ══ STAGE 6 — THE CONTROLLER ADAPTER (and its idempotency) ═══════
        const queueRowsBefore = await countOf(COLLECTIONS.cognitiveWorkItems, { mission_id: missionId });
        const adapterFirst = await batonCandidatesToWorkItems(db, { userId: user, batonId: baton.baton_id, caller });
        const queueRowsAfterFirst = await countOf(COLLECTIONS.cognitiveWorkItems, { mission_id: missionId });
        const adapterSecond = await batonCandidatesToWorkItems(db, { userId: user, batonId: baton.baton_id, caller });
        const queueRowsAfterSecond = await countOf(COLLECTIONS.cognitiveWorkItems, { mission_id: missionId });
        const adapterWorkItemIds = [
          ...new Set([...(adapterFirst.work_items ?? []), ...(adapterSecond.work_items ?? [])].map((item: Row) => String(item.work_item_id))),
        ];
        const workItemRows = (await db
          .collection(COLLECTIONS.cognitiveWorkItems)
          .find({ work_item_id: { $in: adapterWorkItemIds.length > 0 ? adapterWorkItemIds : ['__none__'] } }, { projection: { _id: 0 } })
          .toArray()) as Row[];
        const workItemProjection = (row: Row): Row => ({
          work_item_id: String(row.work_item_id),
          mission_id: row.mission_id ?? null,
          trigger: row.trigger ?? null,
          status: row.status ?? null,
          mode: row.mode ?? null,
          priority: row.priority ?? null,
          description: String(row.description ?? ''),
          provenance: row.provenance ?? null,
          created_at: row.created_at ?? null,
        });
        const stageAdapter = {
          call: `batonCandidatesToWorkItems(db, { userId: '${user}', batonId: '${baton.baton_id}', caller: {user_id: '${user}', trusted: true} })`,
          first: {
            created: adapterFirst.created,
            reused: adapterFirst.reused,
            work_items_added_total: adapterFirst.work_items_added_total,
            funnel_derived_added: adapterFirst.funnel_derived_added,
            work_items: adapterFirst.work_items,
            reason: adapterFirst.reason,
          },
          second: {
            created: adapterSecond.created,
            reused: adapterSecond.reused,
            work_items_added_total: adapterSecond.work_items_added_total,
            funnel_derived_added: adapterSecond.funnel_derived_added,
            work_items: adapterSecond.work_items,
            reason: adapterSecond.reason,
          },
          idempotency: {
            created_on_second_call: adapterSecond.created,
            work_item_ids_identical:
              adapterFirst.work_items.map((item: Row) => String(item.work_item_id)).sort().join(',') ===
              adapterSecond.work_items.map((item: Row) => String(item.work_item_id)).sort().join(','),
            queue_rows_before_first_call: queueRowsBefore,
            queue_rows_after_first_call: queueRowsAfterFirst,
            queue_rows_after_second_call: queueRowsAfterSecond,
            queue_unchanged_by_second_call: queueRowsAfterSecond === queueRowsAfterFirst,
            note:
              'the queue dedupes on {mission_id, trigger, description}, and every description is derived from the baton ' +
              'id + seed id + the candidate’s own text, so the second call inserts nothing and reports the same items as reused',
          },
          work_items: adapterWorkItemIds,
          work_item_rows: workItemRows.map(workItemProjection),
          provenance_rows: workItemRows.map((row) => ({
            work_item_id: String(row.work_item_id),
            provenance: row.provenance ?? null,
          })),
          empty_portfolio_note:
            (baton.candidate_portfolio ?? []).length === 0
              ? 'the baton carried NO candidate, so the adapter had nothing to turn into work: the funnel may still have ' +
                'derived items from mission state (funnel_derived_added), and the idempotency check is vacuous-but-true'
              : null,
        };
        mark(
          'stage 6 — controller adapter ran',
          `created ${adapterFirst.created}, reused ${adapterFirst.reused}, funnel-derived ${adapterFirst.funnel_derived_added}; ` +
            `second call created ${adapterSecond.created} and left the queue at ${queueRowsAfterSecond} row(s)`,
        );

        // ══ STAGE 7 — THE OUTCOME CHANNEL, READ BACK FROM THE STORE ══════
        const outcomeRows = (await db
          .collection(CREATIVE_BATON_COLLECTIONS.candidateOutcomes)
          .find(
            { user_id: user, mission_id: missionId, seed_id: { $in: seedIds.length > 0 ? seedIds : ['__none__'] } },
            { projection: { _id: 0 } },
          )
          .toArray()) as Row[];
        const countsByVerdict: Record<string, number> = Object.fromEntries(
          CANDIDATE_OUTCOMES.map((name: string) => [name, outcomeRows.filter((row) => row.outcome === name).length]),
        );
        const stageOutcome = {
          read_from: `${CREATIVE_BATON_COLLECTIONS.candidateOutcomes} rows for { user_id: '${user}', mission_id: '${missionId}', seed_id ∈ this cycle's seeds }`,
          rows: outcomeRows.map((row) => ({
            outcome_id: String(row.outcome_id),
            seed_id: String(row.seed_id),
            outcome: String(row.outcome),
            baton_id: row.baton_id ?? null,
            recorded_at: row.recorded_at ?? null,
            novelty_replenished: Number(row.novelty_replenished ?? 0),
            telemetry_evaluation_id: row.telemetry_evaluation_id ?? null,
            detail_recorded: typeof row.detail === 'string' && row.detail.length > 0,
          })),
          counts_by_verdict: countsByVerdict,
          total_rows: outcomeRows.length,
          judged_verdicts: verdicts.length,
          judge_refusals: judgeRefusals,
          channel_refusals: outcomeRefusals,
          executed_through_verification_path: consumedSeedId,
          note:
            'every row here is a verdict this run recorded through the shipped outcome channel (recordCandidateOutcome), ' +
            'directly or via executePermittedTest; the channel is idempotent per {seed, outcome}, so a re-run would ' +
            'report repeats rather than write a second row',
        };

        // ══ STAGE 8 — THE MISSION-COGNITION RESUME ═══════════════════════
        const resume = await buildResumeReport(db, missionId);
        const section = resume.creative_baton;
        const proseFields = seeds
          .flatMap((seed) => [String(seed.hypothesis ?? ''), String(seed.mechanism ?? '')])
          .map((text) => text.trim())
          .filter((text) => text.length >= 20);
        const sectionJson = JSON.stringify(section);
        const leakedProse = proseFields.filter((text) => sectionJson.includes(text.slice(0, 40)));
        const stageResume = {
          call: `buildResumeReport(db, '${missionId}') — src/services/mission-cognition/resume.ts, the continuity surface a cold agent reads`,
          carries_creative_baton_section: section.status === 'included',
          status: section.status,
          code: section.code,
          reason: section.reason,
          baton_id: section.baton_id,
          creative_baton_version: section.creative_baton_version,
          mission_version: section.mission_version,
          cycle_id: section.cycle_id,
          promoted: section.promoted,
          attention_targets: section.attention_targets,
          candidate_portfolio: section.candidate_portfolio,
          work_items: section.work_items,
          counts: section.counts,
          privacy: section.privacy,
          basis: section.basis,
          prose_check: {
            prose_fields_checked: proseFields.length,
            prose_fields_matched_in_section: leakedProse.length,
            method: 'each candidate hypothesis/mechanism (≥20 chars) was searched for, by its first 40 characters, inside the serialised section',
            prose_omitted_counter: section.counts.prose_fields_omitted,
          },
          next_action: resume.next_action,
          mission: resume.mission,
          checkpoint: resume.checkpoint,
          reconstruction_source: resume.reconstruction_source,
        };
        mark(
          'stage 8 — resume read',
          `creative_baton section ${section.status} (code '${section.code}') — ${section.attention_targets.length} attention target(s), ` +
            `${section.candidate_portfolio.length} candidate summary row(s), prose fields omitted ${section.counts.prose_fields_omitted}`,
        );

        // ── the invariant checks (recorded, then asserted after the write) ──
        check(
          'the cycle ran to a completed terminal row',
          cycle.status === 'ran',
          `status '${cycle.status}' / reason '${cycle.reason}' / stop '${cycle.stop_reason}'`,
        );
        check(
          'the baton the cycle compiled is the baton the reader gets',
          readerView !== null && readerView.baton_id === baton.baton_id,
          `cycle baton '${baton.baton_id}' vs reader '${readerView?.baton_id ?? '(none)'}'${readResult.refusal ? ` (refusal ${readResult.refusal.code}: ${readResult.refusal.reason})` : ''}`,
        );
        check(
          'the stored baton is intact (version, closed schema, secret scan, payload hash)',
          integrity.ok && validation.valid && recomputedHash === baton.payload_hash,
          `integrity ${integrity.ok} (${integrity.code ?? 'ok'}); validation ${validation.valid}; recomputed hash ${recomputedHash === baton.payload_hash ? 'matches' : 'MISMATCH'}`,
        );
        check(
          'the promotion audit row exists and names the baton',
          promotionAuditRow !== null && String(promotionAuditRow.baton_id) === baton.baton_id && promotion.promoted,
          `promoted ${promotion.promoted} / reused ${promotion.reused} / code '${promotion.code ?? 'none'}' / shared_id '${promotion.shared_id ?? 'none'}' / audit row ${promotionAuditRow ? 'present' : 'ABSENT'}`,
        );
        check(
          'the controller adapter is idempotent',
          adapterSecond.created === 0 &&
            stageAdapter.idempotency.queue_unchanged_by_second_call &&
            stageAdapter.idempotency.work_item_ids_identical,
          `second call created ${adapterSecond.created}; queue ${queueRowsAfterFirst} → ${queueRowsAfterSecond}; ids identical ${String(stageAdapter.idempotency.work_item_ids_identical)}`,
        );
        check(
          'every judged verdict reached the outcome channel (or is refused by name)',
          verdicts.length === 0 || (outcomeRefusals.length === 0 && outcomeReached.length > 0),
          `${verdicts.length} verdict(s); ${outcomeReached.length} reached the store; ${outcomeRefusals.length} channel refusal(s); ` +
            `verification path ${consumedSeedId ? `used for ${consumedSeedId} (permitted=${String(execution?.permitted)})` : 'not used'}${outcomeRefusals.length > 0 ? ` — ${JSON.stringify(outcomeRefusals.slice(0, 3))}` : ''}`,
        );
        check(
          'the resume carries the promoted baton',
          section.status === 'included' && section.baton_id === baton.baton_id && section.promoted === true,
          `section ${section.status} / baton '${section.baton_id ?? '(none)'}' vs promoted '${baton.baton_id}' / code '${section.code}'`,
        );
        check(
          'the resume copies no prose field of this cycle’s candidates',
          leakedProse.length === 0,
          `${proseFields.length} prose field(s) searched; ${leakedProse.length} matched; section.prose_fields_omitted=${section.counts.prose_fields_omitted}`,
        );
        check(
          'the judged set was bounded',
          judgeCaseCount <= MAX_JUDGED_CANDIDATES,
          `${judgeCaseCount} case(s) judged, bound ${MAX_JUDGED_CANDIDATES}`,
        );

        // ── the AFTER counts, and the "nothing was deleted" reading ────────
        const afterCounts = await countMap(BEFORE_COLLECTIONS);
        const nonDecreasing = Object.keys(BEFORE_COLLECTIONS).every(
          (key) => Number(afterCounts[key] ?? 0) >= Number(beforeCounts[key] ?? 0),
        );
        const deltas = Object.fromEntries(
          Object.keys(BEFORE_COLLECTIONS).map((key) => [key, Number(afterCounts[key] ?? 0) - Number(beforeCounts[key] ?? 0)]),
        );

        // ── what this run wrote, and the filter behind every count ─────────
        const writtenFilters: Record<string, Record<string, unknown>> = {
          // Both cycle labels: the instrument's own stage-2 focused run is keyed
          // by IMAGINATION_LOOP_CYCLE, and the engine's cycle runs its own
          // consolidation under the DERIVED cycle id — the two rows are both
          // this run's, so both labels are counted.
          focused_consolidation_runs: { mission_id: missionId, cycle_id: { $in: [cycleLabel, cycleId] } },
          salience_traces: { mission_id: missionId, cycle_id: { $in: [cycleLabel, cycleId] } },
          imagination_cycles: { mission_id: missionId, cycle_id: cycleId },
          imagination_cycle_states: { user_id: user, mission_id: missionId },
          idea_seeds: { user_id: user, mission_id: missionId, ...(seedsFilter.includes('FALLBACK') ? {} : { cycle_id: cycleId }) },
          idea_archive_cells: { mission_id: missionId, $or: [{ created_cycle_id: cycleId }, { last_cycle_id: cycleId }] },
          creative_batons: { baton_id: baton.baton_id },
          creative_baton_promotions: { baton_id: baton.baton_id },
          idea_candidate_outcomes: { user_id: user, mission_id: missionId, seed_id: { $in: seedIds } },
          cognitive_work_items: {
            mission_id: missionId,
            work_item_id: { $in: adapterWorkItemIds.length > 0 ? adapterWorkItemIds : ['__none__'] },
          },
        };
        const written: Record<string, number> = Object.fromEntries(
          await Promise.all(
            Object.entries(writtenFilters).map(async ([key, filter]) => [key, await countOf(key, filter)]),
          ),
        );
        mark(
          'written summary',
          Object.entries(written)
            .map(([key, value]) => `${key}=${value}`)
            .join(', '),
        );

        // ── the capture ───────────────────────────────────────────────────
        const finishedAt = new Date().toISOString();
        const knob = (name: string): Row => ({
          value: process.env[name] ?? null,
          default: CEILING_DEFAULTS[name],
          unset: !(process.env[name] ?? '').trim(),
        });
        const modelEnvironment = Object.fromEntries(Object.keys(CEILING_DEFAULTS).map((name) => [name, knob(name)]));
        const unsetCeilings = Object.entries(modelEnvironment)
          .filter(([, entry]) => entry.unset)
          .map(([name]) => name);
        const elevatedConfig = {
          read_from:
            'THIS process\'s environment (the deployment\'s .env supplies the ceilings through the container; the ' +
            'instrument sets NO ceiling — it reads them, and the runner refuses a run whose ceilings are missing)',
          flags_set_in_this_process_only: {
            FOCUSED_IMAGINATION: '1',
            CREATIVE_BATON_PROMOTION: '1',
            note:
              'set in this file BEFORE the services were imported, for one process; the deployment runs with all four ' +
              'flags OFF, and nothing here changes any process\'s configuration',
          },
          raw: modelEnvironment,
          unset_ceilings: unsetCeilings,
          unset_warning:
            unsetCeilings.length === 0
              ? null
              : `${unsetCeilings.join(', ')} ${unsetCeilings.length === 1 ? 'is' : 'are'} UNSET in this process — the service's documented default is in force, and the estate's canonical model is a REASONING model that spends output tokens before its JSON, so a default-sized ceiling truncates the call (the A/B instrument measured exactly that). This run's reading is therefore a reading of the DEFAULTS for those knobs.`,
          effective: {
            focused_consolidation: {
              max_tokens: focusedConsolidationMaxTokens(),
              timeout_ms: focusedConsolidationTimeoutMs(),
            },
            focused_imagination: environmentBudget(),
            cycle: {
              cooldown_ms: cycleCooldownMs(),
              window_ms: cycleBudgetWindowMs(),
              max_cycles_per_window: maxCyclesPerWindow(),
              max_tokens_per_window: maxTokensPerWindow(),
              max_concurrent_cycles: maxConcurrentCycles(),
              candidate_floor: candidateFloor(),
            },
          },
        };

        const ideas = seeds
          .map((seed) => {
            const verdict = verdictBySeedId.get(String(seed.seed_id));
            const outcomeRow = outcomeRows.find((row) => String(row.seed_id) === String(seed.seed_id));
            return {
              seed_id: String(seed.seed_id),
              operator: String(seed.operator ?? ''),
              hypothesis: String(seed.hypothesis ?? ''),
              mechanism: String(seed.mechanism ?? ''),
              bins: { ...(seed.bins ?? {}) },
              descriptor_bins: (seed.descriptor_bins ?? []).map((bin: unknown) => String(bin)),
              scores: {
                novelty: Number(seed.novelty_score ?? 0),
                coherence: Number(seed.coherence_score ?? 0),
                testability: Number(seed.testability_score ?? 0),
                expected_information_gain: Number(seed.expected_information_gain ?? 0),
                quality: Number(seed.quality ?? 0),
              },
              cheapest_test: String(seed.cheapest_test ?? ''),
              state: String(seed.state ?? ''),
              cell_key: String(seed.cell_key ?? ''),
              quality: Number(seed.quality ?? 0),
              incumbent: Boolean(seed.incumbent),
              lineage_ref: String(seed.lineage_ref ?? ''),
              parent_seed_ids: (seed.parent_seed_ids ?? []).map((id: unknown) => String(id)),
              evidence_refs_count: (Array.isArray(seed.evidence_refs) ? seed.evidence_refs : []).length,
              created_at: seed.created_at ?? null,
              rejection: seed.rejection ?? null,
              outcome: verdict
                ? {
                    source: 'blinded judge, recorded through the outcome channel',
                    verdict: verdict.verdict,
                    case_id: verdict.case_id,
                    recorded: consumedSeedId === String(seed.seed_id) ? Boolean(execution?.permitted) : outcomeRow !== undefined,
                    row: outcomeRow
                      ? {
                          outcome_id: String(outcomeRow.outcome_id),
                          outcome: String(outcomeRow.outcome),
                          recorded_at: outcomeRow.recorded_at ?? null,
                        }
                      : null,
                  }
                : undefined,
            };
          })
          .sort((left, right) => left.seed_id.localeCompare(right.seed_id));

        const capture = {
          loop_version: LOOP_VERSION,
          run_token: run,
          mission: {
            mission_id: String(missionState.mission_id),
            title: String(missionState.title ?? ''),
            owner_id: String(missionState.owner_id ?? ''),
            shared_id: missionRow?.shared_id ?? null,
            status: String(missionState.status ?? ''),
            version_before: Number(missionState.version),
            version_after: Number((await missionService.getMissionState(missionId))?.version ?? missionState.version),
            authority_class: String(missionState.authority_class ?? ''),
            pre_existing: true,
            pre_existing_basis:
              'the instrument CREATED nothing: the mission state, its ledger, its deltas and its events were already in ' +
              `the store when the run started (${beforeCounts.epistemic_entries} ledger entr(ies), ` +
              `${beforeCounts.state_deltas} delta(s), ${beforeCounts.cognitive_work_items} work item(s) BEFORE the first write)`,
          },
          identity: {
            ran_as: user,
            caller: caller,
            mission_owner_id: String(missionState.owner_id ?? ''),
            matches_owner: String(missionState.owner_id ?? '') === user,
            note:
              'every service call below carried this caller; identity-scoped services refuse by name rather than write ' +
              'under another identity, and each refusal is quoted in its stage',
          },
          elevated_config: elevatedConfig,
          stages: {
            before: stageBefore,
            focused_consolidation: stageFocused,
            plateau: stagePlateau,
            cycle: stageCycle,
            verification: stageVerification,
            baton: stageBaton,
            controller_adapter: stageAdapter,
            outcome: stageOutcome,
            resume: stageResume,
          },
          ideas,
          baton: {
            baton_id: baton.baton_id,
            cycle_id: baton.cycle_id,
            mission_version: baton.mission_version,
            created_at: baton.created_at,
            stop_reason: baton.stop_reason ?? null,
            payload_hash: baton.payload_hash,
            privacy: baton.privacy ?? null,
            counts: baton.counts ?? null,
            attention_targets: stageBaton.attention_targets,
            excluded_region_fingerprints: stageBaton.excluded_regions,
            candidate_portfolio: stageBaton.candidate_portfolio,
            coverage_summary: baton.coverage_summary ?? null,
            promotion: stageBaton.promotion,
            promotion_audit_row: stageBaton.promotion_audit_row,
            shared_id: promotion.shared_id ?? (readerView?.shared_id ?? null),
            reader_view: stageBaton.reader_view,
          },
          work_items: stageAdapter.work_item_rows,
          written,
          written_filters: Object.fromEntries(Object.entries(writtenFilters).map(([key, filter]) => [key, JSON.stringify(filter)])),
          written_note:
            'counts are by the run\'s OWN ids (the cycle id, the cycle label, the baton id, this cycle\'s seed ids), not ' +
            'by timestamp: the mission is real and pre-existing, so a mission-wide count would not be this run\'s work. ' +
            '`focused_consolidation_runs` and `salience_traces` are counted under BOTH cycle labels — the instrument\'s ' +
            'own stage-2 run (`IMAGINATION_LOOP_CYCLE`) and the engine\'s cycle, which runs its own consolidation under ' +
            'the DERIVED cycle id. `imagination_cycle_states` is ONE upserted row (the window/cooldown ledger) and ' +
            '`idea_archive_cells` are UPSERTS keyed by cell — "written" there means "touched by this cycle". ' +
            'NOTHING was deleted.',
          checks,
          after_counts: { counts: afterCounts, deltas, non_decreasing: nonDecreasing },
          disclosure: [
            `LIVE STORE: a real MongoDB (database '${db.databaseName}') on host ${hostname()}. The mission (${missionId}) is REAL and PRE-EXISTING — it was created before this run and carries its own history (${beforeCounts.epistemic_entries} epistemic entr(ies), ${beforeCounts.state_deltas} state delta(s), ${beforeCounts.cognitive_work_items} work item(s) at the start). This run's rows are ADDITIVE and are listed in \`written\` with the filter behind every count.`,
            `LIVE MODEL: ${model.provider}/${model.model} (providers: ${model.providers.join(', ')}) produced the salience trace, every idea candidate, and — as the blinded judge — every verdict recorded here.`,
            'FLAGS IN THE INSTRUMENT PROCESS ONLY: FOCUSED_IMAGINATION=1 and CREATIVE_BATON_PROMOTION=1 were set by this file BEFORE the services were imported, for the length of this one process. The DEPLOYMENT KEEPS ALL FOUR FLAGS OFF; nothing this run writes changes any process\'s configuration, and no flag was read from the deployment.',
            `CEILINGS FROM THE DEPLOYMENT'S ENV: the engine's knobs were READ from the process environment the deployment supplies (raw value + documented default + effective accessor value in \`elevated_config\`). The instrument sets no ceiling${unsetCeilings.length > 0 ? `; ${unsetCeilings.join(', ')} were UNSET in this process, so their DEFAULTS were in force — see \`elevated_config.unset_warning\`` : ''}. A runner that refuses a run whose ceilings are missing is what keeps this reading comparable to the A/B instrument's.`,
            `BLINDED JUDGE, DISCLOSED: the judged set is this cycle's admitted candidates, blinded by \`blindCases\` into {hypothesis, mechanism, cheapest_test, evidence_refs, descriptor_bins} under opaque case ids from a seeded shuffle (seed ${DEFAULT_SHUFFLE_SEED}, structure and mapping recorded). The judge is a LANGUAGE MODEL (${judgeModel}) — a model judging model-written text, so self-preference is a property of the instrument and not a bug; the frozen system prompt's sha256 is ${judgePromptSha256()}, the user prompt's sha256 and every raw reply are in \`stages.verification.judge\`, and every call's token usage is recorded, so the reading can be re-scored by another judge or by a person. The judge is a model, and it can be wrong.`,
            `NOTHING WAS DELETED: no document was deleted, dropped, overwritten or migrated. Every row this run added is named in \`written\` together with the filter that counted it (upserts are called out: \`imagination_cycle_states\` is one updated row, \`idea_archive_cells\` are upserts keyed by cell). The mission-scoped counts before and after the run are both in this capture, and every one of them is non-decreasing: ${nonDecreasing}.`,
            `THE PROMOTION WROTE INTO THE MISSION'S OWN SHARED SCOPE: promoteCreativeBaton resolved shared_id '${promotion.shared_id ?? '(none)'}' (the mission's own team scope, '${missionRow?.shared_id ?? 'unknown'}'), and the baton row plus its \`creative_baton_promotions\` audit row carry it — the baton is TEAM-VISIBLE, and the candidates it carries are the mission's own ideas, not a disposable sandbox's.`,
            `WHERE THE CONTROL WENT: the loop's last step put the baton's candidates into the mission's OWN controller queue (${adapterFirst.created} baton-derived item(s), ${adapterFirst.funnel_derived_added} the funnel derived from mission state). Those work items are real work the mission will now be asked to do; the adapter is idempotent, so a second pass added nothing (second call created ${adapterSecond.created}).`,
            `WHAT THIS DOES NOT SHOW: this is ONE bounded cycle on ONE mission run from THIS process (the services ran in-process — no container executed the engine), not a distribution and not a fleet reading. The judge is a model. The gate: ${stageCycle.gate_note}`,
            `ARTEFACTS: capture ${config.out}; progress log ${progressPath} (written as the run happened, so a failed run still says how far it got).`,
          ],
          run: {
            instrument: DRIVER,
            started_at: startedAt,
            finished_at: finishedAt,
            host: hostname(),
            store: {
              kind: 'mongodb',
              database: db.databaseName,
              connection: 'src/database/connection.ts connect_to_mongodb()',
            },
            model: {
              provider: model.provider,
              model: model.model,
              providers: model.providers,
              availability_waited_ms: model.waited_ms,
            },
            judge_model: judgeModel,
            cycle_label: cycleLabel,
            cycle_id: cycleId,
            gate_bypassed_by_override: overrideRun !== null,
            force_requested: config.force,
            pipeline,
            progress_log: progressPath,
            regenerate: `IMAGINATION_LOOP_LIVE=1 IMAGINATION_LOOP_USER=${user} IMAGINATION_LOOP_MISSION=${missionId} IMAGINATION_LOOP_RUN=<new token> IMAGINATION_LOOP_OUT=<path> npx vitest run tests/live/imagination-loop-live.test.ts`,
            not_verified: `one bounded run under one run token, on one mission, at ${finishedAt}; the judged set was this cycle's own candidates and the judge is a model — see the disclosure.`,
          },
        };

        // ── write the capture, then assert it is readable ─────────────────
        const parent = path.dirname(config.out);
        if (parent && parent !== '.' && !existsSync(parent)) mkdirSync(parent, { recursive: true });
        writeFileSync(config.out, `${JSON.stringify(capture, null, 2)}\n`);

        const reread = JSON.parse(readFileSync(config.out, 'utf8'));
        expect(reread.loop_version).toBe(LOOP_VERSION);
        expect(reread.run_token).toBe(run);
        expect(reread.stages.cycle.cycle_id).toBe(cycleId);
        expect(reread.stages.baton.baton_id).toBe(baton.baton_id);
        expect(reread.disclosure.length).toBeGreaterThanOrEqual(6);
        expect(existsSync(progressPath)).toBe(true);
        // The invariants themselves: every check must hold. They are asserted
        // AFTER the capture is on disk, so a failing check still leaves the
        // whole run's evidence behind instead of dying with the process.
        for (const entry of checks) {
          expect(entry.ok, `${entry.name} — ${entry.detail}`).toBe(true);
        }

        console.log(
          [
            '',
            '── imagination loop: BOUNDED LIVE RUN complete ──────────────────────────',
            `   store      ${db.databaseName} · model ${model.provider}/${model.model} · judge ${judgeModel}`,
            `   mission    ${missionId} (owner ${missionState.owner_id}, authority ${missionState.authority_class}) · run ${run}`,
            `   cycle      ${cycleId} — stop '${cycle.stop_reason}'${overrideRun ? ' (GATE BYPASSED BY EXPLICIT OVERRIDE)' : ''}`,
            `   ideas      ${seeds.length} row(s) (${admitted.length} admitted, ${rejected.length} rejected) · judged ${judgeCaseCount} · verdicts ${verdicts.length}`,
            `   baton      ${baton.baton_id} — promotion ${promotion.promoted ? 'promoted' : 'REFUSED'}${promotion.reused ? ' (reused)' : ''} shared '${promotion.shared_id ?? 'none'}'`,
            `   work items ${adapterFirst.created} created, ${adapterSecond.created} on the idempotent second pass`,
            `   resume     ${section.status} (code '${section.code}'), prose fields omitted ${section.counts.prose_fields_omitted}`,
            `   capture    ${config.out}`,
            `   progress   ${progressPath}`,
            '────────────────────────────────────────────────────────────────────────',
            '',
          ].join('\n'),
        );
      } finally {
        await connection.close_connection().catch((error) => console.error(`loop driver: close failed — ${messageOf(error)}`));
      }
    },
  );
});
