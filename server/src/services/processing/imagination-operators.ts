/**
 * Imagination operators — the ten families, their trace-driven selection, and
 * the seeded PRNG every operator decision goes through (ITER-6, Phase 4).
 *
 * Contract: CONTRACT-iter6-imagination-engine.md §A.1–§A.2.
 *
 * WHY THIS IS NOT A RANDOM GENERATOR: "random_semantic_bridge" is the name of
 * a CREATIVE operator, not a licence to be non-deterministic. Every choice this
 * module makes — which families run, which signals drive them, how ties break,
 * where the distant-association walk starts and which way it turns — comes
 * from `mulberry32(hashSeed(seed))`, a 32-bit PRNG seeded from the run's seed
 * string. Same seed + same trace → same plan, byte for byte. `Math.random()`
 * and `randomUUID()` are NEVER used here (a source-level guard test proves it).
 *
 * THE TRACE-DRIVEN MAPPING (documented, per the contract's examples):
 *
 *   attraction      → representation_shift, distant_analogy, tool_invention
 *   tension         → contradiction_preservation, constraint_mutation, boundary_extreme
 *   surprise        → causal_reversal, counterfactual_world, boundary_extreme
 *   absence         → assumption_inversion, tool_invention, random_semantic_bridge
 *   persistent_pull → constraint_mutation, assumption_inversion, counterfactual_world
 *   question        → random_semantic_bridge, distant_analogy, counterfactual_world
 *
 * A family's score is the sum of the intensities of the signals whose kind
 * maps to it, so what the trace actually presses on decides what runs; the
 * seeded tie-break decides only the ORDER among equal scores, and a seeded
 * fill decides the remainder when the budget allows more operators than the
 * trace triggers (recorded as `seeded_fill`, never as "the trace suggested
 * this").
 */
import {
  sha256Hex as sha256HexFromIter5,
  stableStringify as stableStringifyFromIter5,
  type SalienceSignal,
  type SalienceSignalKind,
} from './focused-consolidation-service.js';

// ── Seeded PRNG ─────────────────────────────────────────────────────────────

/**
 * FNV-1a over the seed string → uint32. The PRNG's only input, so a seed like
 * `'cycle-7'` and the number `7` are different seeds and every derived id
 * depends on which one the caller chose.
 */
export function hashSeed(seed: string | number): number {
  const text = typeof seed === 'number' ? `n:${seed}` : `s:${seed}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — tiny, fast, 32-bit, fully determined by its 32-bit state. */
export function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A named, reproducible random stream. Nothing here reads a global RNG. */
export class SeededRandom {
  private readonly next: () => number;

  constructor(readonly seedString: string, readonly seed: number = hashSeed(seedString)) {
    this.next = mulberry32(this.seed);
  }

  /** Next float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Next integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (!Number.isFinite(maxExclusive) || maxExclusive <= 1) return 0;
    return Math.floor(this.next() * maxExclusive);
  }

  /** Pick one element, or `null` for an empty list. */
  pick<T>(items: readonly T[]): T | null {
    if (items.length === 0) return null;
    return items[this.int(items.length)] ?? null;
  }

  /** Fisher–Yates over a copy: the same list and seed always reorder the same. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

export function stableStringify(value: unknown): string {
  return stableStringifyFromIter5(value);
}

export function sha256Hex(payload: string): string {
  return sha256HexFromIter5(payload);
}

/**
 * Every id this feature stores is DERIVED, never generated: `sha256` over a
 * canonical payload that includes the kind tag, the mission and the PRNG seed.
 * Two runs with the same seed over the same inputs therefore produce the same
 * ids — which is what makes the portfolio reproducible (and what a `uuid would
 * silently break).
 */
export function derivedId(kind: string, payload: Record<string, unknown>, seed: number): string {
  const digest = sha256Hex(stableStringify({ kind, seed, payload }));
  return `${kind}_${digest.slice(0, 32)}`;
}

// ── The ten families ────────────────────────────────────────────────────────

export const OPERATOR_FAMILIES = [
  'assumption_inversion',
  'representation_shift',
  'distant_analogy',
  'constraint_mutation',
  'boundary_extreme',
  'causal_reversal',
  'contradiction_preservation',
  'tool_invention',
  'random_semantic_bridge',
  'counterfactual_world',
] as const;

export type OperatorFamily = (typeof OPERATOR_FAMILIES)[number];

/** The trace kinds that drive each family (the documented mapping above). */
export const OPERATOR_TRACE_MAP: Record<SalienceSignalKind, readonly OperatorFamily[]> = {
  attraction: ['representation_shift', 'distant_analogy', 'tool_invention'],
  tension: ['contradiction_preservation', 'constraint_mutation', 'boundary_extreme'],
  surprise: ['causal_reversal', 'counterfactual_world', 'boundary_extreme'],
  absence: ['assumption_inversion', 'tool_invention', 'random_semantic_bridge'],
  persistent_pull: ['constraint_mutation', 'assumption_inversion', 'counterfactual_world'],
  question: ['random_semantic_bridge', 'distant_analogy', 'counterfactual_world'],
};

