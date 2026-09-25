// Phase 5 uncertainty engine — DETERMINISTIC TRIGGER DETECTORS (doc 03 Workflow 5).
// All eight detectors are pure functions over persisted epistemic state.
// NO model calls in the detection path (criterion 2 — asserted by static
// guard test); identical state yields an identical trigger set (criterion 3);
// each detector has a firing fixture and a near-miss fixture (criterion 4).
// Part of the no-publish branch feat/cognitive-control-local.
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import type { FiredTrigger, TriggerType } from '../../types/cognitive-control.js';

interface EntryLike {
  entry_id: string;
  mission_id: string;
  entry_type: string;
  statement: string;
  status: string;
  author_id?: string;
  confidence?: number;
  confidence_history?: Array<{ prior: number; next: number; actor_id?: string }>;
  depends_on?: string[];
  evidence_for?: string[];
  evidence_against?: string[];
  alternative_hypotheses?: string[];
  consequence_if_false?: string;
  created_at?: string;
  updated_at?: string;
}

const HIGH_CONFIDENCE = 0.8;
const FAILURE_THRESHOLD = 3;
const HIGH_IMPACT = new Set(['critical', 'high']);

async function entries(db: Db, missionId: string): Promise<EntryLike[]> {
  return db
    .collection(COLLECTIONS.epistemicEntries)
    .find({ mission_id: missionId }, { projection: { _id: 0 } })
    .toArray() as unknown as EntryLike[];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** (a) repeated failure with stable/rising confidence. */
function detectRepeatedFailureStableConfidence(all: EntryLike[]): FiredTrigger[] {
  const fired: FiredTrigger[] = [];
  const hypotheses = all.filter(e => e.entry_type === 'hypothesis' && ['active', 'accepted'].includes(e.status));
  const failedTests = all.filter(e => ['experiment', 'result'].includes(e.entry_type) && ['rejected', 'invalidated'].includes(e.status));
  for (const h of hypotheses) {
    const linkedFailures = failedTests.filter(t => (t.depends_on ?? []).includes(h.entry_id));
    if (linkedFailures.length < FAILURE_THRESHOLD) continue;
    const history = h.confidence_history ?? [];
    const stableOrRising =
      history.length >= 2 &&
      history.slice(1).every((c, i) => (c.next ?? 0) >= (history[i]?.next ?? 0) - 1e-9);
    if (stableOrRising) {
      fired.push({
        trigger: 'repeated_failure_stable_confidence',
        mission_id: h.mission_id,
        entry_id: h.entry_id,
        reason: `hypothesis ${h.entry_id} has ${linkedFailures.length} linked rejected/invalidated tests while confidence is stable or rising across ${history.length} recorded changes`,
        consequence_if_false: h.consequence_if_false,
      });
    }
  }
  return fired;
}

/** (b) high confidence supported only by inferred or inherited assumptions. */
function detectHighConfidenceUnsupported(all: EntryLike[]): FiredTrigger[] {
  const fired: FiredTrigger[] = [];
  const byId = new Map(all.map(e => [e.entry_id, e]));
  const candidates = all.filter(e =>
    ['claim', 'decision', 'assumption'].includes(e.entry_type) &&
    ['accepted', 'active'].includes(e.status) &&
    (e.confidence ?? 0) >= HIGH_CONFIDENCE,
  );
  for (const c of candidates) {
    const directEvidence = (c.evidence_for ?? []).filter(id => byId.get(id)?.entry_type === 'evidence');
    const deps = (c.depends_on ?? []).map(id => byId.get(id)).filter(Boolean) as EntryLike[];
    const supportedByAssumptions = deps.length > 0 && deps.every(d => d.entry_type === 'assumption');
    if (directEvidence.length === 0 && supportedByAssumptions) {
      fired.push({
        trigger: 'high_confidence_unsupported',
        mission_id: c.mission_id,
        entry_id: c.entry_id,
        reason: `entry ${c.entry_id} (${c.entry_type}) holds confidence ${c.confidence} with no direct evidence and depends only on assumption entries [${deps.map(d => d.entry_id).join(', ')}]`,
        consequence_if_false: c.consequence_if_false,
      });
    }
  }
  return fired;
}

/** (c) single active hypothesis for a high-impact decision. */
function detectSingleHypothesisHighImpact(all: EntryLike[]): FiredTrigger[] {
  const fired: FiredTrigger[] = [];
  const decisions = all.filter(e => e.entry_type === 'decision' && e.status === 'accepted');
  const activeHypotheses = all.filter(e => e.entry_type === 'hypothesis' && ['active', 'accepted'].includes(e.status));
  for (const d of decisions) {
    if (!HIGH_IMPACT.has((d.consequence_if_false ?? '').toLowerCase())) continue;
    const linked = (d.depends_on ?? []).filter(id => activeHypotheses.some(h => h.entry_id === id));
    if (activeHypotheses.length <= 1 || linked.length <= 1) {
      fired.push({
        trigger: 'single_hypothesis_high_impact',
        mission_id: d.mission_id,
        entry_id: d.entry_id,
        reason: `high-impact decision ${d.entry_id} (consequence_if_false=${d.consequence_if_false}) rests on ${linked.length} linked active hypothesis/hypotheses (${activeHypotheses.length} active mission-wide) — no genuine alternative in view`,
        consequence_if_false: d.consequence_if_false,
      });
    }
  }
  return fired;
}

/** (d) material contradictory evidence — recorded structurally in the model. */
function detectMaterialContradictoryEvidence(all: EntryLike[]): FiredTrigger[] {
  return all
    .filter(e => e.entry_type === 'evidence' && ['accepted', 'active'].includes(e.status) && (e.evidence_against ?? []).length > 0)
    .map(e => ({
      trigger: 'material_contradictory_evidence' as TriggerType,
      mission_id: e.mission_id,
      entry_id: e.entry_id,
      reason: `evidence ${e.entry_id} structurally contradicts accepted entries [${(e.evidence_against ?? []).join(', ')}]`,
    }));
}

/** (e) unexpected experiment result — an experiment carrying contradiction. */
function detectUnexpectedExperimentResult(all: EntryLike[]): FiredTrigger[] {
  return all
    .filter(e => e.entry_type === 'experiment' && ['accepted', 'active'].includes(e.status) && (e.evidence_against ?? []).length > 0)
    .map(e => ({
      trigger: 'unexpected_experiment_result' as TriggerType,
      mission_id: e.mission_id,
      entry_id: e.entry_id,
      reason: `experiment ${e.entry_id} recorded a result contradicting [${(e.evidence_against ?? []).join(', ')}] — prior expectation did not survive contact with evidence`,
    }));
}

/** (f) plan unchanged despite information that should affect it. */
function detectPlanUnchangedDespiteEvidence(all: EntryLike[]): FiredTrigger[] {
  const fired: FiredTrigger[] = [];
  const decisions = all.filter(e => e.entry_type === 'decision').sort((a, b) => String(a.updated_at ?? '').localeCompare(String(b.updated_at ?? '')));
  const latestDecision = decisions[decisions.length - 1];
  if (!latestDecision) return fired;
  const evidenceAfterDecision = all.filter(e =>
    e.entry_type === 'evidence' && e.status === 'accepted' &&
    String(e.created_at ?? '') > String(latestDecision.updated_at ?? latestDecision.created_at ?? ''),
  );
  // A plan change is signalled by contradiction/plan entries after the evidence arrived.
  const planReaction = all.filter(e =>
    ['contradiction', 'uncertainty'].includes(e.entry_type) &&
    String(e.created_at ?? '') >= String(evidenceAfterDecision[0]?.created_at ?? ''),
  );
  if (evidenceAfterDecision.length > 0 && planReaction.length === 0) {
    fired.push({
      trigger: 'plan_unchanged_despite_evidence',
      mission_id: latestDecision.mission_id,
      entry_id: latestDecision.entry_id,
      reason: `${evidenceAfterDecision.length} accepted evidence entr(ies) landed after the latest decision ${latestDecision.entry_id} and no contradiction/uncertainty entry followed`,
    });
  }
  return fired;
}

/** (g) strong critic disagreement or unstable provenance. */
function detectCriticDisagreement(all: EntryLike[]): FiredTrigger[] {
  const fired: FiredTrigger[] = [];
  for (const c of all.filter(e => e.entry_type === 'contradiction' && ['active', 'accepted'].includes(e.status))) {
    fired.push({
      trigger: 'critic_disagreement',
      mission_id: c.mission_id,
      entry_id: c.entry_id,
      reason: `explicit contradiction entry ${c.entry_id} is ${c.status}: ${c.statement.slice(0, 140)}`,
    });
  }
  // Opposite-sign confidence changes by distinct actors on the same entry.
  for (const e of all) {
    const history = e.confidence_history ?? [];
    const up = history.some(c => (c.next ?? 0) > (c.prior ?? 0));
    const down = history.some(c => (c.next ?? 0) < (c.prior ?? 0));
    const actors = new Set(history.map(c => c.actor_id).filter(Boolean));
    if (up && down && actors.size >= 2) {
      fired.push({
        trigger: 'critic_disagreement',
        mission_id: e.mission_id,
        entry_id: e.entry_id,
        reason: `entry ${e.entry_id} shows opposite-sign confidence changes from ${actors.size} distinct actors — unstable provenance`,
      });
    }
  }
  return fired;
}

/** (h) convergent agents sharing one incumbent rationale. */
function detectConvergentAgents(all: EntryLike[]): FiredTrigger[] {
  const fired: FiredTrigger[] = [];
  const groups = new Map<string, EntryLike[]>();
  for (const e of all.filter(x => ['hypothesis', 'claim'].includes(x.entry_type) && ['accepted', 'active'].includes(x.status))) {
    const key = norm(e.statement).slice(0, 120);
    if (!key) continue;
    const g = groups.get(key) ?? [];
    g.push(e);
    groups.set(key, g);
  }
  for (const group of groups.values()) {
    const authors = new Set(group.map(e => e.author_id).filter(Boolean));
    if (authors.size >= 2) {
      fired.push({
        trigger: 'convergent_agents',
        mission_id: group[0].mission_id,
        entry_id: group[0].entry_id,
        reason: `${group.length} accepted entries by ${authors.size} distinct agents share one incumbent statement ("${group[0].statement.slice(0, 80)}") — agreement may be correlation, not independence`,
      });
    }
  }
  return fired;
}

export async function evaluateTriggers(db: Db, missionId: string): Promise<{ fired: FiredTrigger[]; byTrigger: Record<string, number> }> {
  const all = await entries(db, missionId);
  const detectors: Array<[TriggerType, (es: EntryLike[]) => FiredTrigger[]]> = [
    ['repeated_failure_stable_confidence', detectRepeatedFailureStableConfidence],
    ['high_confidence_unsupported', detectHighConfidenceUnsupported],
    ['single_hypothesis_high_impact', detectSingleHypothesisHighImpact],
    ['material_contradictory_evidence', detectMaterialContradictoryEvidence],
    ['unexpected_experiment_result', detectUnexpectedExperimentResult],
    ['plan_unchanged_despite_evidence', detectPlanUnchangedDespiteEvidence],
    ['critic_disagreement', detectCriticDisagreement],
    ['convergent_agents', detectConvergentAgents],
  ];
  const fired: FiredTrigger[] = [];
  const byTrigger: Record<string, number> = {};
  for (const [type, detect] of detectors) {
    const hits = detect(all);
    byTrigger[type] = hits.length;
    fired.push(...hits);
  }
  return { fired, byTrigger };
}
