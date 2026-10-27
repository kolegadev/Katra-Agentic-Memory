/**
 * The blind judge's own tests (ITER-11, WS-4): pure, no network, no store.
 *
 * The instrument that closes DoD bullet 8 makes two promises a reader has to be
 * able to check WITHOUT running a live model: that the judge cannot see which
 * arm a candidate came from, and that a bad reply is refused by name instead of
 * being averaged into the result. Both are asserted here over the exact
 * functions the live driver calls.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_SHUFFLE_SEED,
  JUDGE_BATCH_SIZE,
  JUDGE_SYSTEM_PROMPT,
  JUDGE_VERDICTS,
  blindCases,
  defaultGradesPath,
  defaultTranscriptPath,
  gradesFromVerdicts,
  judgePrompt,
  judgePromptSha256,
  liveRunConfigFromEnv,
  parseJudgeReply,
  type BlindCase,
  type JudgeArmInput,
} from '../helpers/imagination-blind-judge.js';

const MISSION = 'mission_creative_baton_run_alpha';
const IDENTITY = 'engine-alpha';
const ARM_LABELS = ['A', 'B', 'C'] as const;

/** Three arms, four distinctive candidates each: every field is a marker. */
function arms(): JudgeArmInput[] {
  return ARM_LABELS.map((label, armIndex) => ({
    label,
    candidates: [1, 2, 3, 4].map((index) => ({
      seed_id: `seed_${label}_${index}`,
      hypothesis: `ARM${label}-HYPOTHESIS-${index}`,
      mechanism: `ARM${label}-MECHANISM-${index}`,
      cheapest_test: `ARM${label}-TEST-${index}`,
      evidence_refs: [`sig_${label}_${armIndex}_${index}`],
      descriptor_bins: { mechanism: `bin-${label}-${index}` },
    })),
  }));
}

function replyFor(cases: ReadonlyArray<BlindCase>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdicts: cases.map((item) => ({
      case_id: item.case_id,
      verdict: 'useful_information',
      novelty: 0.8,
      coherence: 0.7,
      testability: 0.6,
      information_gain: 0.5,
      reason: `judged ${item.case_id}`,
      ...overrides,
    })),
  };
}