/** The inverse view: which kinds drive a family (deterministic order). */
export function traceKindsFor(family: OperatorFamily): SalienceSignalKind[] {
  return (Object.keys(OPERATOR_TRACE_MAP) as SalienceSignalKind[])
    .filter((kind) => OPERATOR_TRACE_MAP[kind].includes(family))
    .sort((a, b) => a.localeCompare(b));
}

/** Operators that must state a bridge produced by the distant-association walk. */
export const BRIDGE_OPERATORS: readonly OperatorFamily[] = ['random_semantic_bridge', 'distant_analogy'];

export interface OperatorSpec {
  family: OperatorFamily;
  /** What the operator does, in one operational sentence (also sent to the model). */
  intent: string;
  /**
   * Every seed this operator produces must carry these fields non-empty. The
   * `mechanism` requirement is universal; the bridge operators additionally
   * require the walk's path (`bridge_path`) and a stated bridge.
   */
  required_output: readonly string[];
}

export const OPERATOR_SPECS: Record<OperatorFamily, OperatorSpec> = {
  assumption_inversion: {
    family: 'assumption_inversion',
    intent: 'find the assumption the mission treats as necessary and invert it, then say what becomes true',
    required_output: ['hypothesis', 'mechanism', 'cheapest_test', 'evidence_refs'],
  },
  representation_shift: {
    family: 'representation_shift',
    intent: 're-express the same problem in a different representation (table, graph, protocol, numeric, prose) and see what the new form makes visible',
    required_output: ['hypothesis', 'mechanism', 'cheapest_test', 'evidence_refs'],
  },
  distant_analogy: {
    family: 'distant_analogy',
    intent: 'carry a mechanism from the bridge path\'s far node onto this mission\'s problem, stating the bridge explicitly',
    required_output: ['hypothesis', 'mechanism', 'cheapest_test', 'evidence_refs', 'bridge_path', 'bridge'],
  },
  constraint_mutation: {
    family: 'constraint_mutation',
    intent: 'mutate one stated constraint (tighten, loosen, remove, replace) and predict the consequence',
    required_output: ['hypothesis', 'mechanism', 'cheapest_test', 'evidence_refs'],
  },
  boundary_extreme: {
    family: 'boundary_extreme',
    intent: 'push a variable to its boundary (zero, one, maximum, infinite) and describe the resulting regime',
    required_output: ['hypothesis', 'mechanism', 'cheapest_test', 'evidence_refs'],
  },
  causal_reversal: {
    family: 'causal_reversal',
    intent: 'reverse the assumed direction of causation and check whether the evidence still fits',
    required_output: ['hypothesis', 'mechanism', 'cheapest_test', 'evidence_refs'],
  },
  contradiction_preservation: {
    family: 'contradiction_preservation',
    intent: 'hold two conflicting pieces of evidence at once instead of resolving them, and state what both being true would require',
    required_output: ['hypothesis', 'mechanism', 'cheapest_test', 'evidence_refs'],
  },
  tool_invention: {
    family: 'tool_invention',
    intent: 'invent the smallest instrument or procedure that would make the missing observation cheap',
    required_output: ['hypothesis', 'mechanism', 'cheapest_test', 'evidence_refs'],
  },
  random_semantic_bridge: {
    family: 'random_semantic_bridge',
    intent: 'bridge the mission\'s problem to the far end of the given walk path, stating the bridge explicitly',
    required_output: ['hypothesis', 'mechanism', 'cheapest_test', 'evidence_refs', 'bridge_path', 'bridge'],
  },
  counterfactual_world: {
    family: 'counterfactual_world',
    intent: 'state the world in which the mission\'s current approach was never chosen, and what that world predicts here',
    required_output: ['hypothesis', 'mechanism', 'cheapest_test', 'evidence_refs'],
  },
};

// ── The plan ────────────────────────────────────────────────────────────────

export type PlanReason = 'trace_triggered' | 'seeded_fill' | 'mode_explore';

export interface OperatorPlanEntry {
  operator: OperatorFamily;
  /** Σ intensity of the trace signals whose kind maps to this family. */
  score: number;
  /** The trace signal ids that drove this family (empty for a seeded fill). */
  triggered_by: string[];
  signal_kinds: SalienceSignalKind[];
  reason: PlanReason;
  /** Seeded tie-break rank: lower runs first among equal scores. */
  tie_break: number;
  /** Set when the operator cannot run (e.g. no bridge path); it is not executed. */
  skipped?: boolean;
  skip_reason?: string;
}

export interface TraceSignalForPlan {
  signal_id: string;
  kind: SalienceSignalKind;
  intensity: number;
  confidence: number;
}

