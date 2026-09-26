/**
 * The baseline experiment's CAPTURE + EVIDENCE helpers (ITER-11, WS-4).
 *
 * The fixture generator (`tests/unit/imagination-baseline-fixture.test.ts`) and
 * any future LIVE capture driver need the SAME evidence code: the checkpoint's
 * own material and control candidates, the per-arm outcome/plateau/taint
 * evidence, the control arm's admission through the shipped archive, and the
 * run bookkeeping around them. It lives here, once, so the live driver reuses
 * it instead of growing a second copy that could drift from the fixture the
 * harness measures against.
 *
 * THE STORE IS BOUND BY THE CALLER. `setCaptureDb(db)` names the FakeDb (or any
 * `Db`-shaped handle) these helpers read and write; the fixture generator calls
 * it with the same `FakeDb` its `beforeEach` installs, so the helpers and the
 * test observe one store. Nothing here reaches for a global connection.
 *
 * The evidence helpers report what the STORE says (`store_measured`) and label
 * what is declared (`stub_determined`); they never assert, so a caller can
 * capture and inspect the numbers itself.
 */
import { createHash } from 'node:crypto';

import type { FakeDb } from './fake-mongo.js';
import {
  FORBIDDEN_SHARED_KEYS,
  MIN_MARKER_LENGTH,
  computeImaginationMetrics,
} from '../../src/services/processing/imagination-metrics-service.js';
import { IdeaArchiveService } from '../../src/services/processing/idea-archive-service.js';

/** The instant the frozen checkpoint is fixed at (the plateau window's end). */
export const FIXED_AT = '2026-09-26T12:00:00.000Z';

/** The plateau window the frozen checkpoint belongs to. */
export const PLATEAU_WINDOW = { from: '2026-09-26T00:00:00.000Z', to: FIXED_AT };

/** The store the capture helpers read: the OWNER of the capture binds it. */
let db: FakeDb;

/** Bind the store the capture/evidence helpers read (the fixture generator's FakeDb, or a live driver's handle). */
export function setCaptureDb(next: FakeDb): void {
  db = next;
}

