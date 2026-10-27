// Phase 4 work-item generator — real triggers only (criterion 2):
// open objectives, blocked dependencies, active uncertainties, invalidated
// decisions, stale checkpoints. Every item carries the full priority feature
// vector (criterion 3). Pure functions over stored state — deterministic.
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import { measureCognitiveCost } from './cost-model.js';
import type { BatonMode, CognitiveWorkItem, MissionState } from '../../types/cognitive-control.js';

const STALE_CHECKPOINT_HOURS = 24;
const BLOCKED_MODES: BatonMode[] = ['challenge', 'explore'];

interface MissionRow {
  mission_id: string;
  title: string;
  status: string;
  authority_class: string;
  objectives?: Array<{ id: string; description: string; status: string; dependency_ids?: string[] }>;
  updated_at: string;
  checkpoint_id?: string | null;
}

export interface GeneratedItem {
  item: Omit<CognitiveWorkItem, 'work_item_id' | 'created_at' | 'updated_at'>;
  trigger: CognitiveWorkItem['trigger'];
  description: string;
}

/**
 * A work item an AUTHORISED caller supplies instead of one this generator
 * derived from mission state (ITER-7: the Creative Baton adapter is the only
 * such caller). It is not a second write path — it is an extra INPUT to this
 * generator, so the item is built here with the same priority feature vector and
 * persisted by the same `SchedulerService.upsertWorkItems` funnel and the same
 * `{mission_id, trigger, description}` dedupe.
 *
 * `provenance` is stamped on the row (the work-item schema tolerates extra
 * keys) so a baton-derived item can be traced to the baton and seed it came
 * from without parsing the description.
 */
export interface ExtraWorkItem {
  trigger: CognitiveWorkItem['trigger'];
  description: string;
  mode: BatonMode;
  provenance?: Record<string, unknown>;
}

function missionImpact(state: MissionRow): number {
  // Derived, documented heuristic: active missions with unmet criteria and
  // open uncertainty weigh more; authority class A/B/C scales the impact.
  const base: Record<string, number> = { A: 3, B: 2, C: 1 };
  const impact = base[state.authority_class] ?? 1;
  const openObjectives = (state.objectives ?? []).filter(o => o.status !== 'completed' && o.status !== 'cancelled').length;
  return impact + Math.min(openObjectives, 5);
}

function uncertaintyValue(activeUncertaintyCount: number): number {
  return Math.min(activeUncertaintyCount, 10);
}

function informationValue(activeUncertaintyCount: number, unresolvedExperiments: number): number {
  return 1 + Math.min(activeUncertaintyCount, 8) + Math.min(unresolvedExperiments, 4);
}

function dependencyCentrality(objectives: MissionRow['objectives']): number {
  const byId = new Map((objectives ?? []).map(o => [o.id, o]));
  let dependents = 0;
  for (const o of objectives ?? []) {
    dependents += (o.dependency_ids ?? []).filter(d => byId.has(d)).length;
  }
  return dependents;
}

function urgency(staleCheckpoint: boolean, blockedCount: number, invalidatedDecisions: number): number {
  return (staleCheckpoint ? 3 : 0) + Math.min(blockedCount * 2, 6) + Math.min(invalidatedDecisions * 2, 4) + 1;
}

