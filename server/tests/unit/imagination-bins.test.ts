/**
 * ITER-11, WS-2 (DoD #3) — the CONFIGURABLE descriptor space.
 *
 * Contract: `CONTRACT-iter11-dod-closure.md` §WS-2 and success criterion 1:
 *
 *   "a custom bin dimension configured via `IMAGINATION_BINS` flows through
 *    bins → cells → coverage → baton validation, proven by a test; the default
 *    space is unchanged when unset."
 *
 * Every assertion below the "the default space is unchanged" block FAILS
 * against the pre-iteration sources: there `DESCRIPTOR_DIMENSIONS` was a closed
 * five-element constant, `DESCRIPTOR_BINS` a frozen literal, and
 * `validateCoverageGaps` re-validated every gap against that literal — so a
 * configured dimension (`risk`) could never appear in a cell key, in the
 * coverage view, or in a compiled baton, and the hostile configurations were
 * not validated anywhere (the value was not read at all).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { FakeDb } from '../helpers/fake-mongo.js';
import { candidateSeed, seedMission } from '../helpers/imagination-scenario.js';
import {
  DEFAULT_DESCRIPTOR_BINS,
  DEFAULT_DESCRIPTOR_DIMENSIONS,
  MAX_BINS_PER_DIMENSION,
  MAX_BINS_CONFIG_CHARS,
  MAX_DESCRIPTOR_DIMENSIONS,
  PROTOTYPE_KEY_NAMES,
  descriptorSpace,
  descriptorSpaceReport,
  isPrototypeKeyName,
} from '../../src/services/processing/descriptor-space.js';
import {
  IdeaArchiveService,
  activeDescriptorBins,
  activeDescriptorDimensions,
  cellKeyFor,
  normalizeBins,
  possibleCellCount,
} from '../../src/services/processing/idea-archive-service.js';
import {
  compileCreativeBaton,
  validateCoverageGaps,
  validateCreativeBaton,
} from '../../src/services/processing/creative-baton-compiler.js';
import { validateAgainst, SCHEMA_IDS } from '../../src/services/mission-cognition/schema-registry.js';

/** The custom space the contract's success criterion names. */
const CUSTOM_BINS = '{"mechanism":["a","b"],"risk":["low","high"]}';

const MISSION = 'mission_custom_bins';
const USER = 'agent-a';

/** The default cell key of an all-unclassified seed, from the default constants. */
function defaultCellKey(): string {
  return DEFAULT_DESCRIPTOR_DIMENSIONS.map((dimension) => `${dimension}=unclassified`).join('|');
}

beforeEach(() => {
  delete process.env.IMAGINATION_BINS;
});

afterEach(() => {
  delete process.env.IMAGINATION_BINS;
});

describe('the default space is unchanged when IMAGINATION_BINS is unset', () => {
  it('resolves the closed five-dimension space, exactly as the constants define it', () => {
    const space = descriptorSpace();
    expect(space.source).toBe('defaults');
    expect(space.env_present).toBe(false);
    expect(space.refused).toBeNull();
    expect([...space.dimensions]).toEqual([...DEFAULT_DESCRIPTOR_DIMENSIONS]);
    for (const dimension of DEFAULT_DESCRIPTOR_DIMENSIONS) {
      expect([...space.bins[dimension]]).toEqual([...DEFAULT_DESCRIPTOR_BINS[dimension]]);
    }
    expect(activeDescriptorDimensions()).toEqual([...DEFAULT_DESCRIPTOR_DIMENSIONS]);
    // 7 bins per dimension (6 + the unclassified fallback) ^ 5 dimensions.
    expect(possibleCellCount()).toBe(7 ** 5);
    expect(defaultCellKey()).toBe(
      'mechanism=unclassified|representation=unclassified|violated_assumption=unclassified|evidence_family=unclassified|test_strategy=unclassified',
    );
  });

  it('an empty or whitespace value is "unset", not a space with no dimensions', () => {
    process.env.IMAGINATION_BINS = '   ';
    const space = descriptorSpace();
    expect(space.source).toBe('defaults');
    expect(space.refused).toBeNull();
    expect([...space.dimensions]).toEqual([...DEFAULT_DESCRIPTOR_DIMENSIONS]);
  });

  it('an archived seed still lands in the default cell key and the default coverage view', async () => {
    const db = new FakeDb();
    await seedMission(db, { missionId: MISSION, ownerId: USER });
    const archive = new IdeaArchiveService(db.asDb());
    const result = await archive.admitOrReplace(candidateSeed(0, { mission_id: MISSION, user_id: USER }));
    expect(result.decision).toBe('admitted');
    const seed = result.seed!;
    expect(seed.cell_key).toBe(
      'mechanism=removal|representation=prose|violated_assumption=necessity|evidence_family=epistemic_ledger|test_strategy=kill_criterion',
    );
    expect(validateAgainst(SCHEMA_IDS.ideaSeed, seed).valid).toBe(true);
    const coverage = await archive.coverage(MISSION, USER);
    expect(coverage.descriptor_dimensions).toEqual([...DEFAULT_DESCRIPTOR_DIMENSIONS]);
    expect(coverage.scan.cells_unknown_dimension).toBe(0);
    expect(coverage.gaps.map((gap) => gap.dimension)).toEqual([...DEFAULT_DESCRIPTOR_DIMENSIONS]);
  });
});