/** The mission's graph, as the control comparator walks it (degree-ranked). */
export function baselineMaterial(): Record<string, unknown> {
  // The store holds TWO missions' graphs by the time this runs (the cycle
  // mission and the team mission), so both lists are de-duplicated by identity:
  // the material is one graph, not two copies of it.
  const nodesById = new Map<string, Record<string, any>>();
  for (const node of db.collection('knowledge_nodes').docs as Array<Record<string, any>>) {
    const id = String(node.id);
    if (!nodesById.has(id)) nodesById.set(id, node);
  }
  const edgeKeys = new Set<string>();
  const edges: Array<Record<string, any>> = [];
  for (const edge of db.collection('knowledge_relationships').docs as Array<Record<string, any>>) {
    const key = `${String(edge.from_id)}->${String(edge.to_id)}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push(edge);
  }
  const nodes = [...nodesById.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const degree = new Map<string, number>();
  for (const edge of edges) {
    const from = String(edge.from_id);
    const to = String(edge.to_id);
    degree.set(from, (degree.get(from) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
  }
  const maxDegree = Math.max(1, ...degree.values());
  return {
    concepts: nodes
      .map((node) => ({
        id: String(node.id),
        name: String(node.properties?.name ?? node.id),
        degree: degree.get(String(node.id)) ?? 0,
        prominence: Number(((degree.get(String(node.id)) ?? 0) / maxDegree).toFixed(6)),
      }))
      .sort((left, right) => right.prominence - left.prominence || left.id.localeCompare(right.id)),
    edges: edges
      .map((edge) => [String(edge.from_id), String(edge.to_id)])
      .sort((left, right) => `${left[0]}->${left[1]}`.localeCompare(`${right[0]}->${right[1]}`)),
    basis:
      'knowledge_nodes + knowledge_relationships of the frozen scenario mission; prominence is the node degree ' +
      'divided by the maximum degree (a deterministic, text-free measure the harness re-derives itself)',
  };
}

export function seedRows(cycleId: string): Array<Record<string, any>> {
  return (db.collection('idea_seeds').docs as Array<Record<string, any>>)
    .filter((row) => row.cycle_id === cycleId)
    .map((row) => ({
      seed_id: String(row.seed_id),
      agent: String(row.user_id),
      operator: String(row.operator),
      hypothesis: String(row.hypothesis),
      // `mechanism` is the candidate's own second field (the baton's
      // candidate_portfolio carries it), so the taint attribution can tell the
      // packet's own material from text lifted out of the private stores.
      mechanism: String(row.mechanism ?? ''),
      descriptor_bins: { ...(row.bins ?? {}) },
      cell_key: String(row.cell_key),
      novelty_score: Number(row.novelty_score),
      coherence_score: Number(row.coherence_score),
      testability_score: Number(row.testability_score),
      expected_information_gain: Number(row.expected_information_gain),
      cheapest_test: String(row.cheapest_test),
      quality: Number(row.quality),
      state: String(row.state),
      rejection_reason: row.rejection?.reason ? String(row.rejection.reason) : null,
      created_at: String(row.created_at),
      privacy_safe: true,
    }))
    .sort((left, right) => left.seed_id.localeCompare(right.seed_id));
}

export function outcomesFor(seedIds: readonly string[]): Record<string, unknown> {
  const rows = (db.collection('idea_candidate_outcomes').docs as Array<Record<string, any>>).filter((row) =>
    seedIds.includes(String(row.seed_id)),
  );
  const byOutcome: Record<string, number> = {};
  for (const row of rows) byOutcome[String(row.outcome)] = (byOutcome[String(row.outcome)] ?? 0) + 1;
  return {
    recorded: rows.length,
    useful_information: byOutcome.useful_information ?? 0,
    mere_variance: byOutcome.mere_variance ?? 0,
    unnecessary_cost: byOutcome.unnecessary_cost ?? 0,
    decisions: rows
      .map((row) => ({ seed_id: String(row.seed_id), outcome: String(row.outcome) }))
      .sort((left, right) => left.seed_id.localeCompare(right.seed_id)),
  };
}

/**
 * c1's evidence: how many runs the engine recorded for this plateau window.
 * Counted from the collection the arm's own path writes (`imagination_cycles`
 * for a focused cycle, `cognitive_portfolios` (kind=first_pass) for a team
 * pass), inside the window, for this identity and mission — a store read, not a
 * claim.
 */
export function plateauEvidence(args: {
  collection: string;
  idField: string;
  userId: string;
  missionId: string;
  kind?: string;
  measured_from: string;
  /**
   * The window to count runs inside. The FROZEN checkpoint's window by default
   * (the fixture generator passes nothing, so every byte it captures is what it
   * was); a LIVE driver passes its OWN window — the run it is measuring starts
   * after the frozen checkpoint, and counting runs inside a window the run never
   * touched would report a vacuous zero.
   */
  window?: { from: string; to: string };
}): Record<string, unknown> {
  const window = args.window ?? PLATEAU_WINDOW;
  const rows = (db.collection(args.collection).docs as Array<Record<string, any>>).filter((row) => {
    if (row.user_id !== args.userId || row.mission_id !== args.missionId) return false;
    if (args.kind !== undefined && row.kind !== args.kind) return false;
    const at = Date.parse(String(row.created_at ?? ''));
    return Number.isFinite(at) && at >= Date.parse(window.from) && at <= Date.parse(window.to);
  });
  return {
    window_id: `${args.missionId}@${window.from}..${window.to}`,
    window: { ...window },
    cycles_in_window: rows.length,
    run_ids: rows.map((row) => String(row[args.idField])).sort(),
    measured_from: args.measured_from,
    determination: 'store_measured',
  };
}

/**
 * c2's evidence: the taint scan the metrics view itself runs, ATTRIBUTED.
 *
 * `privacy_leakage` reads back every SHARED-scope artefact this identity
 * produced and flags an artefact when it carries a forbidden private key OR
 * when one of its strings reproduces a marker lifted verbatim from the
 * identity's private stores. The audit returns the COUNT of flags — and in this
 * fixture the count is not zero, for a reason worth stating precisely: the
 * promoted baton carries `candidate_portfolio[i].hypothesis`, which is the
 * packet's own allow-listed candidate material (the compiler copies the
 * candidate's text deliberately), and the scripted scenario emitted the SAME
 * sentence for a candidate the archive rejected as a duplicate. The marker
 * rule cannot tell "the packet's own field, the text the candidate produced"
 * from "private material lifted into the packet", so it flags the
 * reproduction.
 *
 * This helper therefore reports BOTH numbers, so neither is hidden:
 *
 *   flagged              — the audit's own count, verbatim (1 here);
 *   private_text_crossed — the flags that are NOT a verbatim reproduction of
 *                          the candidate's own allow-listed field text (0
 *                          here). A flag on a forbidden private key, or on a
 *                          marker reproduced anywhere else, counts.
 *
 * The cross-check is not a hand-wave: an `allowed_field_reproduction` flag must
 * point at one of the baton's candidate fields AND the text it reproduced must
 * be the text THIS ARM's own admitted candidates produced (`candidate_portfolio[
 * i].hypothesis` must equal an admitted seed's hypothesis, and so on). The
 * c2 predicate in the harness reads exactly the two numbers above, and the
 * task-quality tests attack it with a baton that reproduces a TRACE STATEMENT,
 * which must mark the criterion unmet.
 */
export async function taintEvidence(args: {
  userId: string;
  missionId: string;
  rows: ReadonlyArray<Record<string, any>>;
  /**
   * The instant the metrics window ends. The FROZEN checkpoint's instant by
   * default (byte-identical for the fixture generator); a LIVE driver passes its
   * own run's stamp — the metrics view's window is `[now − days, now]`, so a
   * frozen `now` would exclude every artefact the live run produced and report a
   * vacuous clean scan.
   */
  now?: () => string;
}): Promise<Record<string, unknown>> {
  const metrics = await computeImaginationMetrics(db.asDb(), {
    userId: args.userId,
    missionId: args.missionId,
    now: args.now ?? (() => FIXED_AT),
  });
  const audit = metrics.privacy_leakage;
  const scope = { user_id: args.userId, mission_id: args.missionId };

  // The marker lift and the artefact set mirror `auditSharedArtefacts`, so the
  // attribution is over the same inputs the audit used.
  const markers = new Set<string>();
  for (const row of db.collection('idea_seeds').docs as Array<Record<string, any>>) {
    if (row.user_id !== scope.user_id || row.mission_id !== scope.mission_id || row.state !== 'rejected') continue;
    for (const text of [row.hypothesis, row.mechanism]) {
      if (typeof text === 'string' && text.length >= MIN_MARKER_LENGTH) markers.add(text);
    }
  }
  for (const row of db.collection('idea_lineages').docs as Array<Record<string, any>>) {
    if (row.user_id !== scope.user_id || row.mission_id !== scope.mission_id) continue;
    if (typeof row.changed_premise === 'string' && row.changed_premise.length >= MIN_MARKER_LENGTH) markers.add(row.changed_premise);
  }
  for (const row of db.collection('salience_traces').docs as Array<Record<string, any>>) {
    if (row.user_id !== scope.user_id || row.mission_id !== scope.mission_id) continue;
    for (const signal of row.signals ?? []) {
      for (const text of [signal?.statement, signal?.why_operationally_relevant]) {
        if (typeof text === 'string' && text.length >= MIN_MARKER_LENGTH) markers.add(text);
      }
    }
  }

  const artefacts: Array<{ collection: string; row: Record<string, any> }> = [
    ...(db.collection('creative_batons').docs as Array<Record<string, any>>)
      .filter((row) => row.user_id === scope.user_id && row.mission_id === scope.mission_id && row.shared_id != null)
      .map((row) => ({ collection: 'creative_batons', row })),
    ...(db.collection('creative_baton_promotions').docs as Array<Record<string, any>>)
      .filter((row) => row.user_id === scope.user_id && row.mission_id === scope.mission_id)
      .map((row) => ({ collection: 'creative_baton_promotions', row })),
  ];

  /** Every string in a value, with its JSON path. */
  const stringsOf = (value: unknown, path = '', out: Array<{ path: string; text: string }> = []): Array<{ path: string; text: string }> => {
    if (typeof value === 'string') out.push({ path, text: value });
    else if (Array.isArray(value)) value.forEach((item, index) => stringsOf(item, `${path}[${index}]`, out));
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) stringsOf(child, path ? `${path}.${key}` : key, out);
    }
    return out;
  };
  const keysOf = (value: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) for (const item of value) keysOf(item, out);
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        out.add(key);
        keysOf(child, out);
      }
    }
    return out;
  };

  /** The arm's OWN candidate text per allow-listed field (admitted rows only). */
  const ownCandidateText: Record<string, Set<string>> = {
    hypothesis: new Set(),
    mechanism: new Set(),
    cheapest_test: new Set(),
  };
  for (const row of args.rows) {
    if (row.state !== 'admitted') continue;
    for (const [field, set] of Object.entries(ownCandidateText)) {
      if (typeof row[field] === 'string') set.add(row[field]);
    }
  }
  const CANDIDATE_FIELD = /^candidate_portfolio\[\d+\]\.(hypothesis|mechanism|cheapest_test)$/;

  const flags: Array<Record<string, unknown>> = [];
  for (const artefact of artefacts) {
    const forbidden = FORBIDDEN_SHARED_KEYS.filter((key) => keysOf(artefact.row).has(key));
    if (forbidden.length > 0) {
      flags.push({
        artefact: artefact.collection,
        id: String(artefact.row.baton_id ?? artefact.row.promotion_id ?? 'unknown'),
        field: null,
        reason: 'forbidden_private_key',
        forbidden_keys: [...forbidden],
        allowed_field_reproduction: false,
      });
      continue;
    }
    for (const { path, text } of stringsOf(artefact.row)) {
      for (const marker of markers) {
        if (!text.includes(marker)) continue;
        const match = CANDIDATE_FIELD.exec(path);
        const ownText = match ? ownCandidateText[match[1]].has(text) : false;
        flags.push({
          artefact: artefact.collection,
          id: String(artefact.row.baton_id ?? artefact.row.promotion_id ?? 'unknown'),
          field: path,
          reason: 'marker_reproduced',
          marker_sha256: createHash('sha256').update(marker).digest('hex').slice(0, 32),
          marker_length: marker.length,
          allowed_field_reproduction: match !== null && ownText,
        });
      }
    }
  }
  const crossed = flags.filter((flag) => flag.allowed_field_reproduction !== true).length;

  return {
    shared_artefacts_scanned: audit.shared_artefacts_scanned,
    flagged: audit.flagged,
    private_text_crossed: crossed,
    markers_checked: audit.markers_checked,
    keys_checked: audit.keys_checked,
    flags,
    attributed_by:
      'this fixture test, over the same artefacts and markers the audit uses: a flag is an allowed-field reproduction only when the reproducing field is one of the ' +
      'baton’s candidate fields (candidate_portfolio[i].hypothesis|mechanism|cheapest_test) AND the text is the text this arm’s own admitted candidates produced',
    measured_from:
      `computeImaginationMetrics({ user_id: '${args.userId}', mission_id: '${args.missionId}' }).privacy_leakage — the same audit the ` +
      'metrics view runs over the shared-scope artefacts',
    determination: 'store_measured',
  };
}

// ── The two CONTROL arms, through the REAL archive (ITER-11 refinement) ──────
//
// The reviewer's finding: the controls' rejections were produced by the
// HARNESS'S OWN re-implementation of the archive's dedupe rule while the
// treatment arms ran the shipped archive, so the recorded false-novelty
// comparison was not like-for-like. The harness is dependency-free plain Node
// and cannot import the services (`idea-archive-service.ts` uses TypeScript
// parameter properties, which Node's strip-only type stripping refuses), so the
// fix is here, in the fixture GENERATOR — the one place that already runs the
// real services and captures the treatment rows:
//
//   * the two comparators' candidate text is still the pre-engine path's (one
//     idea per concept ranked by degree; both directions of every walk step),
//     but every candidate is now ADMITTED through
//     `IdeaArchiveService.admitOrReplace` — the SHIPPED rule, in-process, over a
//     throwaway identity and mission so it cannot touch, exclude or contaminate
//     the treatment arms;
//   * the fixture records the archive's own DECISIONS (state, rejection reason,
//     `duplicate_of`, cell key, quality) exactly as it records the treatment
//     arms' rows, so the same rule decides both sides of the comparison;
//   * the harness no longer re-implements the rule at all: it reads these rows.
//
// The freshness gate below re-runs this capture on every test run and compares
// it with the committed fixture, so a change to the archive's rule (or to its
// constants) cannot silently leave the recorded control decisions stale.
//
// The comparator's candidates must satisfy the SHIPPED seed schema to be
// storable (the archive rejects a schema-invalid seed as `schema_invalid` and
// stores nothing). Three fields are schema-necessary here and are declared as
// such rather than dressed up as a claim about the pre-engine path:
//
//   `operator`      must be one of the ten catalogue families. The pre-engine
//                   path had NO operator plan, so each comparator carries the
//                   family that describes what it does — `representation_shift`
//                   for retrieval (it re-presents the mission's graph) and
//                   `distant_analogy` for the wander (it links two concepts);
//   `evidence_refs` must hold at least one ref; the comparators' own evidence is
//                   the graph node/edge they retrieved from;
//   `lineage_ref`   must be present; it is derived from the seed id (sha256),
//                   never random, so the fixture stays reproducible.
export const CONTROL_IDENTITY = 'agent-control';
export const CONTROL_MISSION_A = 'mission_baseline_control_retrieval';
export const CONTROL_MISSION_B = 'mission_baseline_control_wander';
export const CONTROL_CYCLE_ID = 'cycle_pre_engine_comparator';

/** The descriptor tuple each comparator assigns (one cell each, by design). */
export const CONTROL_BINS = {
  mechanism: 'relocation',
  representation: 'prose',
  violated_assumption: 'stability',
  evidence_family: 'operational_state',
  test_strategy: 'observation_study',
};
export const WANDER_BINS = {
  mechanism: 'composition',
  representation: 'graph',
  violated_assumption: 'independence',
  evidence_family: 'external_observation',
  test_strategy: 'simulation',
};
export const CONTROL_TEST = 'Ask whether the concept still explains the plateau.';

export interface ControlCandidate {
  seed_id: string;
  operator: string;
  hypothesis: string;
  mechanism: string;
  bins: Record<string, string>;
  evidence_refs: string[];
  bridge_path?: string[];
  bridge?: string;
}

/** Arm A — dreamer-style retrieval: one idea per concept, ranked by degree. */
export function controlCandidatesA(material: Record<string, any>): ControlCandidate[] {
  return (material.concepts as Array<Record<string, any>>).map((concept, index) => ({
    seed_id: `control_a_${String(index + 1).padStart(2, '0')}`,
    operator: 'representation_shift',
    hypothesis: `Investigate ${concept.name} further: it is central to the mission's graph and may be the plateau.`,
    mechanism:
      `A concept with degree ${concept.degree} sits at the centre of the mission's own graph, so it is the ` +
      'most retrievable explanation the pre-engine path offers.',
    bins: CONTROL_BINS,
    evidence_refs: [String(concept.id)],
  }));
}