describe('liveRunConfigFromEnv', () => {
  const full = {
    IMAGINATION_BASELINE_USER: IDENTITY,
    IMAGINATION_BASELINE_RUN: 'run-2026-09-26',
    IMAGINATION_BASELINE_OUT: '/tmp/out/baseline-live.json',
  };

  it('names every missing required variable and defaults nothing', () => {
    const result = liveRunConfigFromEnv({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('IMAGINATION_BASELINE_USER');
    expect(result.reason).toContain('IMAGINATION_BASELINE_RUN');
    expect(result.reason).toContain('IMAGINATION_BASELINE_OUT');
    expect(result.reason).toContain('REFUSED');
  });

  it('refuses a blank value the same way it refuses an unset one', () => {
    const result = liveRunConfigFromEnv({ ...full, IMAGINATION_BASELINE_RUN: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('IMAGINATION_BASELINE_RUN');
    expect(result.reason).not.toContain('IMAGINATION_BASELINE_USER,');
  });

  it('reads the required three and applies the documented defaults', () => {
    const result = liveRunConfigFromEnv(full);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.user).toBe(IDENTITY);
    expect(result.config.run).toBe('run-2026-09-26');
    expect(result.config.out).toBe('/tmp/out/baseline-live.json');
    expect(result.config.maxCandidates).toBe(DEFAULT_MAX_CANDIDATES);
    expect(result.config.maxCandidates).toBe(40);
    expect(result.config.shuffleSeed).toBe(DEFAULT_SHUFFLE_SEED);
    expect(result.config.shuffleSeed).toBe(20260926);
    expect(result.config.judge).toBeNull();
    expect(result.config.grades).toBe('/tmp/out/baseline-live-GRADES.json');
  });

  it('takes the optional knobs when they are given', () => {
    const result = liveRunConfigFromEnv({
      ...full,
      IMAGINATION_BASELINE_GRADES: '/tmp/out/grades.json',
      IMAGINATION_BASELINE_JUDGE: 'judge-model',
      IMAGINATION_BASELINE_MAX_CANDIDATES: '12',
      IMAGINATION_BASELINE_SHUFFLE_SEED: '7',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.grades).toBe('/tmp/out/grades.json');
    expect(result.config.judge).toBe('judge-model');
    expect(result.config.maxCandidates).toBe(12);
    expect(result.config.shuffleSeed).toBe(7);
  });

  it('refuses a non-numeric bound by name instead of coercing it', () => {
    for (const value of ['many', '0', '-3', '1.5']) {
      const result = liveRunConfigFromEnv({ ...full, IMAGINATION_BASELINE_MAX_CANDIDATES: value });
      expect(result.ok, `value ${value}`).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toContain('IMAGINATION_BASELINE_MAX_CANDIDATES');
      expect(result.reason).toContain('REFUSED');
    }
  });

  it('refuses a shuffle seed that is not a whole number', () => {
    const result = liveRunConfigFromEnv({ ...full, IMAGINATION_BASELINE_SHUFFLE_SEED: 'seed' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('IMAGINATION_BASELINE_SHUFFLE_SEED');
  });

  it('refuses a run token that would not be a safe mission-id suffix', () => {
    for (const value of ['has space', 'a/b', 'a$b', 'x'.repeat(65), '-leading']) {
      const result = liveRunConfigFromEnv({ ...full, IMAGINATION_BASELINE_RUN: value });
      expect(result.ok, `token ${value}`).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toContain('IMAGINATION_BASELINE_RUN');
    }
  });

  it('derives the grades and transcript paths from the capture path', () => {
    expect(defaultGradesPath('/tmp/x/baseline.json')).toBe('/tmp/x/baseline-GRADES.json');
    expect(defaultGradesPath('/tmp/x/baseline')).toBe('/tmp/x/baseline-GRADES.json');
    expect(defaultTranscriptPath('/tmp/x/baseline.json')).toBe('/tmp/x/baseline-JUDGE.json');
  });
});

describe('blindCases — blinding', () => {
  const { cases, mapping } = blindCases(arms(), { shuffleSeed: 20260926 });

  it('carries ONLY the five judgeable fields, and nothing else', () => {
    expect(cases).toHaveLength(12);
    for (const item of cases) {
      expect(Object.keys(item)).toEqual([
        'case_id',
        'hypothesis',
        'mechanism',
        'cheapest_test',
        'evidence_refs',
        'descriptor_bins',
      ]);
      expect(item.case_id).toMatch(/^case_\d{2}$/);
    }
  });

  it('leaks no arm label, seed id, identity or mission id into a payload', () => {
    const payload = JSON.stringify(cases);
    for (const secret of ['seed_A_', 'seed_B_', 'seed_C_', MISSION, IDENTITY, '"arm"', 'label']) {
      expect(payload, `payload leaked ${secret}`).not.toContain(secret);
    }
    // The arm labels themselves are single letters: check them as JSON values,
    // not as substrings of the sentence text the fixtures carry.
    expect(payload).not.toContain('"A"');
    expect(payload).not.toContain('"B"');
    expect(payload).not.toContain('"C"');
  });

  it('keeps the mapping OUT of the payloads and names the true source of each case', () => {
    expect(mapping).toHaveLength(12);
    const byCase = new Map(mapping.map((row) => [row.case_id, row]));
    for (const item of cases) {
      const source = byCase.get(item.case_id)!;
      expect(source).toBeTruthy();
      const [label, index] = source.seed_id.replace('seed_', '').split('_');
      expect(source.arm).toBe(label);
      expect(item.hypothesis).toBe(`ARM${label}-HYPOTHESIS-${index}`);
      expect(item.mechanism).toBe(`ARM${label}-MECHANISM-${index}`);
      expect(item.cheapest_test).toBe(`ARM${label}-TEST-${index}`);
      expect(item.descriptor_bins).toEqual({ mechanism: `bin-${label}-${index}` });
      expect(item.evidence_refs).toHaveLength(1);
    }
    // Every candidate is judged exactly once: case ids are unique and the
    // mapping covers the whole input.
    expect(new Set(cases.map((item) => item.case_id)).size).toBe(12);
    expect(new Set(mapping.map((row) => `${row.arm}/${row.seed_id}`)).size).toBe(12);
  });

  it('does not carry a bare `arm` key on a case', () => {
    for (const item of cases) expect((item as unknown as Record<string, unknown>).arm).toBeUndefined();
  });
});

describe('blindCases — the deterministic shuffle', () => {
  it('is a pure function of (arms, shuffleSeed)', () => {
    const first = blindCases(arms(), { shuffleSeed: 20260926 });
    const second = blindCases(arms(), { shuffleSeed: 20260926 });
    expect(second).toEqual(first);
  });

  it('interleaves the arms instead of blocking them, and changes with the seed', () => {
    const seeded = blindCases(arms(), { shuffleSeed: 20260926 });
    const order = seeded.mapping.map((row) => row.arm);
    // Not the input order (A…A B…B C…C) and not arm-blocked.
    expect(order).not.toEqual(['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B', 'C', 'C', 'C', 'C']);
    expect(new Set(order.slice(0, 3)).size).toBeGreaterThan(1);
    const other = blindCases(arms(), { shuffleSeed: 7 });
    expect(other.cases.map((item) => item.case_id)).toEqual(seeded.cases.map((item) => item.case_id));
    expect(other.cases).not.toEqual(seeded.cases);
  });

  it('refuses a non-integer seed rather than shuffling with NaN', () => {
    expect(() => blindCases(arms(), { shuffleSeed: Number.NaN })).toThrow(/shuffleSeed/);
    expect(() => blindCases(arms(), { shuffleSeed: 1.5 })).toThrow(/shuffleSeed/);
  });

  it('refuses a candidate with no hypothesis (a silent hole in the denominator)', () => {
    expect(() =>
      blindCases([{ label: 'A', candidates: [{ seed_id: 'seed_x', hypothesis: '   ' }] }], { shuffleSeed: 1 }),
    ).toThrow(/no hypothesis/);
  });
});

describe('judgePrompt and the frozen system prompt', () => {
  const { cases } = blindCases(arms(), { shuffleSeed: 20260926 });

  it('states all three verdicts, the four scores and the JSON shape', () => {
    for (const verdict of JUDGE_VERDICTS) expect(JUDGE_SYSTEM_PROMPT).toContain(verdict);
    expect(JUDGE_SYSTEM_PROMPT).toContain('would change what the mission does next');
    expect(JUDGE_SYSTEM_PROMPT).toContain('restatement or a variation that changes nothing');
    expect(JUDGE_SYSTEM_PROMPT).toContain('costs more than the decision it informs');
    expect(JUDGE_SYSTEM_PROMPT).toContain('"verdicts"');
    for (const field of ['novelty', 'coherence', 'testability', 'information_gain']) {
      expect(JUDGE_SYSTEM_PROMPT).toContain(`"${field}"`);
    }
    expect(JUDGE_SYSTEM_PROMPT).toContain('200 characters');
    expect(judgePromptSha256()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries every case, deterministically, with no arm information', () => {
    const prompt = judgePrompt(cases);
    for (const item of cases) {
      expect(prompt).toContain(item.case_id);
      expect(prompt).toContain(item.hypothesis);
      expect(prompt).toContain(item.cheapest_test);
    }
    expect(judgePrompt(cases)).toBe(prompt);
    expect(prompt).not.toContain('seed_A_');
    expect(prompt).not.toContain('"arm"');
    expect(prompt.split('\n').filter((line) => line.includes('"case_id":'))).toHaveLength(cases.length);
  });

  it('is used in bounded batches', () => {
    expect(JUDGE_BATCH_SIZE).toBe(10);
    const batch = cases.slice(0, JUDGE_BATCH_SIZE);
    expect(judgePrompt(batch)).toContain(`Judge the ${JUDGE_BATCH_SIZE} blinded case(s)`);
  });
});

describe('parseJudgeReply — refusals by name', () => {
  const { cases } = blindCases(arms(), { shuffleSeed: 20260926 });
  const batch = cases.slice(0, 3);

  it('accepts a complete reply, in case order', () => {
    const parsed = parseJudgeReply(replyFor(batch), batch);
    expect(parsed.refusals).toEqual([]);
    expect(parsed.verdicts).toHaveLength(3);
    expect(parsed.verdicts.map((verdict) => verdict.case_id)).toEqual(batch.map((item) => item.case_id));
    expect(parsed.verdicts[0]).toEqual({
      case_id: batch[0].case_id,
      verdict: 'useful_information',
      novelty: 0.8,
      coherence: 0.7,
      testability: 0.6,
      information_gain: 0.5,
      reason: `judged ${batch[0].case_id}`,
    });
  });

  it('accepts a bare array too, and refuses a reply that is not a verdict list at all', () => {
    expect(parseJudgeReply(replyFor(batch).verdicts, batch).verdicts).toHaveLength(3);
    const empty = parseJudgeReply({}, batch);
    expect(empty.verdicts).toEqual([]);
    expect(empty.refusals).toHaveLength(4); // the reply itself + one per case
    expect(empty.refusals[0]).toContain("no 'verdicts' array");
    for (const item of batch) expect(empty.refusals.join('\n')).toContain(`${item.case_id}: no verdict`);
  });

  it('refuses a MISSING case by name and still judges the rest', () => {
    const reply = replyFor(batch);
    (reply.verdicts as unknown[]).pop();
    const parsed = parseJudgeReply(reply, batch);
    expect(parsed.verdicts.map((verdict) => verdict.case_id)).toEqual([batch[0].case_id, batch[1].case_id]);
    expect(parsed.refusals).toEqual([`${batch[2].case_id}: missing — the reply carried no verdict for this case`]);
  });

  it('refuses an UNKNOWN VERDICT by name and never coerces it to one of the three', () => {
    const parsed = parseJudgeReply(replyFor(batch, { verdict: 'mildly_interesting' }), batch);
    expect(parsed.verdicts).toEqual([]);
    expect(parsed.refusals).toHaveLength(3);
    for (const refusal of parsed.refusals) expect(refusal).toContain("unknown verdict 'mildly_interesting'");
  });

  it('refuses an OUT-OF-RANGE or non-numeric score by name, per field', () => {
    const casesOf: Array<[Record<string, unknown>, string]> = [
      [{ information_gain: 1.4 }, 'information_gain number 1.4 is not a number in 0..1'],
      [{ novelty: -0.2 }, 'novelty number -0.2 is not a number in 0..1'],
      [{ coherence: '0.9' }, 'coherence string "0.9" is not a number in 0..1'],
      [{ testability: null }, 'testability null is not a number in 0..1'],
      [{ testability: undefined }, 'testability undefined is not a number in 0..1'],
    ];
    for (const [override, expected] of casesOf) {
      const parsed = parseJudgeReply(replyFor(batch, override), batch);
      expect(parsed.verdicts).toEqual([]);
      expect(parsed.refusals).toHaveLength(3);
      for (const refusal of parsed.refusals) expect(refusal).toContain(expected);
    }
  });

  it('refuses a duplicated or unknown case_id', () => {
    const duplicated = replyFor(batch);
    (duplicated.verdicts as unknown[]).push((duplicated.verdicts as unknown[])[0]);
    const parsedDuplicate = parseJudgeReply(duplicated, batch);
    expect(parsedDuplicate.refusals.join('\n')).toContain('answered 2 times');
    expect(parsedDuplicate.verdicts.map((verdict) => verdict.case_id)).toEqual([
      batch[1].case_id,
      batch[2].case_id,
    ]);

    const withStranger = replyFor(batch);
    (withStranger.verdicts as Array<Record<string, unknown>>).push({
      case_id: 'case_99',
      verdict: 'mere_variance',
      novelty: 0.1,
      coherence: 0.1,
      testability: 0.1,
      information_gain: 0.1,
      reason: 'not asked about',
    });
    const parsedStranger = parseJudgeReply(withStranger, batch);
    expect(parsedStranger.verdicts).toHaveLength(3);
    expect(parsedStranger.refusals.join('\n')).toContain("unknown case_id 'case_99'");
  });

  it('accepts an entry that carries extra fields (it reads what it asked for) and an absent reason', () => {
    const reply = replyFor(batch);
    const first = (reply.verdicts as Array<Record<string, unknown>>)[0];
    first.confidence = 'high';
    delete first.reason;
    const parsed = parseJudgeReply(reply, batch);
    expect(parsed.refusals).toEqual([]);
    expect(parsed.verdicts[0].reason).toBe('');
  });
});

describe('gradesFromVerdicts — the harness --grade file', () => {
  const { cases, mapping } = blindCases(arms(), { shuffleSeed: 20260926 });

  it('means each arm’s own scores and reports the sample behind them', () => {
    const verdicts = cases.map((item, index) => ({
      case_id: item.case_id,
      verdict: (index % 2 === 0 ? 'useful_information' : 'mere_variance') as 'useful_information' | 'mere_variance',
      novelty: index % 3 === 0 ? 1 : 0,
      coherence: 0.5,
      testability: 0.25,
      information_gain: 0.75,
      reason: `case ${item.case_id}`,
    }));
    const file = gradesFromVerdicts(verdicts, mapping);
    expect(file.grades.map((row) => row.arm)).toEqual(['A', 'B', 'C']);
    const armC = file.grades.find((row) => row.arm === 'C')!;
    expect(armC.n).toBe(4);
    expect(armC.coherence).toBe(0.5);
    expect(armC.testability).toBe(0.25);
    expect(armC.information_gain).toBe(0.75);
    expect(armC.novelty).toBe(0.25); // one of the four cases scored 1, the rest 0
    const cCaseIds = mapping.filter((row) => row.arm === 'C').map((row) => row.case_id);
    const usefulInC = cases.reduce(
      (total, item, index) => total + (index % 2 === 0 && cCaseIds.includes(item.case_id) ? 1 : 0),
      0,
    );
    expect(armC.note).toContain(
      `useful_information ${usefulInC}, mere_variance ${armC.n - usefulInC}, unnecessary_cost 0`,
    );
    for (const row of file.grades) {
      for (const field of ['novelty', 'coherence', 'testability', 'information_gain'] as const) {
        expect(row[field]).toBeGreaterThanOrEqual(0);
        expect(row[field]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('takes the arm from an enriched verdict when one is present', () => {
    const file = gradesFromVerdicts([
      { ...cases[0], arm: 'A', verdict: 'unnecessary_cost', novelty: 0, coherence: 0, testability: 0, information_gain: 0, reason: '' },
      { ...cases[1], arm: 'D', verdict: 'mere_variance', novelty: 0.5, coherence: 0.5, testability: 0.5, information_gain: 0.5, reason: '' },
    ] as never);
    expect(file.grades.map((row) => row.arm)).toEqual(['A', 'D']);
  });

  it('refuses a verdict that resolves to no arm', () => {
    expect(() =>
      gradesFromVerdicts([
        { case_id: 'case_01', verdict: 'useful_information', novelty: 1, coherence: 1, testability: 1, information_gain: 1, reason: '' },
      ]),
    ).toThrow(/resolves to no arm/);
  });
});
