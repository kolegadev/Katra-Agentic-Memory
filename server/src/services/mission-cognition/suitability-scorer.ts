// Phase 4 suitability scorer — projects agent profiles from OBSERVABLE
// outcomes only (criterion 9): work-class attempts/successes derived from
// ledger authorship and accepted deltas. NEVER reads private journals,
// reflections, or emotional state — the projection contains derived,
// non-narrative fields only (criterion 8, profile schema const).
// Correlation penalty: candidates whose recent accepted deltas share the
// incumbent claim's author are penalised (criterion 10). Workload penalty:
// queued/in-progress item counts per agent (criterion 11).
// Part of the no-publish branch feat/cognitive-control-local.
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';

export interface AgentProfileProjection {
  agent_id: string;
  work_class_metrics: Record<string, { attempts: number; success_rate: number }>;
  derived_from_private_memory: false;
}

export interface SuitabilityInput {
  agentId: string;
  workItemDescription: string;
  incumbentAuthorId?: string;
}

export interface SuitabilityResult {
  agent_id: string;
  suitability: number;
  factors: Array<{ factor: string; value: number }>;
  exclusion_reason?: string;
}

const WORK_CLASS_PATTERNS: Array<{ className: string; pattern: RegExp }> = [
  { className: 'investigation', pattern: /investigat|resolv|uncertainty|throttl|evidence/i },
  { className: 'planning', pattern: /objective|plan|dependency|block/i },
  { className: 'verification', pattern: /verif|checkpoint|audit|review/i },
  { className: 'building', pattern: /build|implement|fix|advance/i },
];

function classifyWork(description: string): string {
  for (const { className, pattern } of WORK_CLASS_PATTERNS) {
    if (pattern.test(description)) return className;
  }
  return 'general';
}

/** Derived, non-narrative profile from mission-cognition collections only. */
export async function projectAgentProfile(db: Db, agentId: string): Promise<AgentProfileProjection> {
  const accepted = await db
    .collection(COLLECTIONS.stateDeltas)
    .find({ author_id: agentId, status: 'accepted' }, { projection: { _id: 0, delta_type: 1, rationale: 1 } })
    .limit(200)
    .toArray();
  const entries = await db
    .collection(COLLECTIONS.epistemicEntries)
    .find({ author_id: agentId }, { projection: { _id: 0, entry_type: 1, status: 1 } })
    .limit(500)
    .toArray();

  const metrics: AgentProfileProjection['work_class_metrics'] = {};
  const tally = (className: string, success: boolean) => {
    const m = (metrics[className] ??= { attempts: 0, success_rate: 0 });
    m.attempts += 1;
    m.success_rate = (m.success_rate * (m.attempts - 1) + (success ? 1 : 0)) / m.attempts;
  };
  for (const d of accepted as Array<{ rationale?: string }>) {
    tally(classifyWork(d.rationale ?? ''), true);
  }
  for (const e of entries as unknown as Array<{ entry_type: string; status: string }>) {
    // Observable outcomes: invalidated/rejected entries count as failures for their class.
    const success = !['invalidated', 'rejected', 'challenged'].includes(e.status);
    tally(classifyWork(e.entry_type), success);
  }

  return { agent_id: agentId, work_class_metrics: metrics, derived_from_private_memory: false };
}

async function workloadCount(db: Db, agentId: string): Promise<number> {
  const queued = await db
    .collection(COLLECTIONS.cognitiveWorkItems)
    .countDocuments({ status: { $in: ['allocated', 'in_progress'] }, 'ownership.agent_id': agentId });
  return queued;
}

async function sharesIncumbentRationale(db: Db, agentId: string, incumbentAuthorId: string | undefined, missionId?: string): Promise<boolean> {
  if (!incumbentAuthorId) return false;
  const filter: Record<string, unknown> = { author_id: agentId, status: 'accepted' };
  if (missionId) filter.mission_id = missionId;
  const own = await db
    .collection(COLLECTIONS.stateDeltas)
    .find(filter, { projection: { _id: 0, ledger_entries: 1 } })
    .limit(50)
    .toArray();
  const incumbent = await db
    .collection(COLLECTIONS.stateDeltas)
    .find({ author_id: incumbentAuthorId, status: 'accepted' }, { projection: { _id: 0, rationale: 1 } })
    .limit(50)
    .toArray();
  if (incumbent.length === 0) return false;
  const incumbentText = JSON.stringify(incumbent).toLowerCase();
  return (own as Array<Record<string, unknown>>).some(d => {
    const text = JSON.stringify(d).toLowerCase();
    // Coarse observable overlap: same rationale or same ledger-entry statements.
    return incumbentText.length > 0 && text.includes(incumbentText.slice(0, 80).replace(/[^a-z0-9 ]/g, ''));
  });
}

export async function scoreSuitability(
  db: Db,
  input: SuitabilityInput & { missionId?: string },
): Promise<SuitabilityResult> {
  const profile = await projectAgentProfile(db, input.agentId);
  const workClass = classifyWork(input.workItemDescription);
  const metrics = profile.work_class_metrics[workClass] ?? { attempts: 0, success_rate: 0 };
  const experience = Math.min(metrics.attempts, 50) / 10;
  const performance = metrics.attempts > 0 ? metrics.success_rate : 0.5; // neutral prior
  const workload = await workloadCount(db, input.agentId);
  const workloadPenalty = Math.min(workload, 10);
  const correlated = await sharesIncumbentRationale(db, input.agentId, input.incumbentAuthorId, input.missionId);
  const correlationPenalty = correlated ? 2 : 0;
  // disposition_fit / memory_signal / capability_fit: neutral (documented, no
  // data sources exist yet — recorded as 0 rather than invented).
  const suitability =
    experience + performance * 2 + 0 + 0 + 0 - workloadPenalty - correlationPenalty;

  return {
    agent_id: input.agentId,
    suitability: Number.isFinite(suitability) ? suitability : 0,
    factors: [
      { factor: 'domain_experience', value: experience },
      { factor: 'historical_performance', value: performance * 2 },
      { factor: 'cognitive_disposition_fit', value: 0 },
      { factor: 'relevant_memory_signal', value: 0 },
      { factor: 'capability_fit', value: 0 },
      { factor: 'workload_penalty', value: -workloadPenalty },
      { factor: 'correlation_penalty', value: -correlationPenalty },
    ],
  };
}

/** Known persistent agents for shadow ranking (derived from client_keys, non-private). */
export async function candidateAgents(db: Db): Promise<string[]> {
  const rows = await db
    .collection('system_settings')
    .findOne({ key: 'client_keys' }, { projection: { _id: 0, value: 1 } });
  const ids = new Set<string>();
  const value = (rows as any)?.value;
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, any>)) {
      if (entry?.user_id) ids.add(String(entry.user_id));
    }
  }
  // Candidates come only from client_keys: an identity is deployment data, not code.
  // A deployment with no client keys has no candidates, and the scheduler reports that
  // as an empty decision rather than inventing one.
  return [...ids].filter((v, i, a) => a.indexOf(v) === i);
}