/** Arm B — mind-wander: both directions of every walk step, undeduped. */
export function controlCandidatesB(material: Record<string, any>): ControlCandidate[] {
  const byId = new Map((material.concepts as Array<Record<string, any>>).map((concept) => [String(concept.id), concept]));
  const out: ControlCandidate[] = [];
  for (const [from, to] of material.edges as Array<[string, string]>) {
    const a = byId.get(String(from));
    const b = byId.get(String(to));
    if (!a || !b) continue;
    for (const [first, second, mechanism] of [
      [a, b, `The wander walked the edge ${a.name} → ${b.name}; the connection itself is the hypothesis.`],
      [b, a, 'The same edge read backwards: an undeduped wander emits both directions.'],
    ] as Array<[Record<string, any>, Record<string, any>, string]>) {
      out.push({
        seed_id: `control_b_${String(out.length + 1).padStart(2, '0')}`,
        operator: 'distant_analogy',
        hypothesis: `Explore the connection between ${first.name} and ${second.name}.`,
        mechanism,
        bins: WANDER_BINS,
        evidence_refs: [String(from), String(to)],
        bridge_path: [String(from), String(to)],
        bridge: 'Both ends are the mission\u2019s own concepts and the walk stepped between them.',
      });
    }
  }
  return out;
}

