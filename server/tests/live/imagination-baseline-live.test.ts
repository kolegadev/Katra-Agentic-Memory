/**
 * ITER-11, WS-4 — DoD bullet 8: the BOUNDED LIVE RUN.
 *
 * The frozen checkpoint (`tests/unit/imagination-baseline-fixture.test.ts`) cannot
 * answer the brief's DoD bullet 8 — "the engine's useful novelty rate is ≥30%
 * better than the pre-engine path" — because its idea TEXT is a scripted
 * template's and nothing judged the ideas. This file is the instrument that
 * closes it: one bounded run of the SAME four arms on a REAL store with a REAL
 * model, judged BLIND by a model, captured in the shape the harness
 * (`server/scripts/imagination-baseline.mjs`) already measures.
 *
 * IT RUNS NOTHING UNLESS ASKED. With `IMAGINATION_BASELINE_LIVE` unset the whole
 * file skips (and says why in the run output). This is deliberate: importing
 * this file in a normal test run must not open a connection or spend a token.
 *
 *   npx vitest run tests/live/imagination-baseline-live.test.ts     # → skipped
 *
 * ── WHAT IT IS, STATEMENT BY STATEMENT ─────────────────────────────────────
 *
 * NO MOCKS. There is no FakeDb, no `vi.mock` of `src/database/connection.js` and
 * none of `llmService`: the driver calls the REAL `connect_to_mongodb()` and the
 * REAL `llmService`, and it refuses to start if the model is not available
 * (naming the status it saw). Every row it writes goes into the deployment's own
 * collections.
 *
 * THE FLAGS LIVE IN THIS PROCESS ONLY. `FOCUSED_IMAGINATION`,
 * `CREATIVE_BATON_PROMOTION` and `COGNITIVE_TEAM_ALLOCATION` are set here, in
 * this file's module body, BEFORE the services are imported (every `src` import
 * below is a dynamic `await import()` inside the test, so nothing loads before
 * the flags are set). The deployment these arms are measured on runs with all
 * four flags OFF — the instrument is what turns them on, for one process, and
 * the capture's disclosure says so in those words.
 *
 * THE RUN IS NAMESPACED. `IMAGINATION_BASELINE_RUN` is suffixed onto every
 * mission id and onto every identity this run writes, so nothing it does can
 * collide with, exclude or contaminate real data:
 *
 *   missions   `${CONTROL_MISSION_A}_<run>`, `${CONTROL_MISSION_B}_<run>`,
 *              `${SCENARIO_MISSION}_<run>` (arm C), `${SCENARIO_MISSION}_<run>_team` (arm D)
 *   identities `<user>-<run>-control` (A/B), `<user>-<run>-engine` (C, and D's
 *              parent), `<user>-<run>-team-1..3` (D's three agents) — every one
 *              carries the run token, so no two runs share a unique key
 *
 * A run token that already has a mission in the store is REFUSED by name — this
 * instrument never reuses or overwrites a run — so the same token cannot
 * silently stack a second run on the first.
 *
 * IT IS BOUNDED. `IMAGINATION_BASELINE_MAX_CANDIDATES` (default 40) caps how many
 * candidates may be judged: the driver counts them BEFORE the first judge call
 * and refuses by name if the run would exceed the bound. The judge's calls are
 * batched (`JUDGE_BATCH_SIZE` cases per call) and every call's token usage is
 * recorded. Nothing is deleted — the capture carries a `written` summary
 * (collection → count) so the rows can be cleaned up afterwards, deliberately,
 * by a person.
 *
 * THE JUDGE IS BLIND, AND ITS BLINDNESS IS DISCLOSED. Cases are the payloads
 * `blindCases` builds (five fields, opaque ids, seeded shuffle) and the judge
 * only ever sees those. The residual risk — a model judging model-written text
 * more kindly than template text — is a property of the instrument, not a bug:
 * the prompt is exported verbatim and hashed, the shuffle seed is recorded, and
 * every raw reply is written to the transcript next to the mapping, so a reader
 * can re-score the run from the transcript alone. The capture says exactly that.
 *
 * WHAT IT DOES NOT DO. It does not execute the engine in a container (the
 * services run in THIS process), it promotes nothing beyond what the shipped
 * promotion step does inside arm C's cycle, it writes no experiments row (that is
 * the harness's job: `node scripts/imagination-baseline.mjs --fixture <capture>
 * --grade <grades>`), and it cannot be run from a development machine against
 * production without naming that store in the environment.
 *
 * THE CAPTURE IS AN OPERATIONAL ARTEFACT, NOT REPO CONTENT: it carries the run's
 * host name, the model id and the store's database name. Write it outside the
 * repository (the repo's `AGENTS.md` forbids deployment data in tracked files).
 *
 * ── HOW TO RUN IT (on the deployment host) ────────────────────────────────
 *
 *   cd server
 *   export IMAGINATION_BASELINE_LIVE=1 \
 *          IMAGINATION_BASELINE_USER=<identity> \
 *          IMAGINATION_BASELINE_RUN=run-$(date -u +%Y%m%d-%H%M%S) \
 *          IMAGINATION_BASELINE_OUT=/tmp/imagination-baseline-live.json \
 *          IMAGINATION_BASELINE_JUDGE=<judge model id>        # optional override
 *   npx vitest run tests/live/imagination-baseline-live.test.ts
 *
 *   node scripts/imagination-baseline.mjs \
 *     --fixture /tmp/imagination-baseline-live.json \
 *     --store   /tmp/imagination-baseline-live-STORE.json \
 *     --grade   /tmp/imagination-baseline-live-GRADES.json
 */
import { describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

import type { Db } from 'mongodb';

import {
  DEFAULT_MAX_CANDIDATES,
  JUDGE_BATCH_SIZE,
  JUDGE_SYSTEM_PROMPT,
  blindCases,
  defaultGradesPath,
  defaultTranscriptPath,
  gradesFromVerdicts,
  judgePrompt,
  judgePromptSha256,
  liveRunConfigFromEnv,
  parseJudgeReply,
  type BlindCase,
  type CaseMapping,
  type JudgeArmInput,
  type JudgeCandidateInput,
} from '../helpers/imagination-blind-judge.js';
// The ONLY import of a src-adjacent module at load time: `fake-mongo.js` is a
// test double for types only (never constructed here — this file uses no FakeDb).
import type { FakeDb } from '../helpers/fake-mongo.js';

/** The instrument, as the capture names it. */
const DRIVER = 'server/tests/live/imagination-baseline-live.test.ts (the live driver)';

const LIVE = process.env.IMAGINATION_BASELINE_LIVE === '1';

// ── The flags, IN THIS PROCESS ONLY, before any service is imported ────────
//
// The module body runs before the test's dynamic imports, so the services first
// see these values already set. They are what the DEPLOYMENT does not have: the
// observability page states the rollout runs with the flags off, and this
// instrument is the only thing that turns them on.
if (LIVE) {
  process.env.FOCUSED_IMAGINATION = '1';
  process.env.CREATIVE_BATON_PROMOTION = '1';
  process.env.COGNITIVE_TEAM_ALLOCATION = '1';
}

const SKIP_REASON =
  'IMAGINATION_BASELINE_LIVE is not set to 1 — this file is the LIVE instrument (real MongoDB, real model, ' +
  'flags turned on in-process); it is skipped so that a normal test run neither connects to a store nor spends a token. ' +
  'See the file header for the command line.';

if (!LIVE) console.log(`[imagination-baseline-live] SKIPPED: ${SKIP_REASON}`);

// ── The live store, in the shape the capture/evidence helpers read ─────────

type Row = Record<string, any>;

/**
 * The bridge between the REAL `Db` and the capture/evidence helpers.
 *
 * The helpers were written against `FakeDb` — they read `collection(name).docs`,
 * a synchronous in-memory array, and they push rows into it (`seedScenario`
 * writes the scenario's work item and knowledge graph that way). They must now
 * run against a real store WITHOUT a second copy of their logic, so this class
 * presents exactly that shape while every service call goes to the real handle
 * (`asDb()`):
 *
 *   `refresh(specs)`  reads the real rows for the named collections into memory
 *                     (with the caller's FILTER, so a live store's unrelated
 *                     rows are never dragged in) — and flushes any row a helper
 *                     appended first, so nothing is lost;
 *   `collection(x)`   the FakeDb-shaped `{docs}` the helpers read and push to;
 *   `asDb()`          the real `Db` the services run on;
 *   `flush()`         inserts whatever a helper appended (`insertMany`).
 *
 * There is no hidden caching across the run: a `refresh` REPLACES a collection's
 * rows, and the driver refreshes immediately before every helper that reads.
 */
class LiveCaptureStore {
  private readonly cache = new Map<string, { rows: Row[]; inserted: number }>();

  constructor(private readonly db: Db) {}

  private entry(name: string): { rows: Row[]; inserted: number } {
    const existing = this.cache.get(name);
    if (existing) return existing;
    const created = { rows: [] as Row[], inserted: 0 };
    this.cache.set(name, created);
    return created;
  }

  /** Read the real rows for these collections into memory (flushing first). */
  async refresh(specs: Array<{ collection: string; filter?: Record<string, unknown> }>): Promise<void> {
    await this.flush();
    for (const spec of specs) {
      const rows = (await this.db
        .collection(spec.collection)
        .find(spec.filter ?? {}, { projection: { _id: 0 } })
        .toArray()) as Row[];
      this.cache.set(spec.collection, { rows, inserted: rows.length });
    }
  }

  /** The FakeDb-shaped collection handle the capture/evidence helpers read. */
  collection(name: string): { docs: Row[] } {
    return { docs: this.entry(name).rows };
  }

  /** The real handle: every service runs on this, never on the snapshot. */
  asDb(): Db {
    return this.db;
  }

  /** The same object, typed the way the shared helpers declare their store. */
  asFakeDb(): FakeDb {
    return this as unknown as FakeDb;
  }

  /** Insert every row a helper appended since the last read. */
  async flush(): Promise<void> {
    for (const [name, entry] of this.cache) {
      if (entry.rows.length <= entry.inserted) continue;
      const fresh = entry.rows.slice(entry.inserted) as Array<Record<string, unknown>>;
      if (fresh.length > 0) await this.db.collection(name).insertMany(fresh as never[]);
      entry.inserted = entry.rows.length;
    }
  }
}

/** The collections the run writes, for the capture's clean-up summary. */
const WRITTEN_COLLECTIONS = [
  'mission_states',
  'mission_state_versions',
  'epistemic_entries',
  'state_deltas',
  'cognitive_work_items',
  'mission_events',
  'trigger_evaluations',
  'knowledge_nodes',
  'knowledge_relationships',
  'salience_traces',
  'focused_consolidation_runs',
  'imagination_cycles',
  'imagination_cycle_states',
  'imagination_runs',
  'idea_seeds',
  'idea_lineages',
  'idea_archive_cells',
  'idea_candidate_outcomes',
  'creative_batons',
  'creative_baton_promotions',
  'cognitive_portfolios',
  'inheritance_envelopes',
  'thinking_mode_assignments',
];

/** The judge's max_tokens for a batch: the shape it must return, plus headroom. */
function judgeMaxTokens(cases: number): number {
  const override = Number(process.env.IMAGINATION_BASELINE_JUDGE_MAX_TOKENS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  // The estate's canonical model is a REASONING model: it spends output tokens
  // on its own reasoning before the JSON, so a ceiling sized for the JSON alone
  // truncates the batch (observed live: a truncated array is a malformed reply,
  // which the parser refuses rather than partially accepting). The ceiling is
  // therefore per case and generous; 16 000 is the provider's accepted maximum.
  return Math.min(16000, 3000 + 1000 * cases);
}

function messageOf(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error);
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

describe.skipIf(!LIVE)('imagination baseline — the bounded LIVE run (DoD #8)', () => {
  it(
    'runs the four arms on a real store with a real model, judges them blind, and writes the capture',
    { timeout: 30 * 60 * 1000 },
    async () => {
      const configResult = liveRunConfigFromEnv(process.env);
      if (!configResult.ok) throw new Error(configResult.reason);
      const config = configResult.config;

      const run = config.run;
      const user = config.user;
      // Every sandbox identity carries the RUN TOKEN, not just the missions: the
      // archive keys its seeds by identity (a comparator's candidate ids are the
      // scenario's own, `control_a_01`…), so two runs sharing an identity collide
      // on `admitOrReplace`'s "already stored" rule and the second run cannot
      // even start its control arms. A run-scoped identity keeps each run's rows
      // its own, and makes the clean-up summary exact.
      const controlIdentity = `${user}-${run}-control`;
      const engineIdentity = `${user}-${run}-engine`;
      const teamIdentities = [1, 2, 3].map((index) => `${user}-${run}-team-${index}`);
      const teamModes = ['philosopher', 'analyst', 'strategist'];
      const runIdentities = [controlIdentity, engineIdentity, ...teamIdentities];
      const caller = { user_id: user, trusted: true };

      const startedAt = new Date().toISOString();

      // ── the services, imported AFTER the flags are set (see the header) ────
      const connection = await import('../../src/database/connection.js');
      const { llmService } = await import('../../src/services/infrastructure/llm-service.js');
      const { usageDeltaSince, usageSnapshot } = await import('../../src/services/infrastructure/llm-usage-ledger.js');
      const { runImaginationCycle } = await import('../../src/services/processing/imagination-cycle-service.js');
      const { recordCandidateOutcome } = await import('../../src/services/processing/imagination-outcome-service.js');
      const { planFirstPass, runFirstPass } = await import('../../src/services/processing/independent-first-pass.js');
      const { createInheritanceEnvelope } = await import('../../src/services/processing/inheritance-envelope.js');
      const { runFocusedConsolidation } = await import('../../src/services/processing/focused-consolidation-service.js');
      const { normalizeBins, possibleCellCount } = await import('../../src/services/processing/idea-archive-service.js');
      const { CREATIVE_BATON_COLLECTIONS } = await import(
        '../../src/services/processing/creative-baton-collections.js'
      );
      const { COGNITIVE_TEAM_COLLECTIONS } = await import(
        '../../src/services/processing/cognitive-team-collections.js'
      );
      const { COLLECTIONS } = await import('../../src/services/mission-cognition/collections.js');
      const {
        CONTROL_MISSION_A,
        CONTROL_MISSION_B,
        baselineMaterial,
        captureControlArm,
        controlCandidatesA,
        controlCandidatesB,
        outcomesFor,
        plateauEvidence,
        seedRows,
        setCaptureDb,
        taintEvidence,
      } = await import('../helpers/imagination-baseline-capture.js');
      type ControlCandidate = import('../helpers/imagination-baseline-capture.js').ControlCandidate;
      const { SCENARIO_MISSION, seedScenario } = await import('../helpers/imagination-scenario.js');

      const missions = {
        A: `${CONTROL_MISSION_A}_${run}`,
        B: `${CONTROL_MISSION_B}_${run}`,
        C: `${SCENARIO_MISSION}_${run}`,
        D: `${SCENARIO_MISSION}_${run}_team`,
      };
      const allMissions = Object.values(missions);

      // ── the real store ────────────────────────────────────────────────────
      let db: Db | null = null;
      try {
        db = await connection.connect_to_mongodb();
        if (!db && connection.is_database_connected()) db = connection.get_database();
      } catch (error) {
        throw new Error(
          `the live run is REFUSED: the store could not be reached — ${messageOf(error)} (MONGODB_URI / DATABASE_NAME ` +
            'must name the store this instrument is allowed to write to)',
        );
      }
      if (!db) {
        throw new Error(
          'the live run is REFUSED: connect_to_mongodb() returned no database — MONGODB_URI (and DATABASE_NAME) must ' +
            'name the store this instrument is allowed to write to',
        );
      }
      if (!connection.is_database_connected()) {
        throw new Error('the live run is REFUSED: the connection reports it is not connected');
      }

      // ── the real model, named and required ────────────────────────────────
      const model = await waitForModel(llmService, 120_000);
      if (!model.available) {
        throw new Error(
          `the live run is REFUSED: llmService.getServiceStatus().available is false — ` +
            `${JSON.stringify({ provider: model.provider, model: model.model, providers: model.providers, waited_ms: model.waited_ms })}. ` +
            'The judge and the treatment arms both need the real provider; run this in a process whose LLM configuration ' +
            'is applied (env keys or reconfigure_from_db), or fix the provider before re-running.',
        );
      }

      const store = new LiveCaptureStore(db);
      setCaptureDb(store.asFakeDb());
      const pipeline: Array<{ step: string; at: string; detail?: string }> = [];
      // A live run takes minutes and can fail at any step: the marks go to the
      // progress file (and to stderr) the MOMENT they happen, so a failed run
      // still says exactly how far it got — the capture itself is only written
      // on success, and an in-memory trail dies with the process.
      const progressPath = `${config.out}.progress.log`;
      const mark = (step: string, detail?: string): void => {
        const entry = { step, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
        pipeline.push(entry);
        const line = `${entry.at} ${step}${detail ? ` — ${detail}` : ''}`;
        console.error(`[live] ${line}`);
        try {
          mkdirSync(path.dirname(progressPath), { recursive: true });
          appendFileSync(progressPath, `${line}\n`);
        } catch (error) {
          console.error(`[live] the progress file could not be appended: ${messageOf(error)}`);
        }
      };

      let finishedAt = new Date().toISOString();
      try {
        // ── the run token must be fresh ─────────────────────────────────────
        const used = (await db
          .collection(COLLECTIONS.missionStates)
          .find({ mission_id: { $in: allMissions } }, { projection: { _id: 0, mission_id: 1 } })
          .toArray()) as Array<{ mission_id?: string }>;
        if (used.length > 0) {
          throw new Error(
            `the live run is REFUSED: run token '${run}' has already been used — mission(s) ` +
              `${used.map((row) => String(row.mission_id)).sort().join(', ')} exist in this store. Pick a fresh ` +
              'IMAGINATION_BASELINE_RUN; this instrument never reuses or overwrites a run’s rows',
          );
        }

        // ── the checkpoint material: the frozen scenario, re-seeded live ────
        //
        // Two scenarios, because the treatment arms run on their own missions
        // (as the fixture does): C's engine mission and D's team mission. Arms A
        // The graph is seeded ONCE, under the run's own id prefix: the store's
        // `from_to_type` index on knowledge_relationships is GLOBAL, so a second
        // seeding of the scenario's fixed ids (`node_a -> node_b`) collides with
        // this run's own first seeding, and with any earlier run's. The fixture
        // seeds the same graph twice and de-duplicates by id; here the second
        // seeding skips the graph (`graph: false`) so the material is the SAME
        // four nodes and four edges the frozen checkpoint walks, under ids that
        // belong to this run alone. Arms A and B are the pre-engine comparators —
        // they have no cycle service and no mission state to read, they only
        // write candidates through the archive — so the D mission needs none, and
        // both treatment missions walk the ONE material the C mission produced.
        const graphPrefix = `${config.run}-`;
        await seedScenario(store.asFakeDb(), {
          ownerId: engineIdentity,
          missionId: missions.C,
          idPrefix: graphPrefix,
        });
        await seedScenario(store.asFakeDb(), { ownerId: engineIdentity, missionId: missions.D, graph: false });
        await store.refresh([
          { collection: 'knowledge_nodes', filter: { user_id: { $in: runIdentities } } },
          { collection: 'knowledge_relationships', filter: { user_id: { $in: runIdentities } } },
        ]);
        const material = baselineMaterial();
        mark('scenarios seeded', `missions ${missions.C} + ${missions.D} (owner ${engineIdentity}); graph rows read back for the run's identities only`);

        // The archive's `is_seed_unique` index is on `seed_id` ALONE — a GLOBAL
        // key, not per identity and not per mission — and the comparators'
        // candidate ids are the frozen scenario's own (`control_a_01`…), so two
        // runs would collide on the second run's first candidate. Each run
        // namespaces its comparator ids with its run token; the treatment arms'
        // seed ids already derive from the run's mission id, so the whole run is
        // unique under every index the store enforces.
        const runScoped = (candidates: ControlCandidate[]): ControlCandidate[] =>
          candidates.map((candidate) => ({ ...candidate, seed_id: `${config.run}:${candidate.seed_id}` }));

        // ── arm A and arm B: the pre-engine comparators, through the archive ─
        const armA = await captureControlArm({
          label: 'A',
          name: 'control_dreamer_retrieval',
          path: 'pre-engine dreamer-style retrieval',
          retrieval: 'concepts ranked by graph degree (prominence)',
          missionId: missions.A,
          candidates: runScoped(controlCandidatesA(material)),
          triggerAt: startedAt,
          identity: controlIdentity,
          decidedBy: DRIVER,
          declaredBy: DRIVER,
        });
        const armB = await captureControlArm({
          label: 'B',
          name: 'control_mind_wander',
          path: 'pre-engine mind-wander over the graph',
          retrieval:
            'walk steps from the mission’s edges; both directions of every step are emitted, exactly as an undeduped wander does',
          missionId: missions.B,
          candidates: runScoped(controlCandidatesB(material)),
          triggerAt: startedAt,
          identity: controlIdentity,
          decidedBy: DRIVER,
          declaredBy: DRIVER,
        });
        mark('arms A/B admitted', `${missions.A} + ${missions.B} under ${controlIdentity}`);

        // ── arm C: the focused engine, ONE identity, plateau gate bypassed ──
        const cycleUsageBefore = usageSnapshot();
        const cycle = await runImaginationCycle(db, {
          userId: engineIdentity,
          missionId: missions.C,
          actorId: engineIdentity,
          caller,
          // The documented bypass. The mission was seeded moments ago from the
          // frozen scenario, so no plateau has accumulated and the gate would
          // refuse a cycle — this is a BOUNDED EVALUATION, and the arm's
          // config.cycle_trigger says so in those words.
          force: true,
        });
        if (cycle.status !== 'ran') {
          throw new Error(
            `arm C is REFUSED by the engine: the bounded cycle did not run — status '${cycle.status}' / reason ` +
              `'${cycle.reason ?? 'none'}'${cycle.error ? ` / error '${cycle.error}'` : ''}`,
          );
        }
        const cycleUsage = usageDeltaSince(cycleUsageBefore);
        await store.refresh([
          { collection: 'idea_seeds', filter: { mission_id: missions.C } },
          { collection: CREATIVE_BATON_COLLECTIONS.cycles, filter: { mission_id: missions.C } },
        ]);
        const rowsC = seedRows(cycle.cycle_id!);
        const cycleRow = store
          .collection(CREATIVE_BATON_COLLECTIONS.cycles)
          .docs.find((row) => row.cycle_id === cycle.cycle_id) as Row;
        const cycleCoverage = (cycleRow?.coverage ?? {}) as Row;
        mark('arm C cycle ran', `cycle ${cycle.cycle_id} (${rowsC.length} seed row(s))`);

        // ── arm D: the engine plus the heterogeneous team ───────────────────
        const team: Array<{ identity: string; mode: string; envelope_id: string }> = [];
        for (const [index, identity] of teamIdentities.entries()) {
          const mode = teamModes[index];
          const focused = await runFocusedConsolidation(db, {
            userId: identity,
            missionId: missions.D,
            cycleId: `live_team_trace:${missions.D}:${identity}`,
            actorId: identity,
          });
          if (focused.status !== 'completed') {
            throw new Error(`arm D is REFUSED: the focused run for ${identity} returned '${focused.status}'`);
          }
          const envelope = await createInheritanceEnvelope(db, {
            parentUserId: engineIdentity,
            missionId: missions.D,
            childLabel: identity,
            mode,
            caller,
          });
          team.push({ identity, mode, envelope_id: envelope.envelope.envelope_id });
        }
        // THE TRIGGER IS STAMPED BEFORE THE PASS STARTS: the harness refuses a
        // self-stamped 0 ms window, so this instant must predate the pass's first
        // admitted row — which it does, because the pass has not started yet.
        const triggerAtD = new Date().toISOString();
        const passUsageBefore = usageSnapshot();
        const planned = await planFirstPass(db, { userId: engineIdentity, missionId: missions.D, team, caller });
        if (!planned.pass.requests.every((request) => request.status === 'ready')) {
          throw new Error(
            `arm D is REFUSED: ${planned.pass.requests.filter((request) => request.status !== 'ready').length} of ` +
              `${planned.pass.requests.length} request(s) were not ready — ` +
              planned.pass.requests.map((request) => `${request.agent.identity}:${request.status}${request.blocked_reason ? `(${request.blocked_reason})` : ''}`).join(', '),
          );
        }
        const ran = await runFirstPass(db, { userId: engineIdentity, missionId: missions.D, team, caller });
        const passUsage = usageDeltaSince(passUsageBefore);
        await store.refresh([{ collection: 'idea_seeds', filter: { mission_id: missions.D } }]);
        const admittedD = store
          .collection('idea_seeds')
          .docs.filter((row) => row.state === 'admitted')
          .sort((left, right) => String(left.seed_id).localeCompare(String(right.seed_id)));
        const rowsD = admittedD.map((row) => ({
          seed_id: String(row.seed_id),
          agent: String(row.user_id),
          operator: String(row.operator),
          hypothesis: String(row.hypothesis),
          descriptor_bins: normalizeBins(row.descriptor_bins ?? []).bins,
          cell_key: String(row.cell_key),
          novelty_score: Number(row.novelty_score),
          coherence_score: Number(row.coherence_score),
          testability_score: Number(row.testability_score),
          expected_information_gain: Number(row.expected_information_gain),
          cheapest_test: String(row.cheapest_test),
          quality: Number(row.quality),
          state: 'admitted',
          rejection_reason: null,
          created_at: String(row.created_at),
          privacy_safe: true,
        }));
        const teamRejections = ran.results.flatMap((result) =>
          result.rejections.map((rejection) => ({ seed_id: String(rejection.seed_id), reason: String(rejection.reason) })),
        );
        mark('arm D first pass ran', `pass ${ran.pass.pass_id}, 3 identities, trigger stamped at ${triggerAtD} (before the pass)`);

        // ── the four arms, in the capture's shape ──────────────────────────
        const armC: Row = {
          label: 'C',
          name: 'focused_engine_balanced',
          kind: 'treatment',
          config: {
            flag: 'FOCUSED_IMAGINATION=1 — set IN THIS PROCESS ONLY by the live instrument (the deployment runs it off)',
            identities: [engineIdentity],
            mode: 'balanced',
            candidate_promotion:
              'CREATIVE_BATON_PROMOTION=1 — set IN THIS PROCESS ONLY by the live instrument (the deployment runs it off)',
            cycle_trigger:
              'BOUNDED EVALUATION: runImaginationCycle({ force: true }) — the documented RunCycleArgs.force override of ' +
              'the PLATEAU gate only. The mission was seeded from the frozen scenario seconds earlier, so no plateau had ' +
              'accumulated; the bypass is what makes this a single bounded run instead of a wait for a plateau trigger',
            caller: `${user} (trusted)`,
          },
          admission_rule: {
            path: 'shipped_archive',
            service: 'IdeaArchiveService.admitOrReplace',
            decided_by: 'the imagination engine, inside runImaginationCycle on the live store',
            identity: engineIdentity,
            mission_id: missions.C,
            same_rule_as: ['A', 'B', 'C', 'D'],
            text_is_scripted: false,
            text_basis: `the real model (${model.provider}/${model.model}) generated every candidate's text`,
          },
          generation: {
            path: 'real_services',
            captured_from: 'runImaginationCycle + recordCandidateOutcome on the live store',
            determination: 'store_measured',
            note: 'every row is the real engine’s own; the model is real, the store is real, and the outcomes are the judge’s verdicts recorded through the shipped outcome channel',
          },
          trigger_at: String(cycleRow?.created_at ?? ''),
          cycle_id: cycle.cycle_id,
          tokens: Number(
            cycle.budget?.tokens_spent_this_cycle ?? cycleUsage.input_tokens + cycleUsage.output_tokens,
          ),
          counts: {
            generated: Number(cycleRow?.counts?.seeds_generated ?? rowsC.length),
            admitted: Number(cycleRow?.counts?.seeds_admitted ?? rowsC.filter((row) => row.state === 'admitted').length),
            rejected: Number(
              cycleRow?.counts?.seeds_rejected ?? rowsC.filter((row) => row.state === 'rejected').length,
            ),
            below_incumbent: Number(cycleRow?.counts?.seeds_below_incumbent ?? 0),
          },
          coverage: {
            cells_total: Number(cycleCoverage.cells_total ?? 0),
            new_cells_this_cycle: Number(cycleCoverage.new_cells_this_cycle ?? 0),
            possible_cells: Number(cycleCoverage.occupancy?.possible ?? 0),
            occupancy_ratio: Number(cycleCoverage.occupancy?.ratio ?? 0),
          },
          rows: rowsC,
          rejections: rowsC
            .filter((row) => row.state === 'rejected')
            .map((row) => ({ seed_id: String(row.seed_id), reason: String(row.rejection_reason ?? 'rejected') })),
          outcomes: null as unknown,
          plateau: null as unknown,
          taint: null as unknown,
        };

        const armD: Row = {
          label: 'D',
          name: 'engine_plus_heterogeneous_team',
          kind: 'treatment',
          config: {
            flag:
              'FOCUSED_IMAGINATION=1 + COGNITIVE_TEAM_ALLOCATION=1 — set IN THIS PROCESS ONLY by the live instrument (the deployment runs them off)',
            identities: [...teamIdentities],
            modes: Object.fromEntries(team.map((member) => [member.identity, member.mode])),
            pass_id: ran.pass.pass_id,
            caller: `${user} (trusted)`,
          },
          admission_rule: {
            path: 'shipped_archive',
            service: 'IdeaArchiveService.admitOrReplace',
            decided_by: 'the imagination engine, inside runFirstPass on the live store (one run per agent, on that agent’s own identity)',
            identity: teamIdentities.join(' | '),
            mission_id: missions.D,
            same_rule_as: ['A', 'B', 'C', 'D'],
            text_is_scripted: false,
            text_basis: `the real model (${model.provider}/${model.model}) generated every candidate's text`,
          },
          generation: {
            path: 'real_services',
            captured_from: 'planFirstPass + runFirstPass over the live store with three modes',
            determination: 'store_measured',
            note: 'per-agent portfolios with their own modes; the rows are the store’s own admitted seeds, with the store’s own timestamps',
          },
          trigger_at: triggerAtD,
          cycle_id: ran.pass.pass_id,
          tokens: Number(passUsage.input_tokens + passUsage.output_tokens),
          counts: {
            generated: ran.results.reduce((sum, result) => sum + result.seeds_generated, 0),
            admitted: rowsD.length,
            rejected: teamRejections.length,
            below_incumbent: 0,
          },
          coverage: {
            cells_total: new Set(rowsD.map((row) => row.cell_key)).size,
            new_cells_this_cycle: new Set(rowsD.map((row) => row.cell_key)).size,
            possible_cells: possibleCellCount(),
            occupancy_ratio: Number(
              (new Set(rowsD.map((row) => row.cell_key)).size / Math.max(1, possibleCellCount())).toFixed(9),
            ),
          },
          rows: rowsD,
          rejections: teamRejections,
          outcomes: null as unknown,
          plateau: null as unknown,
          taint: null as unknown,
        };

        const arms: Row[] = [armA as Row, armB as Row, armC, armD];

        // ── the judged set: EVERY candidate each arm GENERATED ─────────────
        const candidateOwners = new Map<string, string>();
        const collect = async (identity: string, missionId: string): Promise<JudgeCandidateInput[]> => {
          const rows = (await db
            .collection('idea_seeds')
            .find({ user_id: identity, mission_id: missionId }, { projection: { _id: 0 } })
            .toArray()) as Row[];
          return rows
            .map((row) => {
              candidateOwners.set(String(row.seed_id), identity);
              return {
                seed_id: String(row.seed_id),
                hypothesis: String(row.hypothesis ?? ''),
                mechanism: String(row.mechanism ?? ''),
                cheapest_test: String(row.cheapest_test ?? ''),
                evidence_refs: (Array.isArray(row.evidence_refs) ? row.evidence_refs : []).map((ref: unknown) =>
                  String(ref),
                ),
                descriptor_bins: { ...(row.bins ?? {}) },
              };
            })
            .sort((left, right) => left.seed_id.localeCompare(right.seed_id));
        };
        const armInputs: JudgeArmInput[] = [
          { label: 'A', candidates: await collect(controlIdentity, missions.A) },
          { label: 'B', candidates: await collect(controlIdentity, missions.B) },
          { label: 'C', candidates: await collect(engineIdentity, missions.C) },
          {
            label: 'D',
            candidates: (
              await Promise.all(teamIdentities.map((identity) => collect(identity, missions.D)))
            ).flat(),
          },
        ];
        for (const arm of armInputs) {
          if (arm.candidates.length === 0) {
            throw new Error(
              `arm ${arm.label} generated no candidate in the store — there is nothing to judge and no denominator for ` +
                'its side of the comparison, so the run is refused rather than judged in part',
            );
          }
        }

        const blinded = blindCases(armInputs, { shuffleSeed: config.shuffleSeed });
        const cases = blinded.cases;
        const mapping = blinded.mapping;
        if (cases.length > config.maxCandidates) {
          throw new Error(
            `the live run is REFUSED: ${cases.length} candidate(s) would be judged, above ` +
              `IMAGINATION_BASELINE_MAX_CANDIDATES=${config.maxCandidates} (default ${DEFAULT_MAX_CANDIDATES}). ` +
              'Raise the bound deliberately (or narrow the scenario) and re-run; nothing was judged and no verdict was recorded',
          );
        }
        mark(
          'candidates blinded',
          `${cases.length} case(s) from candidate counts ${armInputs.map((arm) => `${arm.label}=${arm.candidates.length}`).join(', ')}`,
        );

        // ── the judge: the REAL model, in bounded batches ──────────────────
        const batches: BlindCase[][] = [];
        for (let index = 0; index < cases.length; index += JUDGE_BATCH_SIZE) {
          batches.push(cases.slice(index, index + JUDGE_BATCH_SIZE));
        }
        const judgeModel = config.judge ?? model.model;
        const judgeCalls: Row[] = [];
        const verdicts: ReturnType<typeof parseJudgeReply>['verdicts'] = [];
        const judgeRefusals: string[] = [];
        mark('judge started', `${batches.length} batch(es) of at most ${JUDGE_BATCH_SIZE} case(s) with ${judgeModel}`);
        for (const [index, batch] of batches.entries()) {
          const prompt = judgePrompt(batch);
          const usageBefore = usageSnapshot();
          const raw = await llmService.extractJson(
            JUDGE_SYSTEM_PROMPT,
            prompt,
            judgeMaxTokens(batch.length),
            config.judge ?? undefined,
          );
          const callUsage = usageDeltaSince(usageBefore);
          const parsed = parseJudgeReply(raw, batch);
          mark(
            'judge batch done',
            `batch ${index + 1}/${batches.length} — ${parsed.verdicts.length} verdict(s), ${parsed.refusals.length} refusal(s), ` +
              `${callUsage.input_tokens} input / ${callUsage.output_tokens} output token(s)`,
          );
          verdicts.push(...parsed.verdicts);
          judgeRefusals.push(...parsed.refusals);
          judgeCalls.push({
            batch: index + 1,
            model: judgeModel,
            case_ids: batch.map((item) => item.case_id),
            usage: {
              input_tokens: callUsage.input_tokens,
              output_tokens: callUsage.output_tokens,
              requests: callUsage.requests,
            },
            refused: parsed.refusals,
            reply: raw,
          });
        }
        if (verdicts.length === 0) {
          throw new Error(
            `the judge produced no usable verdict: ${judgeRefusals.slice(0, 3).join(' | ') || 'the reply was empty'} — ` +
              'an unjudged run is not evidence, so the capture is refused',
          );
        }
        mark('judged', `${verdicts.length} verdict(s) in ${judgeCalls.length} call(s); ${judgeRefusals.length} refusal(s)`);

        // ── the outcome channel: the STORE records what the judge said ──────
        const byCase = new Map(mapping.map((row) => [row.case_id, row]));
        const outcomeRefusals: Row[] = [];
        mark('recording outcomes', `${verdicts.length} verdict(s) through recordCandidateOutcome`);
        for (const verdict of verdicts) {
          const target = byCase.get(verdict.case_id) as CaseMapping;
          const identity = candidateOwners.get(target.seed_id);
          if (!identity) throw new Error(`case ${verdict.case_id} maps to ${target.seed_id}, which has no owner`);
          const recorded = await recordCandidateOutcome(db, {
            userId: identity,
            seedId: target.seed_id,
            outcome: verdict.verdict,
            detail:
              `${DRIVER}: blinded judge (${judgeModel}) verdict for ${verdict.case_id} — ${verdict.reason} ` +
              `[novelty ${verdict.novelty}, coherence ${verdict.coherence}, testability ${verdict.testability}, information_gain ${verdict.information_gain}]`,
          });
          if (!recorded.recorded) {
            // Reported VERBATIM: the metric's denominator is the judged set per
            // side, so a candidate the store would not record has to be visible
            // rather than quietly missing.
            outcomeRefusals.push({
              case_id: verdict.case_id,
              arm: target.arm,
              seed_id: target.seed_id,
              outcome: verdict.verdict,
              reason: recorded.reason,
            });
          }
        }
        const recordedCount = verdicts.length - outcomeRefusals.length;
        if (recordedCount === 0) {
          throw new Error(
            `the outcome channel recorded nothing: ${outcomeRefusals.slice(0, 3).map((row) => `${row.seed_id}: ${row.reason}`).join(' | ')}`,
          );
        }
        mark('outcomes recorded', `${recordedCount} of ${verdicts.length} verdict(s) recorded in the store`);

        // ── the evidence blocks, read back from the STORE ───────────────────
        finishedAt = new Date().toISOString();
        const window = { from: startedAt, to: finishedAt };
        await store.refresh([
          { collection: CREATIVE_BATON_COLLECTIONS.candidateOutcomes, filter: { mission_id: { $in: allMissions } } },
          { collection: 'idea_seeds', filter: { mission_id: { $in: allMissions } } },
          { collection: 'idea_lineages', filter: { mission_id: { $in: allMissions } } },
          { collection: 'salience_traces', filter: { mission_id: { $in: allMissions } } },
          { collection: 'creative_batons', filter: { mission_id: { $in: allMissions } } },
          { collection: 'creative_baton_promotions', filter: { mission_id: { $in: allMissions } } },
          { collection: CREATIVE_BATON_COLLECTIONS.cycles, filter: { mission_id: { $in: allMissions } } },
          { collection: COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios, filter: { mission_id: { $in: allMissions } } },
        ]);
        for (const arm of arms) {
          // The outcomes block's denominator is the JUDGED SET per side — every
          // candidate the arm generated, admitted AND rejected — because that is
          // the denominator the brief's useful-novelty reading names. Counting
          // only the admitted rows would flatter (or penalise) a side by
          // measuring a different set than the one the judge saw.
          const judged = armInputs.find((input) => input.label === arm.label)?.candidates ?? [];
          arm.outcomes = outcomesFor(judged.map((candidate) => candidate.seed_id));
        }
        armC.plateau = plateauEvidence({
          collection: CREATIVE_BATON_COLLECTIONS.cycles,
          idField: 'cycle_id',
          userId: engineIdentity,
          missionId: missions.C,
          measured_from: `${CREATIVE_BATON_COLLECTIONS.cycles} rows for {user_id: '${engineIdentity}', mission_id: '${missions.C}'} inside THIS RUN's own window (start → finish), read back from the live store`,
          window,
        });
        armC.taint = await taintEvidence({
          userId: engineIdentity,
          missionId: missions.C,
          rows: rowsC,
          now: () => finishedAt,
        });
        armD.plateau = plateauEvidence({
          collection: COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios,
          idField: 'portfolio_id',
          kind: 'first_pass',
          userId: engineIdentity,
          missionId: missions.D,
          measured_from: `${COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios} rows of kind 'first_pass' for {user_id: '${engineIdentity}', mission_id: '${missions.D}'} inside THIS RUN's own window (start → finish), read back from the live store`,
          window,
        });
        armD.taint = await taintEvidence({
          userId: engineIdentity,
          missionId: missions.D,
          rows: rowsD,
          now: () => finishedAt,
        });
        mark('evidence read back', `outcomes ${arms.map((arm) => `${arm.label}=${(arm.outcomes as Row).recorded}`).join(', ')}`);

        // ── the mission the checkpoint is fixed at ─────────────────────────
        const missionRow = (await db
          .collection(COLLECTIONS.missionStates)
          .findOne({ mission_id: missions.C }, { projection: { _id: 0 } })) as Row | null;
        if (!missionRow) throw new Error(`the live run is REFUSED: mission state ${missions.C} is not in the store`);
        const PREDICATE_BY_CRITERION: Record<string, { predicate: string; basis: string }> = {
          c1: {
            predicate: 'cycles_per_plateau_within_limit',
            basis:
              'counts the runs the engine recorded for the plateau window (imagination_cycles for the one-identity arm, ' +
              'cognitive_portfolios (kind=first_pass) for the team arm) and requires at most 1 — the mission’s own wording is "one cycle per plateau"',
          },
          c2: {
            predicate: 'no_private_text_in_shared_artefacts',
            basis:
              'reads the taint scan the metrics view runs (privacy_leakage: the shared-scope artefacts scanned for the forbidden private keys and for ' +
              'markers lifted verbatim from this identity’s private stores) and requires zero flags',
          },
        };
        const criteria = (missionRow.success_criteria ?? []).map((criterion: Row) => {
          const mapped = PREDICATE_BY_CRITERION[String(criterion.id)];
          return {
            id: String(criterion.id),
            description: String(criterion.description),
            predicate: mapped?.predicate ?? 'unmapped_criterion',
            basis:
              mapped?.basis ??
              'no predicate is mapped for this criterion: the harness reports it as NOT evaluated (insufficient_data for the whole check) rather than counting it as met',
            ...(mapped?.predicate === 'cycles_per_plateau_within_limit' ? { plateau_cycle_limit: 1 } : {}),
          };
        });

        // ── what this run wrote, so the rows can be cleaned up later ────────
        const written: Row = {};
        for (const collection of WRITTEN_COLLECTIONS) {
          written[collection] = await db.collection(collection).countDocuments({
            $or: [{ mission_id: { $in: allMissions } }, { user_id: { $in: runIdentities } }],
          });
        }

        // ── the judge transcript (the mapping and the raw replies) ──────────
        const transcriptPath = defaultTranscriptPath(config.out);
        const transcript = {
          instrument: DRIVER,
          system_prompt: JUDGE_SYSTEM_PROMPT,
          prompt_sha256: judgePromptSha256(),
          shuffle_seed: config.shuffleSeed,
          batch_size: JUDGE_BATCH_SIZE,
          model: judgeModel,
          model_override: config.judge,
          run_token: run,
          started_at: startedAt,
          finished_at: finishedAt,
          candidates: armInputs.map((arm) => ({ arm: arm.label, seed_ids: arm.candidates.map((candidate) => candidate.seed_id) })),
          mapping,
          calls: judgeCalls,
          verdicts,
          refusals: judgeRefusals,
          outcome_refusals: outcomeRefusals,
        };

        // ── the capture, in the harness's shape ────────────────────────────
        const capture = {
          fixture_version: '1.0',
          frozen_at: finishedAt,
          mission: {
            mission_id: String(missionRow.mission_id),
            title: String(missionRow.title),
            intent: String(missionRow.intent),
            version: Number(missionRow.version),
            authority_class: String(missionRow.authority_class),
            owner_id: String(missionRow.owner_id),
            success_criteria: (missionRow.success_criteria ?? []).map((criterion: Row) => ({
              id: String(criterion.id),
              description: String(criterion.description),
              status: String(criterion.status),
            })),
          },
          checkpoint: {
            scenario:
              'tests/helpers/imagination-scenario.ts (the frozen scripted scenario) RE-SEEDED into the live store under this run’s own ids',
            cycle_id: armC.cycle_id,
            pass_id: armD.cycle_id,
            trace_id: String(
              store
                .collection('salience_traces')
                .docs.find((row) => row.user_id === engineIdentity && row.mission_id === missions.C)?.trace_id ?? '',
            ),
          },
          baseline_material: material,
          task_checker: {
            criteria,
            basis:
              'the live mission’s own success criteria (the frozen scenario’s two), each mapped to the SAME predicate the frozen checkpoint maps ' +
              'it to, over evidence the arm has to carry from the LIVE store (a plateau run count for "one cycle per plateau", the taint scan for ' +
              '"no private text crosses"); the task-quality check evaluates every arm with the predicate its criterion names and refuses a verdict ' +
              'when an evaluation is missing',
          },
          arms,
          capture: {
            kind: 'live_run',
            summary:
              `one bounded live run of the four baseline arms (A ${armA.name}, B ${armB.name}, C ${armC.name}, D ${armD.name}) over the frozen ` +
              `scenario re-seeded into the live store under run token '${run}', with every candidate of every arm judged blind by ${judgeModel} ` +
              `(${verdicts.length} verdict(s) in ${judgeCalls.length} call(s))`,
            disclosure: [
              `LIVE STORE: a real MongoDB (database '${db.databaseName}') on host ${hostname()}; this run's rows are private to the run's identities and missions, and NOTHING was deleted or overwritten (the clean-up summary is in this block).`,
              `LIVE MODEL: ${model.provider}/${model.model} (providers: ${model.providers.join(', ')}) generated every treatment candidate and produced the scenario's salience traces.`,
              `FROZEN MATERIAL: the checkpoint is the scripted SCENARIO (tests/helpers/imagination-scenario.ts) — its mission state, ledger, work queue, graph and the comparator templates — re-seeded into the live store. This is not a real mission's history; it is the same checkpoint the frozen fixture measures, so the two readings are comparable.`,
              `FLAGS IN THIS PROCESS ONLY: FOCUSED_IMAGINATION=1, CREATIVE_BATON_PROMOTION=1 and COGNITIVE_TEAM_ALLOCATION=1 were set by this instrument before the services were imported. The deployment runs with all four flags OFF; this process is the instrument, and nothing it writes changes any process's configuration.`,
              'BOUNDED EVALUATION: arm C ran with RunCycleArgs.force=true — the plateau gate is bypassed by an explicit caller override, recorded in the arm’s config.cycle_trigger. The gate is what normally bounds the engine to one cycle per plateau; here the bound is this run.',
              `JUDGED SET: EVERY candidate each arm generated was judged — admitted AND rejected — so each side's denominator is its generated set, not its admitted set (candidate counts: ${armInputs.map((arm) => `${arm.label}=${arm.candidates.length}`).join(', ')}).`,
              `BLIND JUDGE: the judge saw only {hypothesis, mechanism, cheapest_test, evidence_refs, descriptor_bins} under opaque case ids from a seeded shuffle (seed ${config.shuffleSeed}); the arm labels, the identities, the mission ids and the seed ids never entered a payload. The prompt is frozen and recorded with its sha256; the raw replies, the mapping and every call's token usage are in the transcript.`,
              `SELF-PREFERENCE RISK, DISCLOSED: the judge is a language model, and the treatment arms' text was written by a model of the same family while the comparators' text is a fixed template. A judge may prefer one style over another for reasons unrelated to the ideas. The prompt, the shuffle seed and every raw reply are recorded precisely so this reading can be re-scored from the transcript by another judge, or by a person.`,
              'NOT DONE HERE: no container executed the engine (the services ran in this process); nothing was promoted beyond what the shipped promotion step does inside arm C’s cycle; no experiments row was written (that is the harness’s job, and it is what turns this capture into the recorded baseline); no row was deleted.',
              `OUTCOME CHANNEL: ${recordedCount} of ${verdicts.length} verdict(s) were recorded through recordCandidateOutcome into the store; ${outcomeRefusals.length} refusal(s) are reported verbatim in this block.${judgeRefusals.length > 0 ? ` The judge itself refused ${judgeRefusals.length} case(s) by name (recorded in the transcript and this block).` : ''}`,
              `TRANSCRIPT: ${transcriptPath} (system prompt verbatim, mapping, raw replies, per-call tokens); GRADES: ${config.grades} (the harness's --grade file, built from the store-recorded verdicts).`,
            ],
            judge: {
              instrument: 'server/tests/helpers/imagination-blind-judge.ts',
              model: judgeModel,
              model_override: config.judge,
              prompt_sha256: judgePromptSha256(),
              shuffle_seed: config.shuffleSeed,
              batch_size: JUDGE_BATCH_SIZE,
              cases: cases.length,
              judged: verdicts.length,
              refused: judgeRefusals.length,
              calls: judgeCalls.length,
              refusals: judgeRefusals,
              transcript: transcriptPath,
            },
            environment: {
              store: { kind: 'mongodb', database: db.databaseName, connection: 'src/database/connection.ts connect_to_mongodb()' },
              model: { provider: model.provider, model: model.model, providers: model.providers, availability_waited_ms: model.waited_ms },
              started_at: startedAt,
              finished_at: finishedAt,
              run_token: run,
              user,
              identities: runIdentities,
              missions,
              host: hostname(),
              pipeline,
            },
            refusals: { judge: judgeRefusals, outcomes: outcomeRefusals },
            written: {
              counted_by: `mission_id ∈ [${allMissions.join(', ')}] OR user_id ∈ [${runIdentities.join(', ')}]`,
              note:
                'counts are by the run’s namespaces, not by timestamp: the scenario’s own rows (the work item, the knowledge graph) carry the ' +
                'fixture’s frozen timestamps, so a time filter would miss them. Deleting exactly these rows removes the run; this instrument deletes nothing.',
              collections: written,
            },
          },
          provenance: {
            generator: DRIVER,
            regenerate: `IMAGINATION_BASELINE_LIVE=1 IMAGINATION_BASELINE_USER=<identity> IMAGINATION_BASELINE_RUN=<new token> IMAGINATION_BASELINE_OUT=<path> npx vitest run tests/live/imagination-baseline-live.test.ts`,
            services:
              'runImaginationCycle (force), planFirstPass/runFirstPass, createInheritanceEnvelope, runFocusedConsolidation, ' +
              'IdeaArchiveService.admitOrReplace (all four arms), recordCandidateOutcome (the judge’s verdicts) — on a real MongoDB and a real model',
            not_verified: `one bounded run under one run token; nothing here is a distribution, and the judge is a model (see the disclosure). The capture was fixed at ${finishedAt}.`,
          },
        };

        const grades = gradesFromVerdicts(verdicts, mapping);

        // ── write the three artefacts, then assert they are readable ───────
        for (const target of [config.out, config.grades, transcriptPath]) {
          const parent = path.dirname(target);
          if (parent && parent !== '.' && !existsSync(parent)) mkdirSync(parent, { recursive: true });
        }
        writeFileSync(config.out, `${JSON.stringify(capture, null, 2)}\n`);
        writeFileSync(config.grades, `${JSON.stringify(grades, null, 2)}\n`);
        writeFileSync(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`);
        await store.flush();

        const reread = JSON.parse(readFileSync(config.out, 'utf8'));
        expect(reread.capture.kind).toBe('live_run');
        expect(reread.arms).toHaveLength(4);
        expect(reread.capture.judge.judged).toBeGreaterThan(0);
        expect(existsSync(config.grades)).toBe(true);
        expect(existsSync(transcriptPath)).toBe(true);

        const perArm: string[] = reread.arms.map(
          (arm: Row) =>
            `${arm.label}: generated ${arm.counts.generated}, judged ${(arm.rows ?? []).length} row(s) + ` +
            `${(arm.rejections ?? []).length} rejection(s), outcomes ${arm.outcomes.recorded} ` +
            `(useful ${arm.outcomes.useful_information})`,
        );
        console.log(
          [
            '',
            '── imagination baseline: BOUNDED LIVE RUN complete ──────────────────────',
            `   store      ${db.databaseName} · model ${model.provider}/${model.model} · judge ${judgeModel}`,
            `   run token  ${run} · missions ${allMissions.join(', ')}`,
            ...perArm.map((line) => `   arm ${line}`),
            `   capture    ${config.out}`,
            `   grades     ${config.grades}`,
            `   transcript ${transcriptPath}`,
            '   next: node scripts/imagination-baseline.mjs --fixture <capture> --store <out> --grade <grades>',
            '────────────────────────────────────────────────────────────────────────',
            '',
          ].join('\n'),
        );
      } finally {
        await store.flush().catch((error) => console.error(`live driver: flush failed — ${messageOf(error)}`));
        await connection.close_connection().catch((error) => console.error(`live driver: close failed — ${messageOf(error)}`));
      }
    },
  );
});
