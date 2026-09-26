/**
 * The comparators' model-written text (the DoD #8 control fix).
 *
 * The live A/B used to give its two comparator arms the fixture's scripted
 * template sentences while the treatment arms' text was a real model's, so the
 * judge's 0/12 vs 21/23 measured template prose against model prose at least as
 * much as pre-engine against engine. The live driver now asks the run's own model
 * for each comparator item — same items, ids, operators, bins, evidence refs and
 * structure, only ONE variable moved: who writes the two prose fields.
 *
 * This suite pins the pure half of that change, and in particular the property
 * the whole comparison rests on: a comparator candidate must be written for the
 * item its id and evidence cite, in the SAME order the template builders emit
 * them. `controlItems` is the single source of that order, shared by the prompt
 * and by the model-written builders; if either drifts from the template builders
 * the comparison silently starts comparing different things, so the first test
 * here diffs them element by element against the frozen builders themselves.
 *
 * It also guards the other direction — the comparators must not quietly become
 * the engine: the user prompt carries the graph material, and none of the
 * engine's own vocabulary (operators, archive, novelty, traces, bins).
 *
 * Pure, no store, no model: nothing here opens a connection or spends a token.
 */
import { describe, it, expect } from 'vitest';

import {
  CONTROL_BINS,
  CONTROL_DIRECTION_SYSTEM_PROMPT,
  WANDER_BINS,
  controlCandidatesA,
  controlCandidatesB,
  controlDirectionPrompt,
  controlItems,
  controlPromptSha256,
  modelControlCandidatesA,
  modelControlCandidatesB,
  parseControlDirections,
} from '../helpers/imagination-baseline-capture.js';

/** A small graph with one edge whose far end is missing, as a real read can be. */
const material = {
  concepts: [
    { id: 'n1', name: 'alpha', degree: 3 },
    { id: 'n2', name: 'beta', degree: 2 },
    { id: 'n3', name: 'gamma', degree: 1 },
  ],
  edges: [
    ['n1', 'n2'],
    ['n2', 'n3'],
    ['n3', 'missing'],
  ],
};

const directions = (count: number) =>
  Array.from({ length: count }, (_unused, index) => ({
    hypothesis: `hypothesis ${index + 1}`,
    mechanism: `mechanism ${index + 1}`,
  }));

describe('the comparators’ items match the frozen template builders', () => {
  it('arm A: one item per concept, same order, ids and evidence', () => {
    const items = controlItems(material, 'A');
    const template = controlCandidatesA(material);
    expect(items).toHaveLength(template.length);
    expect(items.map((item) => item.seed_id)).toEqual(template.map((candidate) => candidate.seed_id));
    expect(items.map((item) => item.evidence_refs)).toEqual(template.map((candidate) => candidate.evidence_refs));
    // The prompt must state the material the template builder's text referred to.
    expect(items.map((item) => item.line)).toEqual([
      expect.stringContaining('alpha'),
      expect.stringContaining('beta'),
      expect.stringContaining('gamma'),
    ]);
    expect(items[0].line).toContain('degree 3');
  });

  it('arm B: both directions of every edge, same order, ids, evidence and bridge — an edge with a missing end is skipped', () => {
    const items = controlItems(material, 'B');
    const template = controlCandidatesB(material);
    expect(items).toHaveLength(template.length);
    expect(items).toHaveLength(4); // two valid edges x both directions; the third edge is dropped by both
    expect(items.map((item) => item.seed_id)).toEqual(template.map((candidate) => candidate.seed_id));
    expect(items.map((item) => item.evidence_refs)).toEqual(template.map((candidate) => candidate.evidence_refs));
    expect(items.map((item) => item.bridge_path)).toEqual(template.map((candidate) => candidate.bridge_path));
    expect(items.map((item) => item.bridge)).toEqual(template.map((candidate) => candidate.bridge));
    // Direction-aware: the second item of the first edge is the reverse step.
    const names = (line: string) => line.replace('walk step ', '').split(' \u2192 ');
    expect(names(items[0].line)).toEqual(['alpha', 'beta']);
    expect(names(items[1].line)).toEqual(names(items[0].line).reverse());
  });

  it('numbers the items 1..N in order', () => {
    for (const arm of ['A', 'B'] as const) {
      expect(controlItems(material, arm).map((item) => item.index)).toEqual(
        controlItems(material, arm).map((_item, index) => index + 1),
      );
    }
  });
});