// ── the comparators, answering the REAL MODEL (the control fix) ─────────────
//
// The two builders above are what the FIXTURE generator calls, and their output
// is frozen: nothing here changes them. A live driver calls the builders below
// instead — the SAME items (same ids, operators, bins, evidence refs and
// structure) with the two prose fields written by the real model. That is what
// closes the confound a template comparator opens: with template text on one
// side and model text on the other, a blind judge measures template prose
// against model prose at least as much as it measures pre-engine against engine.
//
// The prompt hands the model the graph material the pre-engine path reads and
// NOTHING else — no salience traces, no operator families, no archive, no
// novelty instruction, no plateau history — and asks for exactly what the
// template builder used to state: one candidate per item, in the item's terms.
// Items come from `controlItems`, which the prompt and the builders share, so a
// hypothesis is always written for the item its candidate cites. The prompts are
// pure functions of the recorded `baseline_material`, whose sha256 the runner
// records, so the reading can be re-scored or re-run from the record.

/** The comparators' system prompt; the capture records its sha256 and every user prompt's. */
export const CONTROL_DIRECTION_SYSTEM_PROMPT = `You write one candidate research direction per item you are given.

You are the pre-engine path of a research mission that has plateaued: the mission keeps producing work that does not advance it. You are shown items read out of the mission's own knowledge graph — nothing else. You have no operator list, no archive, no record of earlier candidates and no novelty check: you write what each item suggests to you, and that is the whole method.

Rules:
- Exactly one candidate per item, in the order given: none skipped, none merged, none added.
- Write each candidate in the item's own terms; name the concept or the step you were given.
- A candidate is a hypothesis (the direction) and a mechanism (why that direction follows from the item).
- Reply with JSON only, in the shape the instruction asks for.`;

