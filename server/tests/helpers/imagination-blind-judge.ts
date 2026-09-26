/**
 * ITER-11, WS-4 — the BLIND JUDGE of the live baseline run (DoD #8).
 *
 * The frozen fixture cannot answer DoD bullet 8: "useful novelty rate ≥30%
 * better for the engine than the pre-engine path" is a statement about IDEAS,
 * and the fixture's idea text is a scripted template's. `tokens_per_useful` and
 * every text-derived magnitude need a judge. This module is the judge's
 * INSTRUMENT: it blinds the candidates, asks a model the same question about
 * every arm's ideas in the same words, parses that answer without coercing
 * anything, and turns the verdicts into the harness's `--grade` file.
 *
 * PURE, NO I/O. Nothing here reads a file, opens a connection or calls a model
 * (`server/tests/unit/imagination-blind-judge.test.ts` proves it, and the live
 * driver `server/tests/live/imagination-baseline-live.test.ts` is the only
 * caller that talks to the outside world). Keeping the blinding, the prompt and
 * the parser here — out of the driver — is what makes them testable without a
 * store, and what makes the transcript the driver writes reproducible: the
 * prompt is a frozen constant, the shuffle is a seeded PRNG, and the parser
 * refuses by name rather than guessing.
 *
 * WHAT BLINDING MEANS HERE (and what it cannot do):
 *
 *   * The payload for a case is EXACTLY `{case_id, hypothesis, mechanism,
 *     cheapest_test, evidence_refs, descriptor_bins}`. `blindCases` builds that
 *     object literal field by field — there is no spread of a source row — so an
 *     arm label, an identity, a mission id or a seed id cannot ride along by
 *     accident;
 *   * `case_id` is opaque (`case_01`, `case_02`, …) and is assigned AFTER the
 *     shuffle, so it carries no information about the arm or the position in the
 *     arm;
 *   * the arm↔case mapping is returned SEPARATELY and never enters a payload
 *     (the driver writes it to the transcript, which is not fed to the judge).
 *
 *   What blinding does NOT remove: the judge is a language model, and the
 *   treatment arms' text was written by a model of the same family while the
 *   comparators' text is a template with `concept`-of-`index` sentences in it. A
 *   judge can therefore prefer one style over another for reasons that have
 *   nothing to do with the ideas. That risk is a fact about the instrument, not
 *   a bug in it: the capture DISCLOSES it, the prompt is recorded verbatim and
 *   hashed, the shuffle seed is recorded, and every raw reply is kept — so the
 *   reading can be re-scored by another judge, or by a person, from the
 *   transcript alone.
 */
import { createHash } from 'node:crypto';

// ── The live run's configuration ───────────────────────────────────────────

/** The instrument's default bound on the number of judged candidates. */
export const DEFAULT_MAX_CANDIDATES = 40;
/** The instrument's default shuffle seed (the checkpoint's own date). */
export const DEFAULT_SHUFFLE_SEED = 20260926;
/** How many cases one judge call carries (the driver's batch size). */
export const JUDGE_BATCH_SIZE = 10;

export interface LiveRunConfig {
  /** The identity every run-namespaced id hangs off (`${user}-engine`, `${user}-control`, …). */
  user: string;
  /** The run token: namespaces every mission id, so nothing collides with real data. */
  run: string;
  /** Where the capture is written (the harness's `--fixture`). */
  out: string;
  /** Where the harness's `--grade` file is written (default: `out` − `.json` + `-GRADES.json`). */
  grades: string;
  /** A model override for the judge alone, or null to judge with the run's own model. */
  judge: string | null;
  /** Refuse the run when it would judge more candidates than this. */
  maxCandidates: number;
  /** The judge's shuffle seed. */
  shuffleSeed: number;
}

export type LiveRunConfigResult = { ok: true; config: LiveRunConfig } | { ok: false; reason: string };

/** The grades path derived from the capture path: `<out minus .json>-GRADES.json`. */
export function defaultGradesPath(out: string): string {
  return `${out.replace(/\.json$/i, '')}-GRADES.json`;
}

/** The judge transcript path derived from the capture path. */
export function defaultTranscriptPath(out: string): string {
  return `${out.replace(/\.json$/i, '')}-JUDGE.json`;
}