describe('the model-written builders change the prose and nothing else', () => {
  it('arm A: prose verbatim, structure from the template builder', () => {
    const items = controlItems(material, 'A');
    const built = modelControlCandidatesA(material, directions(items.length));
    const template = controlCandidatesA(material);
    expect(built.map((candidate) => candidate.seed_id)).toEqual(template.map((candidate) => candidate.seed_id));
    expect(built.map((candidate) => candidate.operator)).toEqual(template.map((candidate) => candidate.operator));
    expect(built.map((candidate) => candidate.evidence_refs)).toEqual(template.map((candidate) => candidate.evidence_refs));
    expect(built.map((candidate) => candidate.bins)).toEqual(template.map(() => CONTROL_BINS));
    expect(built.map((candidate) => candidate.hypothesis)).toEqual(directions(items.length).map((d) => d.hypothesis));
    expect(built.map((candidate) => candidate.mechanism)).toEqual(directions(items.length).map((d) => d.mechanism));
    // The template's own prose is NOT what the model-written candidates carry.
    expect(built[0].hypothesis).not.toBe(template[0].hypothesis);
  });

  it('arm B: prose verbatim, structure AND bridge fields from the template builder', () => {
    const items = controlItems(material, 'B');
    const built = modelControlCandidatesB(material, directions(items.length));
    const template = controlCandidatesB(material);
    expect(built.map((candidate) => candidate.seed_id)).toEqual(template.map((candidate) => candidate.seed_id));
    expect(built.map((candidate) => candidate.operator)).toEqual(template.map((candidate) => candidate.operator));
    expect(built.map((candidate) => candidate.evidence_refs)).toEqual(template.map((candidate) => candidate.evidence_refs));
    expect(built.map((candidate) => candidate.bridge_path)).toEqual(template.map((candidate) => candidate.bridge_path));
    expect(built.map((candidate) => candidate.bridge)).toEqual(template.map((candidate) => candidate.bridge));
    expect(built.map((candidate) => candidate.bins)).toEqual(template.map(() => WANDER_BINS));
    expect(built.map((candidate) => candidate.hypothesis)).toEqual(directions(items.length).map((d) => d.hypothesis));
  });

  it('refuses a mismatched direction count rather than building a partial arm', () => {
    expect(() => modelControlCandidatesA(material, directions(controlItems(material, 'A').length - 1))).toThrow(
      /must be refused by the caller/,
    );
    expect(() => modelControlCandidatesB(material, directions(controlItems(material, 'B').length + 1))).toThrow(
      /must be refused by the caller/,
    );
  });
});

describe('parseControlDirections: all or nothing, refused by name', () => {
  it('accepts a wrapper object and a bare array', () => {
    const wrapped = parseControlDirections({ candidates: directions(3) }, 3);
    expect(wrapped.refusal).toBeNull();
    expect(wrapped.directions).toHaveLength(3);
    const bare = parseControlDirections(directions(3), 3);
    expect(bare.refusal).toBeNull();
    expect(bare.directions[2]).toEqual({ hypothesis: 'hypothesis 3', mechanism: 'mechanism 3' });
  });

  it('trims the fields it accepts', () => {
    const parsed = parseControlDirections({ candidates: [{ hypothesis: '  h  ', mechanism: '\n m \n' }] }, 1);
    expect(parsed.refusal).toBeNull();
    expect(parsed.directions[0]).toEqual({ hypothesis: 'h', mechanism: 'm' });
  });

  it('refuses a short or padded array, naming both numbers, and returns NO directions', () => {
    const short = parseControlDirections({ candidates: directions(2) }, 3);
    expect(short.directions).toEqual([]);
    expect(short.refusal).toContain('carries 2 candidate(s)');
    expect(short.refusal).toContain('has 3 item(s)');
    const padded = parseControlDirections({ candidates: directions(4) }, 3);
    expect(padded.refusal).toContain('refused, not trimmed');
  });

  it('refuses a payload with no array, a non-object entry, and a blank field', () => {
    expect(parseControlDirections(null, 1).refusal).toContain('no array of candidates');
    expect(parseControlDirections('{"candidates":[]}', 1).refusal).toContain('no array of candidates');
    expect(parseControlDirections({ candidates: [['nope']] }, 1).refusal).toContain('entry 1 is not an object');
    expect(parseControlDirections({ candidates: [{ hypothesis: '   ', mechanism: 'm' }] }, 1).refusal).toContain(
      'entry 1 carries no hypothesis',
    );
    expect(parseControlDirections({ candidates: [{ hypothesis: 'h', mechanism: '' }] }, 1).refusal).toContain(
      'entry 1 carries no mechanism',
    );
  });
});

describe('the prompt is the pre-engine path, not the engine', () => {
  it('states every item exactly once and the exact count', () => {
    const prompt = controlDirectionPrompt(material, 'A');
    for (const item of controlItems(material, 'A')) {
      const occurrences = prompt.split(item.line).length - 1;
      expect(occurrences).toBe(1);
    }
    expect(prompt).toContain('Write exactly 3 candidate(s)');
    const promptB = controlDirectionPrompt(material, 'B');
    expect(promptB).toContain('Write exactly 4 candidate(s)');
  });

  it('carries the graph material and none of the engine’s own vocabulary', () => {
    for (const arm of ['A', 'B'] as const) {
      const prompt = controlDirectionPrompt(material, arm);
      // The engine's machinery must not reach the comparators: no operators, no
      // archive, no novelty scoring, no salience traces, no descriptor bins.
      for (const word of ['operator', 'archive', 'novelty', 'salience', 'trace', 'descriptor', 'bin', 'cycle']) {
        expect(prompt.toLowerCase()).not.toContain(word);
      }
      expect(prompt).toContain('plateaued');
    }
    // The system prompt is where the path is described, and it promises the shape.
    expect(CONTROL_DIRECTION_SYSTEM_PROMPT).toContain('Exactly one candidate per item');
    expect(CONTROL_DIRECTION_SYSTEM_PROMPT).toContain('JSON only');
  });

  it('hashes a prompt stably and sensitively', () => {
    const prompt = controlDirectionPrompt(material, 'A');
    const hash = controlPromptSha256(CONTROL_DIRECTION_SYSTEM_PROMPT, prompt);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(controlPromptSha256(CONTROL_DIRECTION_SYSTEM_PROMPT, prompt)).toBe(hash);
    expect(controlPromptSha256(CONTROL_DIRECTION_SYSTEM_PROMPT, `${prompt} `)).not.toBe(hash);
  });
});