export type ControlArm = 'A' | 'B';

export interface ControlItem {
  /** 1-based position, as the prompt numbers it. */
  index: number;
  /** The item as the prompt states it. */
  line: string;
  /** The id the candidate built from this item carries (the template builder's own id). */
  seed_id: string;
  /** The graph node/edge ids the candidate cites, exactly as the template builder cites them. */
  evidence_refs: string[];
  /** Arm B only: the walk step's stored edge, for the candidate's bridge fields. */
  bridge_path?: string[];
  bridge?: string;
}

/**
 * The comparator's items, in the exact order the template builders emit them —
 * arm A: one per concept; arm B: both directions of every edge, undeduped, with
 * an edge whose endpoint is missing from the graph skipped exactly as the
 * template builder skips it. `imagination-control-directions.test.ts` pins this
 * correspondence against the template builders themselves.
 */
export function controlItems(material: Record<string, any>, arm: ControlArm): ControlItem[] {
  if (arm === 'A') {
    return (material.concepts as Array<Record<string, any>>).map((concept, index) => ({
      index: index + 1,
      line: `concept "${String(concept.name)}" \u2014 degree ${String(concept.degree)} in the mission's graph`,
      seed_id: `control_a_${String(index + 1).padStart(2, '0')}`,
      evidence_refs: [String(concept.id)],
    }));
  }
  const byId = new Map(
    (material.concepts as Array<Record<string, any>>).map((concept) => [String(concept.id), concept]),
  );
  const items: ControlItem[] = [];
  for (const [from, to] of material.edges as Array<[string, string]>) {
    const a = byId.get(String(from));
    const b = byId.get(String(to));
    if (!a || !b) continue;
    for (const [first, second] of [
      [a, b],
      [b, a],
    ] as Array<[Record<string, any>, Record<string, any>]>) {
      items.push({
        index: items.length + 1,
        line: `walk step ${String(first.name)} \u2192 ${String(second.name)}`,
        seed_id: `control_b_${String(items.length + 1).padStart(2, '0')}`,
        evidence_refs: [String(from), String(to)],
        bridge_path: [String(from), String(to)],
        bridge: 'Both ends are the mission\u2019s own concepts and the walk stepped between them.',
      });
    }
  }
  return items;
}

