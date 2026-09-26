/**
 * THE CANARY JUDGE — the operator step the executive tick does not do.
 *
 * The tick generates; it does not judge. Every autonomous cycle therefore leaves
 * candidates with no recorded outcome, and `useful_novelty_rate` and
 * `cost_of_novelty` can only count the ones an operator has judged. This
 * instrument closes that backlog: it reads candidates that ALREADY EXIST in the
 * store, blinds them, asks the same frozen judge prompt the A/B uses, and records
 * each verdict through the SHIPPED outcome channel (`recordCandidateOutcome`).
 *
 * WHAT IT IS NOT. It generates nothing, runs no cycle, promotes no baton and
 * deletes nothing. Its only write is the outcome channel's own three writes, and
 * it asserts that on its way out: the seed and cycle counts it reads before and
 * after the run must be identical, and the capture says so in the same words.
 * The verdicts are the judge's, recorded verbatim; a candidate the store refuses
 * to record is reported BY NAME rather than quietly dropped.
 *
 * IT RUNS NOTHING UNLESS ASKED. With `IMAGINATION_CANARY_JUDGE_LIVE` unset the
 * whole file skips, so a normal test run neither connects to a store nor spends a
 * token. The command line:
 *
 *   IMAGINATION_CANARY_JUDGE_LIVE=1 \
 *   IMAGINATION_CANARY_JUDGE_USER=<identity> \
 *   IMAGINATION_CANARY_JUDGE_OUT=<capture.json> \
 *   npx vitest run tests/live/imagination-canary-judge.test.ts
 *
 * Options (all recorded in the capture, all optional but the three above):
 *   IMAGINATION_CANARY_JUDGE_CYCLES      comma-separated cycle ids to judge;
 *                                        default: every cycle of that identity
 *                                        that has unjudged admitted candidates
 *   IMAGINATION_CANARY_JUDGE_MAX         bound on judged candidates (default 60);
 *                                        the run refuses BY NAME above it
 *   IMAGINATION_CANARY_JUDGE_BATCH_SIZE  judge batch size (default 5 — a ten-case
 *                                        batch of model-written candidates was
 *                                        measured truncating at its ceiling)
 *   IMAGINATION_CANARY_JUDGE_MAX_TOKENS  per-call ceiling (default 3000 + 1000
 *                                        per case, capped at the provider's 16000)
 *   IMAGINATION_CANARY_JUDGE_SHUFFLE_SEED  default 20260926, the A/B's own seed
 *
 * THE CAPTURE IS AN OPERATIONAL ARTEFACT, NOT REPO CONTENT: it carries the host
 * name, the model id and the store's database name. Write it outside the
 * repository, as the other live instruments do.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

const LIVE = process.env.IMAGINATION_CANARY_JUDGE_LIVE === '1';

const DEFAULT_SHUFFLE_SEED = 20260926;
const DEFAULT_MAX_CANDIDATES = 60;
const DEFAULT_BATCH_SIZE = 5;

type Row = Record<string, any>;

function text(name: string): string | null {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? null : raw;
}

function wholeNumber(name: string, fallback: number): number | { refusal: string } {
  const raw = text(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return { refusal: `${name} '${raw}' is not a positive whole number` };
  }
  return value;
}

function messageOf(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error);
}

describe.skipIf(!LIVE)('imagination canary judge — the operator step, over candidates that already exist', () => {
  it(
    'judges every unjudged candidate of the named identity and records the verdicts through the shipped channel',
    async () => {
      const user = text('IMAGINATION_CANARY_JUDGE_USER');
      const out = text('IMAGINATION_CANARY_JUDGE_OUT');
      if (!user || !out) {
        throw new Error(
          'the canary judge is REFUSED: IMAGINATION_CANARY_JUDGE_USER and IMAGINATION_CANARY_JUDGE_OUT are both required',
        );
      }
      if (existsSync(out)) {
        throw new Error(
          `the canary judge is REFUSED: ${out} already exists — an evidence file is written once; choose a new path (the run is idempotent, the file is not)`,
        );
      }
      const maxCandidates = wholeNumber('IMAGINATION_CANARY_JUDGE_MAX', DEFAULT_MAX_CANDIDATES);
      if (typeof maxCandidates === 'object') throw new Error(`the canary judge is REFUSED: ${maxCandidates.refusal}`);
      const batchSize = wholeNumber('IMAGINATION_CANARY_JUDGE_BATCH_SIZE', DEFAULT_BATCH_SIZE);
      if (typeof batchSize === 'object') throw new Error(`the canary judge is REFUSED: ${batchSize.refusal}`);
      const shuffleSeed = wholeNumber('IMAGINATION_CANARY_JUDGE_SHUFFLE_SEED', DEFAULT_SHUFFLE_SEED);
      if (typeof shuffleSeed === 'object') throw new Error(`the canary judge is REFUSED: ${shuffleSeed.refusal}`);
      const ceilingOverride = wholeNumber('IMAGINATION_CANARY_JUDGE_MAX_TOKENS', 0);
      if (typeof ceilingOverride === 'object') {
        throw new Error(`the canary judge is REFUSED: ${ceilingOverride.refusal}`);
      }
      const onlyCycles = (text('IMAGINATION_CANARY_JUDGE_CYCLES') ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

      const progressPath = `${out}.progress.log`;
      const marks: Array<{ at: string; step: string; detail?: string }> = [];
      const mark = (step: string, detail?: string) => {
        const entry = { at: new Date().toISOString(), step, ...(detail ? { detail } : {}) };
        marks.push(entry);
        const line = `${entry.at} ${step}${detail ? ` — ${detail}` : ''}`;
        process.stderr.write(`${line}\n`);
        const parent = path.dirname(progressPath);
        if (parent && parent !== '.' && !existsSync(parent)) mkdirSync(parent, { recursive: true });
        writeFileSync(progressPath, marks.map((m) => `${m.at} ${m.step}${m.detail ? ` — ${m.detail}` : ''}`).join('\n') + '\n');
      };

      const connection = await import('../../src/database/connection.js');
      const { llmService } = await import('../../src/services/infrastructure/llm-service.js');
      const { usageSnapshot, usageDeltaSince } = await import('../../src/services/infrastructure/llm-usage-ledger.js');
      const { recordCandidateOutcome } = await import(
        '../../src/services/processing/imagination-outcome-service.js'
      );
      const { IMAGINATION_COLLECTIONS } = await import('../../src/services/processing/imagination-collections.js');
      const { CREATIVE_BATON_COLLECTIONS } = await import(
        '../../src/services/processing/creative-baton-collections.js'
      );
      const {
        JUDGE_BATCH_SIZE,
        JUDGE_SYSTEM_PROMPT,
        blindCases,
        judgePrompt,
        judgePromptSha256,
        parseJudgeReply,
      } = await import('../helpers/imagination-blind-judge.js');
      type JudgeCandidateInput = import('../helpers/imagination-blind-judge.js').JudgeCandidateInput;

      const maxTokens = (cases: number): number =>
        ceilingOverride > 0 ? ceilingOverride : Math.min(16000, 3000 + 1000 * cases);

      let db: Awaited<ReturnType<typeof connection.connect_to_mongodb>> | null = null;
      try {
        db = await connection.connect_to_mongodb();
        if (!db && connection.is_database_connected()) db = connection.get_database();
      } catch (error) {
        throw new Error(
          `the canary judge is REFUSED: the store could not be reached — ${messageOf(error)} (MONGODB_URI / DATABASE_NAME must name the store this instrument may read and record into)`,
        );
      }
      if (!db || !connection.is_database_connected()) {
        throw new Error('the canary judge is REFUSED: connect_to_mongodb() returned no database, or the connection reports it is not connected');
      }

      const startedAt = new Date().toISOString();
      mark('store connected', `database '${db.databaseName}' on ${hostname()}`);

      // ── the store, read-only: cycles, their candidates, and who is judged ──
      const cycles = await db
        .collection(CREATIVE_BATON_COLLECTIONS.cycles)
        .find(onlyCycles.length ? { user_id: user, cycle_id: { $in: onlyCycles } } : { user_id: user })
        .project({ cycle_id: 1, mission_id: 1, status: 1, created_at: 1, counts: 1, config: 1 })
        .sort({ created_at: 1 })
        .toArray();
      if (cycles.length === 0) {
        throw new Error(`the canary judge is REFUSED: no cycle rows for identity '${user}'${onlyCycles.length ? ` matching ${onlyCycles.join(', ')}` : ''}`);
      }
      const cyclesBefore = await db.collection(CREATIVE_BATON_COLLECTIONS.cycles).countDocuments({ user_id: user });
      const seedsBefore = await db.collection(IMAGINATION_COLLECTIONS.ideaSeeds).countDocuments({ user_id: user });
      mark('cycles read', `${cycles.length} cycle(s), ${seedsBefore} seed(s), ${cyclesBefore} cycle row(s) for '${user}'`);

      const perCycle: Row[] = [];
      const targets: Array<{ seed: Row; cycle: Row }> = [];
      for (const cycle of cycles) {
        const seeds = await db
          .collection(IMAGINATION_COLLECTIONS.ideaSeeds)
          .find({ user_id: user, cycle_id: cycle.cycle_id })
          .project({ seed_id: 1, hypothesis: 1, mechanism: 1, cheapest_test: 1, evidence_refs: 1, bins: 1, state: 1, operator: 1 })
          .toArray();
        const seedIds = seeds.map((seed) => String(seed.seed_id));
        const outcomes = await db
          .collection(CREATIVE_BATON_COLLECTIONS.candidateOutcomes)
          .find({ user_id: user, seed_id: { $in: seedIds } })
          .project({ seed_id: 1, outcome: 1 })
          .toArray();
        const judged = new Set(outcomes.map((row) => String(row.seed_id)));
        const unjudged = seeds.filter((seed) => !judged.has(String(seed.seed_id)));
        for (const seed of unjudged) targets.push({ seed, cycle });
        perCycle.push({
          cycle_id: String(cycle.cycle_id),
          mission_id: String(cycle.mission_id),
          status: String(cycle.status),
          created_at: String(cycle.created_at),
          stop: cycle.config?.stop_reason ?? null,
          trigger: cycle.config?.trigger ?? null,
          seeds: seeds.length,
          outcomes: outcomes.length,
          unjudged: unjudged.length,
        });
        mark('cycle read', `${cycle.cycle_id}: ${seeds.length} seed(s), ${outcomes.length} outcome(s), ${unjudged.length} unjudged`);
      }
      if (targets.length === 0) {
        throw new Error(`the canary judge is REFUSED: every candidate of '${user}' already carries an outcome — there is nothing to judge (this is a clean result, not a failure: re-run when the tick has generated more)`);
      }
      if (targets.length > maxCandidates) {
        throw new Error(
          `the canary judge is REFUSED: ${targets.length} unjudged candidate(s) exceed the bound of ${maxCandidates} (IMAGINATION_CANARY_JUDGE_MAX) — narrow the run with IMAGINATION_CANARY_JUDGE_CYCLES or raise the bound deliberately`,
        );
      }

      // ── the model, named and required ─────────────────────────────────────
      const status = llmService.getServiceStatus();
      if (!status.available) {
        throw new Error(
          `the canary judge is REFUSED: llmService.getServiceStatus().available is false — ${JSON.stringify(status)}. The judge needs the real provider.`,
        );
      }
      const judgeModel = status.model;

      // ── blind, then judge ─────────────────────────────────────────────────
      const candidateInputs: JudgeCandidateInput[] = targets.map(({ seed }) => ({
        seed_id: String(seed.seed_id),
        hypothesis: String(seed.hypothesis ?? ''),
        mechanism: String(seed.mechanism ?? ''),
        cheapest_test: String(seed.cheapest_test ?? ''),
        evidence_refs: (seed.evidence_refs ?? []).map((ref: unknown) => String(ref)),
        descriptor_bins: { ...(seed.bins ?? {}) },
      }));
      const blinded = blindCases([{ label: 'canary', candidates: candidateInputs }], { shuffleSeed });
      const cases = blinded.cases;
      mark('candidates blinded', `${cases.length} case(s) under opaque ids (shuffle seed ${shuffleSeed})`);

      const batches: typeof cases[] = [];
      for (let index = 0; index < cases.length; index += batchSize) batches.push(cases.slice(index, index + batchSize));

      const verdicts: ReturnType<typeof parseJudgeReply>['verdicts'] = [];
      const judgeRefusals: string[] = [];
      const judgeCalls: Row[] = [];
      for (const [index, batch] of batches.entries()) {
        const prompt = judgePrompt(batch);
        const usageBefore = usageSnapshot();
        const raw = await llmService.extractJson(JUDGE_SYSTEM_PROMPT, prompt, maxTokens(batch.length));
        const callUsage = usageDeltaSince(usageBefore);
        const parsed = parseJudgeReply(raw, batch);
        verdicts.push(...parsed.verdicts);
        judgeRefusals.push(...parsed.refusals);
        judgeCalls.push({
          batch: index + 1,
          case_ids: batch.map((item) => item.case_id),
          max_tokens: maxTokens(batch.length),
          verdicts: parsed.verdicts.length,
          refusals: parsed.refusals.length,
          refused: parsed.refusals,
          usage: { input_tokens: callUsage.input_tokens, output_tokens: callUsage.output_tokens },
        });
        mark(
          'judge batch done',
          `batch ${index + 1}/${batches.length} — ${parsed.verdicts.length} verdict(s), ${parsed.refusals.length} refusal(s), ` +
            `${callUsage.input_tokens} input / ${callUsage.output_tokens} output token(s)`,
        );
      }
      if (verdicts.length === 0) {
        throw new Error(
          `the canary judge is REFUSED: the judge returned no usable verdict (${judgeRefusals.length} refusal(s)) — nothing was recorded`,
        );
      }

      // ── the outcome channel: the store records what the judge said ────────
      const byCase = new Map(blinded.mapping.map((row) => [row.case_id, row]));
      const recorded: Row[] = [];
      const outcomeRefusals: Row[] = [];
      for (const verdict of verdicts) {
        const target = byCase.get(verdict.case_id);
        if (!target) throw new Error(`case ${verdict.case_id} has no mapping — the transcript is incomplete`);
        const result = await recordCandidateOutcome(db, {
          userId: user,
          seedId: target.seed_id,
          outcome: verdict.verdict,
          detail:
            `canary judge: blinded judge (${judgeModel}) verdict for ${verdict.case_id} — ${verdict.reason} ` +
            `[novelty ${verdict.novelty}, coherence ${verdict.coherence}, testability ${verdict.testability}, information_gain ${verdict.information_gain}]`,
        });
        if (result.recorded) recorded.push({ seed_id: target.seed_id, outcome: verdict.verdict });
        else outcomeRefusals.push({ case_id: verdict.case_id, seed_id: target.seed_id, outcome: verdict.verdict, reason: result.reason });
      }
      mark('outcomes recorded', `${recorded.length} of ${verdicts.length} verdict(s) recorded; ${outcomeRefusals.length} refusal(s)`);

      // ── the run wrote nothing else, and says so from the store's own counts ─
      const cyclesAfter = await db.collection(CREATIVE_BATON_COLLECTIONS.cycles).countDocuments({ user_id: user });
      const seedsAfter = await db.collection(IMAGINATION_COLLECTIONS.ideaSeeds).countDocuments({ user_id: user });
      expect({ seeds: seedsAfter, cycles: cyclesAfter }).toEqual({ seeds: seedsBefore, cycles: cyclesBefore });

      const finishedAt = new Date().toISOString();
      const capture = {
        instrument: 'server/tests/live/imagination-canary-judge.test.ts',
        kind: 'canary_judge',
        capture: {
          kind: 'canary_judge',
          summary:
            `judged ${verdicts.length} previously-unjudged candidate(s) of '${user}' with the same blinded prompt the A/B uses, ` +
            `and recorded each verdict through recordCandidateOutcome (${recorded.length} recorded, ${outcomeRefusals.length} refused)`,
          disclosure: [
            `THIS RUN GENERATED NOTHING: no cycle ran, no seed was written, no baton was promoted and nothing was deleted — the store's own counts before and after are identical (${seedsBefore} seed(s), ${cyclesBefore} cycle row(s) for '${user}').`,
            `WHAT IT WROTE: outcome rows only, through the shipped channel's three writes, each idempotent per {seed_id, outcome}; a second identical verdict is UNCHANGED rather than duplicated.`,
            `THE JUDGE IS BLIND AND FROZEN, exactly as in the A/B: five fields per case, opaque case ids from a seeded shuffle (seed ${shuffleSeed}), the prompt recorded with its sha256 ${judgePromptSha256()}; the raw replies are in this capture's calls.`,
            `SELF-PREFERENCE RISK, DISCLOSED: the judge is a language model, and the candidates came from the same model that wrote them (the engine's own); a verdict here is a model's judgement, recorded verbatim, re-scorable from this capture.`,
            `THE TICK DOES NOT JUDGE: this instrument is the operator step the rollout's design leaves to a person, so a backlog is expected between runs and this capture is its receipt.`,
          ],
          judge: {
            instrument: 'server/tests/helpers/imagination-blind-judge.ts',
            model: judgeModel,
            prompt_sha256: judgePromptSha256(),
            shuffle_seed: shuffleSeed,
            batch_size: batchSize,
            default_batch_size: JUDGE_BATCH_SIZE,
            cases: cases.length,
            judged: verdicts.length,
            refused: judgeRefusals.length,
            refusals: judgeRefusals,
            calls: judgeCalls,
          },
          per_cycle: perCycle,
          recorded,
          outcome_refusals: outcomeRefusals,
          environment: {
            store: { kind: 'mongodb', database: db.databaseName, connection: 'src/database/connection.ts connect_to_mongodb()' },
            model_available: status,
            started_at: startedAt,
            finished_at: finishedAt,
            user,
            cycles_selected: onlyCycles.length ? onlyCycles : 'every cycle of the identity with unjudged candidates',
            max_candidates: maxCandidates,
            host: hostname(),
            pipeline: marks,
          },
          wrote: {
            before: { seeds: seedsBefore, cycles: cyclesBefore },
            after: { seeds: seedsAfter, cycles: cyclesAfter },
            note: 'identical by design: the outcome channel is this instrument’s only write, and the assertion above fails the run if that ever stops being true',
          },
        },
      };

      const parent = path.dirname(out);
      if (parent && parent !== '.' && !existsSync(parent)) mkdirSync(parent, { recursive: true });
      writeFileSync(out, `${JSON.stringify(capture, null, 2)}\n`);
      mark('capture written', out);
    },
    1_200_000,
  );
});