describe('hostile configurations are refused BY NAME and the defaults stay in force', () => {
  const hostile: Array<{ name: string; value: string; code: string }> = [
    { name: 'not JSON', value: '{"mechanism":["a"]', code: 'not_json' },
    { name: 'a JSON array', value: '["mechanism"]', code: 'not_object' },
    { name: 'a JSON scalar', value: '"mechanism"', code: 'not_object' },
    { name: 'JSON null', value: 'null', code: 'not_object' },
    { name: 'no dimensions at all', value: '{}', code: 'invalid_dimensions' },
    { name: 'an uppercase dimension name', value: '{"Mechanism":["a"]}', code: 'invalid_dimension' },
    { name: 'a dimension name with punctuation', value: '{"risk!":["a"]}', code: 'invalid_dimension' },
    { name: 'a reserved dimension name', value: '{"unclassified":["a"]}', code: 'reserved_dimension' },
    { name: '`constructor` as a dimension name', value: '{"constructor":["a"]}', code: 'prototype_dimension' },
    { name: '`toString` as a dimension name', value: '{"toString":["a"]}', code: 'prototype_dimension' },
    { name: '`__proto__` as a dimension name', value: '{"__proto__":["a"]}', code: 'prototype_dimension' },
    {
      name: '`constructor` as a dimension name (structured form)',
      value: '{"dimensions":{"constructor":["a"]}}',
      code: 'prototype_dimension',
    },
    { name: '`constructor` as a bin', value: '{"mechanism":["constructor"]}', code: 'prototype_bin' },
    { name: '`valueOf` as a bin', value: '{"mechanism":["valueOf"]}', code: 'prototype_bin' },
    { name: 'bins that are not an array', value: '{"mechanism":"a"}', code: 'invalid_bins' },
    { name: 'an empty bin list', value: '{"mechanism":[]}', code: 'empty_bins' },
    { name: 'a non-string bin', value: '{"mechanism":["a",7]}', code: 'invalid_bin' },
    { name: 'a null bin', value: '{"mechanism":["a",null]}', code: 'invalid_bin' },
    { name: 'a bin that is not a slug', value: '{"mechanism":["A"]}', code: 'invalid_bin' },
    { name: 'the reserved fallback bin', value: '{"mechanism":["unclassified"]}', code: 'reserved_bin' },
    { name: 'a duplicated bin', value: '{"mechanism":["a","a"]}', code: 'duplicate_bin' },
    {
      name: 'a huge config string',
      value: `{"mechanism":["${'a'.repeat(MAX_BINS_CONFIG_CHARS + 1)}"]}`,
      code: 'too_large',
    },
    {
      name: 'a huge bin array',
      value: JSON.stringify({ mechanism: Array.from({ length: MAX_BINS_PER_DIMENSION + 1 }, (_v, i) => `b${i}`) }),
      code: 'too_many_bins',
    },
    {
      name: 'too many dimensions (replace form)',
      value: JSON.stringify({
        replace: true,
        dimensions: Object.fromEntries(
          Array.from({ length: MAX_DESCRIPTOR_DIMENSIONS + 1 }, (_v, i) => [`dim${i}`, ['a']]),
        ),
      }),
      code: 'too_many_dimensions',
    },
    {
      name: 'too many dimensions (extend form)',
      value: JSON.stringify(
        Object.fromEntries(Array.from({ length: MAX_DESCRIPTOR_DIMENSIONS }, (_v, i) => [`dim${i}`, ['a']])),
      ),
      code: 'too_many_dimensions',
    },
    { name: 'an invalid replace flag', value: '{"replace":"yes","dimensions":{"mechanism":["a"]}}', code: 'invalid_replace' },
    { name: 'a structured form without dimensions', value: '{"replace":true}', code: 'invalid_dimensions' },
    { name: 'a structured form with a non-object dimensions', value: '{"dimensions":["mechanism"]}', code: 'invalid_dimensions' },
  ];

  for (const entry of hostile) {
    it(`refuses ${entry.name} (${entry.code}) and leaves the defaults in force`, () => {
      process.env.IMAGINATION_BINS = entry.value;
      const space = descriptorSpace();
      expect(space.refused?.code).toBe(entry.code);
      expect(space.source).toBe('defaults');
      expect(space.env_present).toBe(true);
      expect([...space.dimensions]).toEqual([...DEFAULT_DESCRIPTOR_DIMENSIONS]);
      // A refused config never narrows or widens what the engine can address.
      expect(possibleCellCount()).toBe(7 ** 5);
      const report = descriptorSpaceReport();
      expect(report.refused?.code).toBe(entry.code);
      expect(report.basis).toContain('REFUSED');
    });
  }

  it('a refused config does not disturb an archived seed: the default path still works end to end', async () => {
    process.env.IMAGINATION_BINS = '{"mechanism":["a",';
    const db = new FakeDb();
    await seedMission(db, { missionId: MISSION, ownerId: USER });
    const archive = new IdeaArchiveService(db.asDb());
    const result = await archive.admitOrReplace(candidateSeed(0, { mission_id: MISSION, user_id: USER }));
    expect(result.decision).toBe('admitted');
    expect(result.seed!.cell_key).toContain('representation=prose');
    expect((await archive.coverage(MISSION, USER)).scan.cells_unknown_dimension).toBe(0);
  });
});