/** The arm's user prompt: the plateau frame, the items, and the exact reply shape. */
export function controlDirectionPrompt(material: Record<string, any>, arm: ControlArm): string {
  const items = controlItems(material, arm);
  const list = items.map((item) => `${item.index}. ${item.line}`).join('\n');
  const frame =
    arm === 'A'
      ? 'Items \u2014 concepts read out of the mission\u2019s knowledge graph, ranked by how central they are:'
      : 'Items \u2014 the steps of a mind-wander over the mission\u2019s knowledge graph, in walk order (the walk is not de-duplicated: a step and its reverse can both appear):';
  return [
    'The mission has plateaued: it keeps producing work that does not advance it.',
    '',
    frame,
    list,
    '',
    `Write exactly ${items.length} candidate(s): one per item, in this order. For each, give`,
    '- "hypothesis": the direction this item suggests for the mission, in one or two sentences;',
    '- "mechanism": why that direction follows from THIS item \u2014 say what the item is and what it connects.',
    '',
    `JSON only: {"candidates":[{"hypothesis":"\u2026","mechanism":"\u2026"}]} with exactly ${items.length} entries.`,
  ].join('\n');
}

/** The hash of a prompt actually sent, for the capture's record. */
export function controlPromptSha256(system: string, user: string): string {
  return createHash('sha256').update(`${system}\n\n${user}`).digest('hex');
}

export interface ControlDirection {
  hypothesis: string;
  mechanism: string;
}

/**
 * Parse a comparator reply. ALL-OR-NOTHING per arm: a reply that comes back short
 * (or long) is refused BY NAME rather than padded, trimmed or partially accepted,
 * because the arm's denominator is "one candidate per item" and a partial arm
 * would silently change what the rate is a rate of. Both reply shapes the judge's
 * parser accepts are accepted here: a wrapper object or a bare array.
 */
export function parseControlDirections(
  raw: unknown,
  expected: number,
): { directions: ControlDirection[]; refusal: string | null } {
  const fail = (reason: string) => ({ directions: [] as ControlDirection[], refusal: reason });
  let list: unknown = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const wrapper = raw as Record<string, unknown>;
    list = wrapper.candidates ?? wrapper.directions ?? wrapper.items ?? null;
  }
  if (!Array.isArray(list)) {
    return fail(
      `the reply carries no array of candidates (${raw === null ? 'got null' : Array.isArray(raw) ? 'the payload itself is a bare array of the wrong shape' : `got ${typeof raw}`})`,
    );
  }
  if (list.length !== expected) {
    return fail(
      `the reply carries ${list.length} candidate(s), the arm has ${expected} item(s) \u2014 a short or padded array is refused, not trimmed`,
    );
  }
  const directions: ControlDirection[] = [];
  for (const [index, entry] of list.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail(`entry ${index + 1} is not an object`);
    }
    const row = entry as Record<string, unknown>;
    const hypothesis = typeof row.hypothesis === 'string' ? row.hypothesis.trim() : '';
    const mechanism = typeof row.mechanism === 'string' ? row.mechanism.trim() : '';
    if (!hypothesis) return fail(`entry ${index + 1} carries no hypothesis`);
    if (!mechanism) return fail(`entry ${index + 1} carries no mechanism`);
    directions.push({ hypothesis, mechanism });
  }
  return { directions, refusal: null };
}

/** Arm A with the model's prose: same ids, operator, bins and evidence as the template builder. */
export function modelControlCandidatesA(
  material: Record<string, any>,
  directions: ControlDirection[],
): ControlCandidate[] {
  const items = controlItems(material, 'A');
  if (directions.length !== items.length) {
    throw new Error(
      `arm A: ${directions.length} direction(s) for ${items.length} item(s) \u2014 a mismatched reply must be refused by the caller, not built from`,
    );
  }
  return items.map((item, index) => ({
    seed_id: item.seed_id,
    operator: 'representation_shift',
    hypothesis: directions[index].hypothesis,
    mechanism: directions[index].mechanism,
    bins: CONTROL_BINS,
    evidence_refs: item.evidence_refs,
  }));
}