/**
 * Read the live run's configuration from the environment. EVERY name is
 * deployment data, so a missing identity, run token or output path is a NAMED
 * refusal — this instrument never defaults one (a default identity would write
 * a live run under the wrong owner, and a default path would overwrite whatever
 * is there). The three optional knobs have documented defaults; a knob that is
 * present but not a whole number is refused by name rather than coerced.
 */
export function liveRunConfigFromEnv(env: Record<string, string | undefined>): LiveRunConfigResult {
  const text = (name: string): string | null => {
    const value = String(env[name] ?? '').trim();
    return value.length > 0 ? value : null;
  };
  const required: Array<[string, string | null]> = [
    ['IMAGINATION_BASELINE_USER', text('IMAGINATION_BASELINE_USER')],
    ['IMAGINATION_BASELINE_RUN', text('IMAGINATION_BASELINE_RUN')],
    ['IMAGINATION_BASELINE_OUT', text('IMAGINATION_BASELINE_OUT')],
  ];
  const missing = required.filter(([, value]) => value === null).map(([name]) => name);
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `the live run is REFUSED: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset — ` +
        'this instrument never defaults an identity, a run token or an output path (they are deployment data, and a ' +
        'default would silently write a live run under the wrong owner or over the wrong file)',
    };
  }
  const user = required[0][1]!;
  const run = required[1][1]!;
  const out = required[2][1]!;

  // The run token becomes part of every mission id this run writes, so it has to
  // be an id, not prose: no spaces, no separators that a mission id or a Mongo
  // filter could reinterpret.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(run)) {
    return {
      ok: false,
      reason:
        `the live run is REFUSED: IMAGINATION_BASELINE_RUN '${run}' is not a run token — it must match ` +
        '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ because it is suffixed onto every mission id this run writes',
    };
  }

  const wholeNumber = (name: string, fallback: number): number | { refusal: string } => {
    const raw = text(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      return { refusal: `the live run is REFUSED: ${name} '${raw}' is not a positive whole number` };
    }
    return value;
  };
  const maxCandidates = wholeNumber('IMAGINATION_BASELINE_MAX_CANDIDATES', DEFAULT_MAX_CANDIDATES);
  if (typeof maxCandidates === 'object') return { ok: false, reason: maxCandidates.refusal };
  const shuffleSeed = wholeNumber('IMAGINATION_BASELINE_SHUFFLE_SEED', DEFAULT_SHUFFLE_SEED);
  if (typeof shuffleSeed === 'object') return { ok: false, reason: shuffleSeed.refusal };

  return {
    ok: true,
    config: {
      user,
      run,
      out,
      grades: text('IMAGINATION_BASELINE_GRADES') ?? defaultGradesPath(out),
      judge: text('IMAGINATION_BASELINE_JUDGE'),
      maxCandidates,
      shuffleSeed,
    },
  };
}

// ── Blinding ───────────────────────────────────────────────────────────────

/** One candidate, as the judge receives it. NOTHING else is ever carried. */
export interface BlindCase {
  case_id: string;
  hypothesis: string;
  mechanism: string;
  cheapest_test: string;
  evidence_refs: string[];
  descriptor_bins: Record<string, string>;
}

/** Where a case came from — kept OUT of the payloads, written to the transcript. */
export interface CaseMapping {
  case_id: string;
  arm: string;
  seed_id: string;
}

/** A candidate an arm generated (admitted or rejected), as the store holds it. */
export interface JudgeCandidateInput {
  seed_id: string;
  hypothesis: string;
  mechanism?: string;
  cheapest_test?: string;
  evidence_refs?: readonly string[];
  descriptor_bins?: Record<string, string>;
}

/** One arm's generated candidates. */
export interface JudgeArmInput {
  label: string;
  candidates: ReadonlyArray<JudgeCandidateInput>;
}

export interface BlindCasesResult {
  cases: BlindCase[];
  /** `case_id → {arm, seed_id}`; the arm labels never enter `cases`. */
  mapping: CaseMapping[];
}

/** The PRNG the shuffle is derived from (mulberry32: tiny, deterministic, seeded). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The blinding: one case per candidate the arm generated, in a DETERMINISTIC
 * shuffle derived from `shuffleSeed`, so the judge never sees a run of one arm's
 * ideas and a second run with the same seed sees exactly the same order.
 *
 * The shuffle is a Fisher–Yates over the concatenated candidates (`arm order`,
 * then the arm's own order), driven by a seeded PRNG. Both inputs are stable, so
 * the order is a pure function of `(arms, shuffleSeed)`.
 */