/**
 * A name that RESOLVES THROUGH `Object.prototype` is not a name in the space:
 * `{"constructor":[…]}` used to be accepted (it is a legal lowercase slug), and
 * then `space.bins['constructor']` read `Function.prototype`,
 * `possibleCellCount()` multiplied by `Function.length`, and a coverage gap whose
 * dimension was `constructor` made `validateCoverageGaps` THROW on a function's
 * missing `.includes`. Every assertion here fails against the pre-fix sources.
 */
describe('prototype keys are refused BY NAME on both sides of the space', () => {
  it('keeps the denylist derived from Object.prototype, not hand-maintained', () => {
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, name), name).toBe(true);
      expect(isPrototypeKeyName(name), name).toBe(true);
    }
    // The names the space legitimately uses are NOT prototype keys…
    for (const name of [...DEFAULT_DESCRIPTOR_DIMENSIONS, 'risk', 'low', 'unclassified']) {
      expect(isPrototypeKeyName(name), name).toBe(false);
    }
    // …and one of them is what the pattern alone would have let through.
    expect(PROTOTYPE_KEY_NAMES).toContain('constructor');
    expect(PROTOTYPE_KEY_NAMES).toEqual(Object.getOwnPropertyNames(Object.prototype));
  });

  it('refuses a prototype-key dimension or bin by name, and the defaults stay in force', () => {
    for (const value of ['{"constructor":["a"]}', '{"dimensions":{"constructor":["a"]}}']) {
      process.env.IMAGINATION_BINS = value;
      const space = descriptorSpace();
      expect(space.source).toBe('defaults');
      expect(space.refused?.code).toBe('prototype_dimension');
      expect(space.refused?.reason).toContain('Object.prototype');
      expect([...space.dimensions]).toEqual([...DEFAULT_DESCRIPTOR_DIMENSIONS]);
      // Nothing resolved through the prototype: the count is the defaults' own.
      expect(possibleCellCount()).toBe(7 ** 5);
      expect(descriptorSpaceReport().refused?.code).toBe('prototype_dimension');
    }
    for (const value of ['{"mechanism":["constructor"]}', '{"mechanism":["valueOf"]}']) {
      process.env.IMAGINATION_BINS = value;
      expect(descriptorSpace().refused?.code).toBe('prototype_bin');
      expect(descriptorSpace().source).toBe('defaults');
      expect(possibleCellCount()).toBe(7 ** 5);
    }
  });

  it('drops a coverage gap whose dimension is a prototype key instead of reading the prototype', () => {
    // Before the fix this THREW: `vocabularyOf['constructor']` is
    // `Object.prototype.constructor` (truthy), so the gap passed the unknown
    // dimension test and `.includes` was not a function.
    const report = validateCoverageGaps([
      { dimension: 'constructor', unoccupied_bins: ['a'] },
      { dimension: 'toString', unoccupied_bins: ['a'] },
      { dimension: '__proto__', unoccupied_bins: ['a'] },
      { dimension: 'mechanism', unoccupied_bins: ['removal'] },
    ]);
    expect(report.dropped_unknown_dimension).toBe(3);
    expect(report.gaps).toEqual([{ dimension: 'mechanism', unoccupied_bins: ['removal'] }]);
    // A gap naming a prototype key at a dimension that does not exist is
    // dropped whole — never mapped onto a real dimension of the same name.
    expect(report.considered).toBe(4);

    // On a CONFIGURED space the same rule holds: `risk` survives, prototype
    // keys do not become dimensions by being named in a gap.
    process.env.IMAGINATION_BINS = CUSTOM_BINS;
    const configured = validateCoverageGaps([
      { dimension: 'risk', unoccupied_bins: ['low'] },
      { dimension: 'hasOwnProperty', unoccupied_bins: ['low'] },
    ]);
    expect(configured.dropped_unknown_dimension).toBe(1);
    expect(configured.gaps).toEqual([{ dimension: 'risk', unoccupied_bins: ['low'] }]);
  });

  it('counts a stored cell whose dimension is a prototype key as unknown, not as occupancy', async () => {
    // A cell written by an older/hostile writer naming `constructor`: the
    // coverage view must COUNT it and leave it out of the occupancy maps.
    const db = new FakeDb();
    await seedMission(db, { missionId: MISSION, ownerId: USER });
    await db.collection('idea_archive_cells').insertOne({
      cell_key: 'constructor=a',
      user_id: USER,
      mission_id: MISSION,
      bins: { constructor: 'a' },
      created_cycle_id: 'cycle_proto',
      created_at: '2026-09-26T12:00:00.000Z',
    } as never);
    const archive = new IdeaArchiveService(db.asDb());
    const coverage = await archive.coverage(MISSION, USER);
    expect(coverage.scan.cells_unknown_dimension).toBe(1);
    expect(coverage.occupancy.occupied).toBe(0);
    // No OCCUPANCY key was created for it (an own-property check: reading the
    // map with `['constructor']` would find `Object.prototype.constructor`).
    expect(Object.prototype.hasOwnProperty.call(coverage.cells_by_dimension, 'constructor')).toBe(false);
    expect(Object.keys(coverage.cells_by_dimension)).toEqual([...DEFAULT_DESCRIPTOR_DIMENSIONS]);
    expect(coverage.occupancy.possible).toBe(7 ** 5);
  });
});