/** Arm B with the model's prose: same ids, operator, bins, evidence and bridge fields as the template builder. */
export function modelControlCandidatesB(
  material: Record<string, any>,
  directions: ControlDirection[],
): ControlCandidate[] {
  const items = controlItems(material, 'B');
  if (directions.length !== items.length) {
    throw new Error(
      `arm B: ${directions.length} direction(s) for ${items.length} item(s) \u2014 a mismatched reply must be refused by the caller, not built from`,
    );
  }
  return items.map((item, index) => ({
    seed_id: item.seed_id,
    operator: 'distant_analogy',
    hypothesis: directions[index].hypothesis,
    mechanism: directions[index].mechanism,
    bins: WANDER_BINS,
    evidence_refs: item.evidence_refs,
    bridge_path: item.bridge_path,
    bridge: item.bridge,
  }));
}

/**
 * The comparators' task-quality evidence — DECLARED, and labelled as such. The
 * pre-engine path has no cycle service and no archive in production, so it ran
 * zero cycles for this plateau and produced nothing shared to scan. Both facts
 * are declarations by the file that implements the comparator (there is no
 * store row to read) and each evaluation says so in its basis.
 */
export function controlTaskQualityEvidence(
  declaredBy = 'server/tests/unit/imagination-baseline-fixture.test.ts',
): Record<string, unknown> {
  return {
    plateau: {
      window_id: 'frozen_checkpoint_alpha',
      cycles_in_window: 0,
      run_ids: [],
      measured_from:
        'this fixture generator (the comparator is not a service): the pre-engine path has no cycle service — retrieval and mind-wander emit candidates directly — so ZERO cycle/pass runs exist for this window',
      declared_by: declaredBy,
      determination: 'stub_determined',
    },
    taint: {
      shared_artefacts_scanned: 0,
      flagged: 0,
      markers_checked: 0,
      measured_from:
        'this fixture generator: the pre-engine path produces no shared artefact at all (no baton, no promotion), so there is nothing to scan — a VACUOUS clean result, labelled as such',
      declared_by: declaredBy,
      determination: 'stub_determined',
    },
  };
}

/**
 * Capture one comparator arm by admitting EVERY candidate, in order, through the
 * shipped archive over a throwaway identity + mission, and recording the
 * archive's own decision for each.
 *
 * The three OPTIONAL arguments are for a LIVE driver and change nothing for the
 * fixture generator (which passes none, so every captured byte is what it was):
 *
 *   `outcomes`  the arm's outcome block. A comparator records no verdicts, so
 *               the default is the EMPTY block; a live driver that put the arm's
 *               seeds through the outcome channel passes the real block.
 *   `triggerAt` the arm's trigger stamp. A comparator has no cycle to trigger,
 *               so the default is `null`; a live driver passes the real instant.
 *   `identity`  the identity the comparison is admitted under. The fixture's
 *               throwaway `CONTROL_IDENTITY` by default; a live driver passes a
 *               run-namespaced identity so its rows cannot collide with real
 *               data (the archive keys seeds by `{seed_id, user_id}`).
 */