export function blindCases(
  arms: ReadonlyArray<JudgeArmInput>,
  options: { shuffleSeed: number },
): BlindCasesResult {
  const seed = options?.shuffleSeed;
  if (!Number.isFinite(seed) || !Number.isInteger(seed)) {
    throw new Error(`blindCases refused: shuffleSeed '${String(seed)}' is not a whole number`);
  }

  // The flat list, in a canonical order that does not depend on the caller's
  // ordering being stable: arm label, then the candidate's own position.
  const flat: Array<{ arm: string; index: number; candidate: JudgeCandidateInput }> = [];
  for (const arm of [...arms].sort((left, right) => String(left.label).localeCompare(String(right.label)))) {
    arm.candidates.forEach((candidate, index) => flat.push({ arm: String(arm.label), index, candidate }));
  }

  const random = mulberry32(seed >>> 0);
  for (let i = flat.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [flat[i], flat[j]] = [flat[j], flat[i]];
  }

  const cases: BlindCase[] = [];
  const mapping: CaseMapping[] = [];
  flat.forEach((entry, position) => {
    const hypothesis = String(entry.candidate?.hypothesis ?? '').trim();
    if (hypothesis.length === 0) {
      throw new Error(
        `blindCases refused: arm ${entry.arm} candidate ${entry.index} carries no hypothesis — ` +
          'a case with nothing to judge would be a silent hole in the denominator',
      );
    }
    const seedId = String(entry.candidate?.seed_id ?? '').trim();
    if (seedId.length === 0) {
      throw new Error(`blindCases refused: arm ${entry.arm} candidate ${entry.index} carries no seed_id`);
    }
    const caseId = `case_${String(position + 1).padStart(2, '0')}`;
    // Field by field: no spread of the source row, so nothing else can leak.
    cases.push({
      case_id: caseId,
      hypothesis,
      mechanism: String(entry.candidate.mechanism ?? ''),
      cheapest_test: String(entry.candidate.cheapest_test ?? ''),
      evidence_refs: [...(entry.candidate.evidence_refs ?? [])].map((ref) => String(ref)),
      descriptor_bins: { ...(entry.candidate.descriptor_bins ?? {}) },
    });
    mapping.push({ case_id: caseId, arm: entry.arm, seed_id: seedId });
  });
  mapping.sort((left, right) => left.case_id.localeCompare(right.case_id));
  return { cases, mapping };
}

// ── The prompt (frozen) ────────────────────────────────────────────────────

/**
 * The judge's system prompt — FROZEN. Every batch of cases is judged with these
 * exact words (the driver sends it as the system instruction and records its
 * sha256 in the capture), so the question asked of the two arms is one question
 * rather than two.
 */
export const JUDGE_SYSTEM_PROMPT = `You are the blind judge of an experiment about idea-generation engines.

You will receive a JSON list of candidate ideas produced by different engines on the same mission. You do not know which engine produced which candidate, and you must not try to guess: judge each candidate on what it says.

For EVERY case, answer three questions in order.

1. Is this a TESTABLE DIRECTION that would change what the mission does next? Put the answer in "verdict", using exactly one of these three names:
   - "useful_information" — a testable direction whose result would change what the mission does next. Naming the test and the decision it would change is what makes an idea useful: a cheaper test for the same decision, a sharper hypothesis the mission can act on, or evidence that would settle a live question all count.
   - "mere_variance" — a restatement or a variation that changes nothing. It may be well-formed and true, but if testing it would leave the mission taking the same next action, it is variance, not information.
   - "unnecessary_cost" — an idea whose obvious test costs more than the decision it informs. The test may exist and be valid, but running it buys less than it costs, so acting on it is a loss.

2. Score four qualities of the candidate, each a number from 0 to 1 (0 = none, 1 = maximal):
   - "novelty" — how far the candidate is from the mission's existing framing and from the other candidates;
   - "coherence" — whether the mechanism it states actually supports the hypothesis;
   - "testability" — whether the cheapest test it names could really be run and could really fail;
   - "information_gain" — how much the mission's next decision would change if that test were run.

3. Give a "reason": one sentence, at most 200 characters, that names what decided the verdict. No praise, no hedging, no restating the candidate.

Reply with ONLY a JSON object, in exactly this shape, with one entry per case you were given, in the order you were given them:
{ "verdicts": [ { "case_id": "case_01", "verdict": "useful_information", "novelty": 0.0, "coherence": 0.0, "testability": 0.0, "information_gain": 0.0, "reason": "one sentence" } ] }

Rules: every "case_id" you were given must appear exactly once, and no other "case_id" may appear. "verdict" must be one of the three names above. Every score must be a number in 0..1. Do not add fields. Do not explain outside the JSON object.`;