describe('a custom dimension flows bins → cell keys → coverage → baton re-validation', () => {
  it('normalises a custom dimension and counts the dimensions the space does not have', () => {
    process.env.IMAGINATION_BINS = CUSTOM_BINS;
    const space = descriptorSpace();
    expect(space.source).toBe('env');
    expect(space.replaced).toBe(false);
    expect([...space.dimensions]).toEqual([...DEFAULT_DESCRIPTOR_DIMENSIONS, 'risk']);
    // `mechanism` is OVERRIDDEN (the default bins are replaced), `risk` is new.
    expect([...space.bins.mechanism]).toEqual(['a', 'b']);
    expect([...space.bins.risk]).toEqual(['low', 'high']);
    expect([...space.bins.representation]).toEqual([...DEFAULT_DESCRIPTOR_BINS.representation]);

    const normalized = normalizeBins({ mechanism: 'a', risk: 'high', bogus: 'x', representation: 'prose' });
    expect(normalized.bins.mechanism).toBe('a');
    expect(normalized.bins.risk).toBe('high');
    expect(normalized.bins.representation).toBe('prose');
    // The default bin vocabulary for `mechanism` is GONE (it was replaced).
    expect(normalizeBins({ mechanism: 'removal' }).bins.mechanism).toBe('unclassified');
    // A dimension outside the space is dropped and NAMED, never folded in.
    expect(normalized.unknown_dimensions).toEqual(['bogus']);
    expect(Object.keys(normalized.bins)).toEqual(['mechanism', 'representation', 'violated_assumption', 'evidence_family', 'test_strategy', 'risk']);
    expect(normalized.descriptor_bins).toHaveLength(6);
    expect(normalized.descriptor_bins[5]).toBe('high');
    expect(cellKeyFor(normalized.bins)).toBe(
      'mechanism=a|representation=prose|violated_assumption=unclassified|evidence_family=unclassified|test_strategy=unclassified|risk=high',
    );
  });

  it('archives into a custom cell, reports it in coverage, and re-validates the compiled baton', async () => {
    process.env.IMAGINATION_BINS = CUSTOM_BINS;
    const db = new FakeDb();
    await seedMission(db, { missionId: MISSION, ownerId: USER });
    const archive = new IdeaArchiveService(db.asDb());

    const custom = candidateSeed(0, {
      mission_id: MISSION,
      user_id: USER,
      bins: {
        mechanism: 'a',
        representation: 'prose',
        violated_assumption: 'necessity',
        evidence_family: 'epistemic_ledger',
        test_strategy: 'kill_criterion',
        risk: 'high',
      } as never,
    });
    const admitted = await archive.admitOrReplace(custom);
    expect(admitted.decision).toBe('admitted');
    const seed = admitted.seed!;
    expect(seed.cell_key).toContain('risk=high');
    expect(seed.descriptor_bins).toHaveLength(6);
    expect(validateAgainst(SCHEMA_IDS.ideaSeed, seed).valid).toBe(true);

    // A second seed in the SAME custom cell replaces the incumbent only if it
    // scores higher — the cell key really carries the custom dimension.
    const sameCell = candidateSeed(1, {
      mission_id: MISSION,
      user_id: USER,
      bins: {
        mechanism: 'a',
        representation: 'prose',
        violated_assumption: 'necessity',
        evidence_family: 'epistemic_ledger',
        test_strategy: 'kill_criterion',
        risk: 'high',
      } as never,
      novelty_score: 0.5,
    });
    const second = await archive.admitOrReplace(sameCell);
    expect(second.decision).toBe('below_incumbent');

    const coverage = await archive.coverage(MISSION, USER);
    expect(coverage.descriptor_dimensions).toEqual([...DEFAULT_DESCRIPTOR_DIMENSIONS, 'risk']);
    expect(coverage.cells_by_dimension.risk).toEqual({ high: 1 });
    expect(coverage.scan.cells_unknown_dimension).toBe(0);
    const riskGap = coverage.gaps.find((gap) => gap.dimension === 'risk');
    // `high` is occupied, `low` is a live gap of the configured space.
    expect(riskGap).toEqual({ dimension: 'risk', unoccupied_bins: ['low'] });

    // The compiler keeps the custom dimension's gap — the vocabulary moved with
    // the configuration instead of staying closed over the five defaults.
    expect(activeDescriptorBins().risk).toEqual(['low', 'high']);
    expect(validateCoverageGaps(coverage.gaps).dropped_unknown_dimension).toBe(0);

    const seeds = await archive.getSeeds(USER, MISSION);
    const baton = compileCreativeBaton({
      userId: USER,
      missionId: MISSION,
      cycleId: 'cycle_custom_bins',
      trace: {
        trace_id: 'trace_custom_bins',
        mission_version: 3,
        problem_state_digest: 'digest_custom_bins',
        signals: [
          { kind: 'tension', intensity: 0.8, confidence: 0.7, valence: -0.2 },
          { kind: 'absence', intensity: 0.6, confidence: 0.6, valence: 0 },
        ],
      },
      seeds,
      exclusions: [],
      coverage,
      trigger: { type: 'plateau', evidence: ['below_minimum_active_candidates'] },
    });
    expect(baton.coverage_gaps).toContainEqual({ dimension: 'risk', unoccupied_bins: ['low'] });
    expect(baton.counts.coverage_gaps_dropped_unknown_dimension).toBe(0);
    // …and the packet still re-validates: schema, secret scan and payload hash.
    const check = validateCreativeBaton(baton);
    expect(check.errors).toEqual([]);
    expect(check.valid).toBe(true);
  });

  it('the SAME gaps are refused when the space does not have the dimension (the closed default)', () => {
    // No IMAGINATION_BINS: `risk` is not a dimension of the active space, and
    // `b` is not one of the DEFAULT mechanism bins either.
    const report = validateCoverageGaps([
      { dimension: 'risk', unoccupied_bins: ['low', 'high'] },
      { dimension: 'mechanism', unoccupied_bins: ['b', 'removal'] },
    ]);
    expect(report.dropped_unknown_dimension).toBe(1);
    expect(report.dropped_unknown_bins).toBe(1);
    expect(report.gaps).toEqual([{ dimension: 'mechanism', unoccupied_bins: ['removal'] }]);

    // The configuration moves the vocabulary: now `risk` is a dimension and `b`
    // is a mechanism bin, while `not_a_bin` is refused.
    process.env.IMAGINATION_BINS = CUSTOM_BINS;
    const extended = validateCoverageGaps([
      { dimension: 'risk', unoccupied_bins: ['low', 'not_a_bin'] },
      { dimension: 'mechanism', unoccupied_bins: ['b'] },
    ]);
    expect(extended.dropped_unknown_dimension).toBe(0);
    expect(extended.gaps).toEqual([
      { dimension: 'mechanism', unoccupied_bins: ['b'] },
      { dimension: 'risk', unoccupied_bins: ['low'] },
    ]);
    expect(extended.dropped_unknown_bins).toBe(1);
  });

  it('a replaced space counts cells written under the old one instead of folding them in', async () => {
    const db = new FakeDb();
    await seedMission(db, { missionId: MISSION, ownerId: USER });
    const archive = new IdeaArchiveService(db.asDb());
    const before = await archive.admitOrReplace(candidateSeed(0, { mission_id: MISSION, user_id: USER }));
    expect(before.decision).toBe('admitted');

    // A hostile/operator misconfiguration that REPLACES the space.
    process.env.IMAGINATION_BINS = '{"replace":true,"dimensions":{"mechanism":["a"],"risk":["low"]}}';
    const replaced = descriptorSpace();
    expect(replaced.source).toBe('env');
    expect(replaced.replaced).toBe(true);
    expect([...replaced.dimensions]).toEqual(['mechanism', 'risk']);

    const coverage = await archive.coverage(MISSION, USER);
    expect(coverage.cells_total).toBe(1);
    // The five-dimension cell is NOT mapped onto the two-dimension space…
    expect(coverage.occupancy.occupied).toBe(0);
    expect(coverage.scan.cells_unknown_dimension).toBe(1);
    // …and the newly configured space's own possible-cell count is reported.
    expect(coverage.occupancy.possible).toBe(2 * 2);
    expect(coverage.gaps.map((gap) => gap.dimension)).toEqual(['mechanism', 'risk']);
  });
});