/** Adapt a stored trace into the plan's view (ids derived from the trace id). */
export function signalsForPlan(
  traceId: string,
  signals: readonly SalienceSignal[],
): TraceSignalForPlan[] {
  return signals.map((signal, index) => ({
    signal_id: traceSignalId(traceId, index),
    kind: signal.kind,
    intensity: signal.intensity,
    confidence: signal.confidence,
  }));
}

/**
 * The evidence id of a trace signal. The stored trace carries no per-signal id
 * (ITER-5 stores signals positionally), so the id is DERIVED from the trace id
 * and the signal's index — stable for a given trace, and the only form in
 * which a seed may cite a signal. The same function is used to build the
 * model's evidence index and to validate what comes back, so a cited signal id
 * can never be invented.
 */
export function traceSignalId(traceId: string, index: number): string {
  return `sig_${sha256Hex(`${traceId}:${index}`).slice(0, 16)}`;
}

export interface PlanOptions {
  /** Hard cap from the run's budget (`maxOperators`). */
  maxOperators: number;
  /** 'explore' prefers untouched families; 'exploit' is strictly score-ordered. */
  mode?: 'explore' | 'exploit' | 'balanced' | null;
  /** Families that cannot run in this cycle (e.g. no bridge path available). */
  unavailable?: Partial<Record<OperatorFamily, string>>;
}

/**
 * Score the families from the trace, order them deterministically, and take
 * the first `maxOperators` — filling with seeded picks when the trace triggers
 * fewer families than the budget allows. Pure: same signals + same seed → same
 * plan.
 */
export function planOperators(
  signals: readonly TraceSignalForPlan[],
  rng: SeededRandom,
  options: PlanOptions,
): OperatorPlanEntry[] {
  const maxOperators = Math.max(0, Math.floor(options.maxOperators));
  if (maxOperators === 0) return [];

  const byFamily = new Map<OperatorFamily, { score: number; signals: TraceSignalForPlan[] }>();
  for (const family of OPERATOR_FAMILIES) byFamily.set(family, { score: 0, signals: [] });
  for (const signal of signals) {
    for (const family of OPERATOR_TRACE_MAP[signal.kind] ?? []) {
      const entry = byFamily.get(family);
      if (!entry) continue;
      entry.score += signal.intensity;
      entry.signals.push(signal);
    }
  }

  // One seeded rank per family, fixed BEFORE sorting: ranking is a function of
  // (score, seeded rank, name) and never of the input order. The shuffle is
  // consumed in a fixed position of the stream, so every later draw (the
  // explore-mode shuffle, the fill order, the walk) stays aligned.
  const tieBreak = new Map<OperatorFamily, number>();
  for (const [rank, family] of rng.shuffle(OPERATOR_FAMILIES).entries()) tieBreak.set(family, rank);

  const compare = (a: OperatorFamily, b: OperatorFamily): number => {
    const sa = byFamily.get(a)?.score ?? 0;
    const sb = byFamily.get(b)?.score ?? 0;
    if (sb !== sa) return sb - sa;
    const ta = tieBreak.get(a) ?? 0;
    const tb = tieBreak.get(b) ?? 0;
    if (ta !== tb) return ta - tb;
    return a.localeCompare(b);
  };

  const triggered = OPERATOR_FAMILIES.filter((family) => (byFamily.get(family)?.score ?? 0) > 0).sort(compare);
  const untriggered = OPERATOR_FAMILIES.filter((family) => (byFamily.get(family)?.score ?? 0) <= 0).sort(compare);

  const mode = options.mode ?? 'balanced';
  const ordered: Array<{ family: OperatorFamily; reason: PlanReason }> = [];
  if (mode === 'explore') {
    // Diversity first: the seeded order decides, then score order tops up.
    const shuffledTriggered = rng.shuffle(triggered);
    for (const family of shuffledTriggered) ordered.push({ family, reason: 'mode_explore' });
    const shuffledUntriggered = rng.shuffle(untriggered);
    for (const family of shuffledUntriggered) ordered.push({ family, reason: 'seeded_fill' });
  } else {
    for (const family of triggered) ordered.push({ family, reason: 'trace_triggered' });
    for (const family of untriggered) ordered.push({ family, reason: 'seeded_fill' });
  }

  const plan: OperatorPlanEntry[] = [];
  for (const { family, reason } of ordered.slice(0, maxOperators)) {
    const entry = byFamily.get(family)!;
    const skipReason = options.unavailable?.[family];
    plan.push({
      operator: family,
      score: Number(entry.score.toFixed(6)),
      triggered_by: [...entry.signals.map((s) => s.signal_id)].sort(),
      signal_kinds: [...new Set(entry.signals.map((s) => s.kind))].sort(),
      reason,
      tie_break: tieBreak.get(family) ?? 0,
      ...(skipReason ? { skipped: true, skip_reason: skipReason } : {}),
    });
  }
  return plan;
}