/** One case as the judge's USER content sees it (compact JSON, stable key order). */
function caseLine(item: BlindCase): string {
  return JSON.stringify({
    case_id: item.case_id,
    hypothesis: item.hypothesis,
    mechanism: item.mechanism,
    cheapest_test: item.cheapest_test,
    evidence_refs: item.evidence_refs,
    descriptor_bins: item.descriptor_bins,
  });
}

/**
 * The judge's user content for one batch: the cases, one JSON object per line,
 * with nothing else in them. Deterministic (the driver's transcript records it
 * verbatim), and bounded by the caller's batch size rather than by the run.
 */
export function judgePrompt(cases: ReadonlyArray<BlindCase>): string {
  return [
    `Judge the ${cases.length} blinded case(s) below. Apply the system instruction to each one.`,
    'Each line is one case, as a JSON object. The "case_id" is opaque; judge the content only.',
    '',
    ...cases.map((item, index) => `${String(index + 1).padStart(2, '0')}. ${caseLine(item)}`),
    '',
    'Answer with the JSON object described in the system instruction: one entry per case_id, the same order, no extra text.',
  ].join('\n');
}

// ── The reply parser ───────────────────────────────────────────────────────

export const JUDGE_VERDICTS = ['useful_information', 'mere_variance', 'unnecessary_cost'] as const;
export type JudgeVerdictName = (typeof JUDGE_VERDICTS)[number];

export interface JudgedCase {
  case_id: string;
  verdict: JudgeVerdictName;
  novelty: number;
  coherence: number;
  testability: number;
  information_gain: number;
  reason: string;
}

export interface JudgeParseResult {
  /** The verdicts, in the ORDER of the cases they were asked about. */
  verdicts: JudgedCase[];
  /** Every case that could not be judged, NAMED with the reason. Never empty for a bad reply. */
  refusals: string[];
}

const SCORE_FIELDS = ['novelty', 'coherence', 'testability', 'information_gain'] as const;

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return `object(${Object.keys(value as Record<string, unknown>).join(',') || 'empty'})`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * Parse one judge reply, strictly.
 *
 * The reply is accepted as a `{verdicts: [...]}` object (the shape the prompt
 * asks for) or as a bare array (some providers drop the wrapper). EVERY other
 * deviation is a NAMED refusal: a case with no entry, an entry naming a case
 * that was not asked about, a case answered twice, an unknown verdict name, or a
 * score that is not a finite number in 0..1. Nothing is coerced into range and
 * nothing is dropped silently — a refusal names the case and what was wrong with
 * it, so the driver can record it verbatim and a reader can see exactly which
 * cases the run could not judge.
 */
export function parseJudgeReply(raw: unknown, cases: ReadonlyArray<BlindCase>): JudgeParseResult {
  const refusals: string[] = [];
  const expected = cases.map((item) => String(item.case_id));

  let entries: unknown = null;
  if (Array.isArray(raw)) entries = raw;
  else if (raw && typeof raw === 'object') {
    const block = (raw as Record<string, unknown>).verdicts;
    if (Array.isArray(block)) entries = block;
  }
  if (entries === null) {
    refusals.push(
      `reply: no 'verdicts' array (received ${describeValue(raw)}) — the whole reply is unusable, so every case is refused`,
    );
    for (const caseId of expected) refusals.push(`${caseId}: no verdict — the reply carried no 'verdicts' array`);
    return { verdicts: [], refusals };
  }

  const byCase = new Map<string, Record<string, unknown>[]>();
  (entries as unknown[]).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      refusals.push(`verdicts[${index}]: not an object (${describeValue(entry)})`);
      return;
    }
    const caseId = String((entry as Record<string, unknown>).case_id ?? '').trim();
    if (caseId.length === 0) {
      refusals.push(`verdicts[${index}]: no case_id`);
      return;
    }
    if (!expected.includes(caseId)) {
      refusals.push(`verdicts[${index}]: unknown case_id '${caseId}' — it was not among the ${expected.length} case(s) sent`);
      return;
    }
    byCase.set(caseId, [...(byCase.get(caseId) ?? []), entry as Record<string, unknown>]);
  });

  const verdicts: JudgedCase[] = [];
  for (const caseId of expected) {
    const found = byCase.get(caseId) ?? [];
    if (found.length === 0) {
      refusals.push(`${caseId}: missing — the reply carried no verdict for this case`);
      continue;
    }
    if (found.length > 1) {
      refusals.push(`${caseId}: answered ${found.length} times — a case has exactly one verdict`);
      continue;
    }
    const entry = found[0];
    const verdictName = String(entry.verdict ?? '').trim();
    if (!(JUDGE_VERDICTS as readonly string[]).includes(verdictName)) {
      refusals.push(
        `${caseId}: unknown verdict '${String(entry.verdict ?? '')}' (expected one of ${JUDGE_VERDICTS.join(' | ')})`,
      );
      continue;
    }
    const scores: Record<string, number> = {};
    let bad = false;
    for (const field of SCORE_FIELDS) {
      const value = entry[field];
      const number = typeof value === 'number' ? value : Number.NaN;
      if (!Number.isFinite(number) || number < 0 || number > 1) {
        refusals.push(`${caseId}: ${field} ${describeValue(value)} is not a number in 0..1`);
        bad = true;
        break;
      }
      scores[field] = number;
    }
    if (bad) continue;
    verdicts.push({
      case_id: caseId,
      verdict: verdictName as JudgeVerdictName,
      novelty: scores.novelty,
      coherence: scores.coherence,
      testability: scores.testability,
      information_gain: scores.information_gain,
      reason: String(entry.reason ?? '').trim(),
    });
  }

  return { verdicts, refusals };
}