export async function generateWorkItems(
  db: Db,
  missionId: string,
  options: { extra?: readonly ExtraWorkItem[] } = {},
): Promise<GeneratedItem[]> {
  const state = await db
    .collection<MissionRow & { _id?: unknown }>(COLLECTIONS.missionStates)
    .findOne({ mission_id: missionId }, { projection: { _id: 0 } });
  if (!state || state.status === 'completed' || state.status === 'cancelled') return [];

  const objectives = state.objectives ?? [];
  const completed = new Set(objectives.filter(o => o.status === 'completed').map(o => o.id));
  const blocked = objectives.filter(o => o.status === 'blocked');
  const openObjectives = objectives.filter(
    o => (o.status === 'pending' || o.status === 'ready') && (o.dependency_ids ?? []).every(d => completed.has(d)),
  );

  const activeUncertainties = await db
    .collection(COLLECTIONS.epistemicEntries)
    .countDocuments({ mission_id: missionId, entry_type: 'uncertainty', status: { $in: ['active', 'accepted', 'challenged'] } });
  const invalidatedDecisions = await db
    .collection(COLLECTIONS.epistemicEntries)
    .countDocuments({ mission_id: missionId, entry_type: 'decision', status: 'invalidated' });
  const unresolvedExperiments = await db
    .collection(COLLECTIONS.epistemicEntries)
    .countDocuments({ mission_id: missionId, entry_type: 'experiment', status: { $in: ['active', 'proposed', 'accepted'] } });

  const checkpointDoc = await db
    .collection(COLLECTIONS.missionStateVersions)
    .findOne({ mission_id: missionId }, { projection: { _id: 0, created_at: 1 }, sort: { version: -1 } });
  const checkpointAgeHours = checkpointDoc?.created_at
    ? (Date.now() - Date.parse(checkpointDoc.created_at)) / 3600e3
    : Infinity;
  const staleCheckpoint = checkpointAgeHours > STALE_CHECKPOINT_HOURS;

  const impact = missionImpact(state);
  const uncertainty = uncertaintyValue(activeUncertainties);
  const infoValue = informationValue(activeUncertainties, unresolvedExperiments);
  const centrality = dependencyCentrality(objectives);
  const urg = urgency(staleCheckpoint, blocked.length, invalidatedDecisions);

  // Real measurement (§2 option a): cognitive_cost = measured tokens for the
  // mission scope. One measurement serves all items generated in this pass.
  const measured = await measureCognitiveCost(db, missionId);
  const cost = measured.cost;
  const costBasis = measured.basis;

  const features = (mode: BatonMode) => ({
    mission_impact: impact,
    uncertainty,
    information_value: infoValue,
    dependency_centrality: centrality,
    urgency: urg,
    cognitive_cost: cost,
    cost_basis: costBasis,
  });

  const items: GeneratedItem[] = [];
  const push = (
    trigger: GeneratedItem['trigger'],
    description: string,
    mode: BatonMode,
    provenance?: Record<string, unknown>,
  ) => {
    items.push({
      trigger,
      description,
      item: {
        schema_version: '1.0',
        mission_id: missionId,
        description,
        mode,
        status: 'queued',
        authority_class: state.authority_class as CognitiveWorkItem['authority_class'],
        trigger,
        features: features(mode),
        ...(provenance ? { provenance } : {}),
      } as GeneratedItem['item'],
    });
  };

  for (const o of openObjectives) {
    push('open_objective', `Advance objective ${o.id}: ${o.description.slice(0, 160)}`, 'execute');
  }
  for (const b of blocked) {
    push('blocked_dependency', `Unblock objective ${b.id}: ${b.description.slice(0, 160)}`, 'challenge');
  }
  if (activeUncertainties > 0) {
    push('active_uncertainty', `Resolve ${activeUncertainties} active uncertainty/uncertainties for ${state.title}`, 'explore');
  }
  if (invalidatedDecisions > 0) {
    push('invalidated_decision', `Re-decide after ${invalidatedDecisions} invalidated decision(s)`, 'challenge');
  }
  if (staleCheckpoint) {
    push('stale_checkpoint', `Checkpoint stale (${checkpointAgeHours.toFixed(0)}h) — checkpoint ${state.title}`, 'verify');
  }
  // Caller-supplied items (ITER-7: promoted Creative Baton candidates) come
  // last: they are additional work the mission has already decided to consider,
  // and they are built with the same feature vector as everything else.
  for (const extra of options.extra ?? []) {
    push(extra.trigger, extra.description, extra.mode, extra.provenance);
  }
  // A mission with no triggers still gets nothing — absence of work is a finding, not a filler item.
  return items;
}