export async function captureControlArm(args: {
  label: string;
  name: string;
  path: string;
  retrieval: string;
  missionId: string;
  candidates: ControlCandidate[];
  /** The arm's outcome block; default: the empty block (a comparator records no verdicts). */
  outcomes?: Record<string, unknown>;
  /** The arm's trigger stamp; default: null (a comparator has no cycle to trigger). */
  triggerAt?: string | null;
  /** The identity the candidates are admitted under; default: `CONTROL_IDENTITY`. */
  identity?: string;
  /** Who ran this capture; default: the fixture generator (the live driver names itself). */
  decidedBy?: string;
  /** Who DECLARED the comparator's task-quality blocks; default: the fixture generator. */
  declaredBy?: string;
  /**
   * How the comparator's TEXT was produced. Default: the fixture's scripted
   * templates, which is what the frozen fixture records. A live driver whose
   * comparators answered the real model passes `{ is_scripted: false, ... }` so
   * the arm's own blocks say so instead of claiming scripted text.
   */
  text?: { is_scripted: boolean; basis: string; determination: string; note: string };
  /** Tokens the comparator's own generation spent; default 0 (the fixture's templates cost nothing). */
  tokens?: number;
}): Promise<Record<string, unknown>> {
  const identity = args.identity ?? CONTROL_IDENTITY;
  const decidedBy = args.decidedBy ?? 'server/tests/unit/imagination-baseline-fixture.test.ts (the fixture generator)';
  const archive = new IdeaArchiveService(db.asDb());
  const rows: Array<Record<string, any>> = [];
  const rejections: Array<{ seed_id: string; reason: string }> = [];
  for (const candidate of args.candidates) {
    const result = await archive.admitOrReplace({
      seed_id: candidate.seed_id,
      user_id: identity,
      mission_id: args.missionId,
      mission_version: 1,
      cycle_id: CONTROL_CYCLE_ID,
      prng_seed: 0,
      operator: candidate.operator,
      hypothesis: candidate.hypothesis,
      mechanism: candidate.mechanism,
      descriptor_bins: candidate.bins as unknown as string[],
      evidence_refs: candidate.evidence_refs,
      novelty_score: 0.5,
      coherence_score: 0.5,
      testability_score: 0.4,
      expected_information_gain: 0.2,
      cheapest_test: CONTROL_TEST,
      parent_seed_ids: [],
      lineage_ref: `lineage_${createHash('sha256').update(candidate.seed_id).digest('hex').slice(0, 32)}`,
      ...(candidate.bridge_path ? { bridge_path: candidate.bridge_path, bridge: candidate.bridge } : {}),
    } as never);
    if (!result.seed) {
      throw new Error(
        `comparator candidate ${candidate.seed_id} was not storable: ${result.rejection?.reason} — ${result.rejection?.detail}`,
      );
    }
    if (result.decision === 'unchanged') {
      throw new Error(`comparator candidate ${candidate.seed_id} was already stored — the ids must be unique`);
    }
    const stored = result.seed;
    rows.push({
      seed_id: String(stored.seed_id),
      agent: 'control',
      operator: String(stored.operator),
      hypothesis: String(stored.hypothesis),
      mechanism: String(stored.mechanism),
      descriptor_bins: { ...(stored.bins ?? {}) },
      cell_key: String(stored.cell_key),
      novelty_score: Number(stored.novelty_score),
      coherence_score: Number(stored.coherence_score),
      testability_score: Number(stored.testability_score),
      expected_information_gain: Number(stored.expected_information_gain),
      cheapest_test: String(stored.cheapest_test),
      quality: Number(stored.quality),
      state: String(stored.state),
      rejection_reason: stored.rejection?.reason ? String(stored.rejection.reason) : null,
      created_at: String(stored.created_at),
      privacy_safe: true,
    });
    if (result.decision === 'rejected') {
      rejections.push({ seed_id: String(stored.seed_id), reason: String(result.rejection!.reason) });
    }
  }
  const admitted = rows.filter((row) => row.state === 'admitted').length;

  return {
    label: args.label,
    name: args.name,
    kind: 'control',
    config: {
      path: args.path,
      retrieval: args.retrieval,
      operators: 'none (the pre-engine path had no operator plan)',
      archive: 'none in production: the comparator emits its candidates directly',
      admission:
        'every candidate was admitted through the SHIPPED archive in the fixture generator, so the rejection rule is the same one the treatment arms ran',
    },
    admission_rule: {
      path: 'shipped_archive',
      service: 'IdeaArchiveService.admitOrReplace',
      decided_by: decidedBy,
      identity,
      mission_id: args.missionId,
      same_rule_as: ['A', 'B', 'C', 'D'],
      text_is_scripted: args.text?.is_scripted ?? true,
      text_basis: args.text?.basis ?? `the comparator's own templates (${args.name}) — the pre-engine path's text`,
      schema_necessary_fields:
        'operator (a catalogue family, because the shipped seed schema requires one and the pre-engine path had no operator plan), ' +
        'evidence_refs (the graph node/edge the comparator retrieved) and lineage_ref (derived from the seed id)',
    },
    generation: {
      path: args.decidedBy === undefined ? 'fixture_capture' : 'live_capture',
      captured_from:
        args.decidedBy === undefined
          ? 'the real IdeaArchiveService.admitOrReplace over the comparator’s candidates, in the fixture generator'
          : `the real IdeaArchiveService.admitOrReplace over the comparator’s candidates, run by ${decidedBy}`,
      determination: args.text?.determination ?? 'stub_determined',
      note:
        args.text?.note ??
        'idea TEXT is the pre-engine comparator’s scripted template, so every text-derived magnitude is stub-determined; the DECISIONS ' +
          '(admitted/rejected + reason, duplicate_of, cell key, quality) are the shipped archive’s own rows — the same rule the treatment arms ran',
    },
    rows,
    rejections,
    counts: {
      generated: args.candidates.length,
      admitted,
      rejected: rejections.length,
      below_incumbent: 0,
    },
    coverage: null,
    tokens: args.tokens ?? 0,
    trigger_at: args.triggerAt ?? null,
    // The empty block, spelled exactly as the fixture generator has always
    // written it: a caller that passes `outcomes` replaces it wholesale.
    outcomes: args.outcomes ?? { recorded: 0, useful_information: 0, mere_variance: 0, unnecessary_cost: 0, decisions: [] },
    ...controlTaskQualityEvidence(
      args.declaredBy ?? 'server/tests/unit/imagination-baseline-fixture.test.ts',
    ),
  };
}