// ── The harness's `--grade` file ───────────────────────────────────────────

export interface GradeRow {
  arm: string;
  novelty: number;
  coherence: number;
  testability: number;
  information_gain: number;
  n: number;
  note: string;
}

export interface GradesFile {
  grades: GradeRow[];
}

/**
 * The per-arm means of the blind scores, in the harness's `--grade` shape
 * (`node scripts/imagination-baseline.mjs --grade <file>` accepts exactly these
 * fields, each 0..1, and `n` is the sample behind the mean).
 *
 * The arm has to come from somewhere: a verdict knows only its opaque case_id.
 * It is read from the verdict itself when the caller enriched it (a `{...verdict,
 * ...mapping}` spread), otherwise from the mapping table passed as the second
 * argument — which is the same table the transcript carries and which never
 * entered a payload. A verdict that resolves to no arm is REFUSED by name: an
 * unlabelled mean would silently mix two arms into one number.
 */
export function gradesFromVerdicts(
  verdicts: ReadonlyArray<JudgedCase & { arm?: string }>,
  mapping?: ReadonlyArray<CaseMapping>,
): GradesFile {
  const byCase = new Map<string, CaseMapping>();
  for (const row of mapping ?? []) byCase.set(String(row.case_id), row);
  const grouped = new Map<string, JudgedCase[]>();
  for (const verdict of verdicts) {
    const arm = String(verdict.arm ?? byCase.get(String(verdict.case_id))?.arm ?? '').trim();
    if (arm.length === 0) {
      throw new Error(
        `gradesFromVerdicts refused: case ${verdict.case_id} resolves to no arm — pass the mapping table ` +
          '(the per-arm means cannot be formed from an unlabelled verdict)',
      );
    }
    grouped.set(arm, [...(grouped.get(arm) ?? []), verdict]);
  }
  const mean = (values: number[]): number => Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6));
  const grades = [...grouped.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([arm, rows]) => {
      const counts = JUDGE_VERDICTS.map(
        (name) => `${name} ${rows.filter((row) => row.verdict === name).length}`,
      ).join(', ');
      return {
        arm,
        novelty: mean(rows.map((row) => row.novelty)),
        coherence: mean(rows.map((row) => row.coherence)),
        testability: mean(rows.map((row) => row.testability)),
        information_gain: mean(rows.map((row) => row.information_gain)),
        n: rows.length,
        note: `blinded live judge: the mean of ${rows.length} judged case(s) of arm ${arm}'s candidates (${counts}); the judge saw only the candidate text under an opaque case id, and every raw reply, the prompt and the shuffle seed are in the judge transcript`.slice(
          0,
          2000,
        ),
      };
    });
  return { grades };
}

/** The sha256 of the frozen system prompt, as the capture records it. */
export function judgePromptSha256(): string {
  return createHash('sha256').update(JUDGE_SYSTEM_PROMPT).digest('hex');
}
