// Phase 8: skill evolution — candidate → replay → canary → promotion, with NO
// path around the gates (contract §4.11-4.16, decisive test B).
//
//   §4.12  promotion without replay evidence, or without canary evidence, is
//          REFUSED and the refusal is recorded
//   §4.13  replay reads historical missions from stored records; a candidate
//          that regresses (recorded negative outcomes) is rejected on that
//          evidence
//   §4.14  canary is scoped (one mission) and reversible (recorded outcome,
//          revocation recorded)
//   §4.15  an active mission's skill version is pinned unless an explicit
//          migration is approved (pin records; trusted callers only)
//   §4.16  promotion requires the configured evidence threshold — a single
//          good run (1 historical usage) is insufficient by construction
//
// All records live in skill_evolution (one collection, declared in
// collections.ts); the promoted version registry lives in skill_registry.
// The promotion path lives entirely in mission-cognition (contract §3 rule:
// prefer not to touch skill-loader-service.ts — this service does not).
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import type { SkillCandidateState, SkillEvolutionRecord } from '../../types/cognitive-control.js';

/** §4.16: replay must cover at least this many historical missions. */
export const REPLAY_MIN_USAGE = 3;
/** §4.13: recorded negative outcomes above this share of usage = regression. */
export const REPLAY_MAX_NEGATIVE_RATE = 0.5;

async function record(
  db: Db,
  entry: Omit<SkillEvolutionRecord, 'entry_id' | 'created_at'>,
): Promise<SkillEvolutionRecord> {
  const full: SkillEvolutionRecord = {
    entry_id: randomUUID(),
    created_at: new Date().toISOString(),
    ...entry,
  };
  await db.collection(COLLECTIONS.skillEvolution).insertOne(full);
  return full;
}

async function refuse(db: Db, skill: string, actorId: string, reason: string, candidateId?: string): Promise<void> {
  await record(db, {
    kind: 'refusal',
    skill,
    actor_id: actorId,
    candidate_id: candidateId,
    note: reason,
  });
}

// ── candidate ──────────────────────────────────────────────────────────────

export async function proposeSkillCandidate(
  db: Db,
  opts: { skill: string; version: string; note: string; actorId: string },
): Promise<SkillEvolutionRecord> {
  if (!opts.skill.trim() || !opts.version.trim()) {
    throw new Error('skill and version are required');
  }
  return record(db, {
    kind: 'candidate',
    skill: opts.skill.trim(),
    version: opts.version.trim(),
    actor_id: opts.actorId,
    candidate_id: `cand_${randomUUID().slice(0, 8)}`,
    note: opts.note,
  });
}

// ── replay (read-only over stored history) ────────────────────────────────

export async function runSkillReplay(
  db: Db,
  opts: { candidateId: string; actorId: string },
): Promise<{ verdict: 'pass' | 'fail' | 'insufficient'; detail: Record<string, unknown> }> {
  const candidate = await db.collection(COLLECTIONS.skillEvolution).findOne(
    { candidate_id: opts.candidateId, kind: 'candidate' },
    { projection: { _id: 0 } },
  ) as unknown as SkillEvolutionRecord | null;
  if (!candidate) throw new Error(`candidate not found: ${opts.candidateId}`);

  const existing = await db.collection(COLLECTIONS.skillEvolution).findOne(
    { candidate_id: opts.candidateId, kind: 'replay' },
    { projection: { _id: 0 } },
  ) as unknown as SkillEvolutionRecord | null;
  if (existing) {
    return { verdict: (existing.detail?.verdict as any) ?? 'insufficient', detail: existing.detail ?? {} };
  }

  // Historical usage: every stored delta or baton that recorded this skill.
  const deltas = (await db
    .collection(COLLECTIONS.stateDeltas)
    .find({}, { projection: { _id: 0, mission_id: 1, skills_used: 1 } })
    .toArray()) as any[];
  const batons = (await db
    .collection(COLLECTIONS.cognitiveBatons)
    .find({}, { projection: { _id: 0, mission_id: 1, skill_versions: 1 } })
    .toArray()) as any[];
  const usageMissions = new Set<string>();
  for (const d of deltas) {
    if (d.skills_used && Object.prototype.hasOwnProperty.call(d.skills_used, candidate.skill)) usageMissions.add(d.mission_id);
  }
  for (const b of batons) {
    if (b.skill_versions && Object.prototype.hasOwnProperty.call(b.skill_versions, candidate.skill)) usageMissions.add(b.mission_id);
  }

  // Recorded negative outcomes on the missions that used the skill.
  const negative = await db
    .collection(COLLECTIONS.triggerEvaluations)
    .countDocuments({ mission_id: { $in: [...usageMissions] }, outcome: 'unnecessary_cost' });
  const totalOutcomes = await db
    .collection(COLLECTIONS.triggerEvaluations)
    .countDocuments({ mission_id: { $in: [...usageMissions] } });

  const usage = usageMissions.size;
  const negativeRate = totalOutcomes > 0 ? negative / totalOutcomes : 0;
  const verdict: 'pass' | 'fail' | 'insufficient' =
    usage < REPLAY_MIN_USAGE
      ? 'insufficient'
      : negativeRate > REPLAY_MAX_NEGATIVE_RATE
        ? 'fail'
        : 'pass';

  const detail = {
    verdict,
    historical_usage_missions: usage,
    replay_min_usage: REPLAY_MIN_USAGE,
    negative_outcomes: negative,
    total_outcomes: totalOutcomes,
    negative_rate: negativeRate,
    replay_max_negative_rate: REPLAY_MAX_NEGATIVE_RATE,
    basis: 'state_deltas.skills_used + cognitive_batons.skill_versions over all historical missions; trigger_evaluations outcomes, read from stored records',
  };
  await record(db, {
    kind: 'replay',
    skill: candidate.skill,
    version: candidate.version,
    actor_id: opts.actorId,
    candidate_id: opts.candidateId,
    detail,
  });
  return { verdict, detail };
}

// ── canary (scoped, reversible) ───────────────────────────────────────────

export async function startSkillCanary(
  db: Db,
  opts: { candidateId: string; missionId: string; actorId: string },
): Promise<SkillEvolutionRecord> {
  const candidate = await db.collection(COLLECTIONS.skillEvolution).findOne(
    { candidate_id: opts.candidateId, kind: 'candidate' },
    { projection: { _id: 0 } },
  ) as unknown as SkillEvolutionRecord | null;
  if (!candidate) throw new Error(`candidate not found: ${opts.candidateId}`);
  const replay = await runSkillReplay(db, { candidateId: opts.candidateId, actorId: opts.actorId });
  if (replay.verdict !== 'pass') {
    await refuse(db, candidate.skill, opts.actorId, `canary refused: replay verdict ${replay.verdict}`, opts.candidateId);
    throw new Error(`canary refused: replay verdict ${replay.verdict} (refusal recorded)`);
  }
  const mission = await db.collection(COLLECTIONS.missionStates).findOne({ mission_id: opts.missionId }, { projection: { mission_id: 1 } });
  if (!mission) throw new Error(`mission not found: ${opts.missionId}`);
  return record(db, {
    kind: 'canary',
    skill: candidate.skill,
    version: candidate.version,
    actor_id: opts.actorId,
    candidate_id: opts.candidateId,
    mission_id: opts.missionId,
    detail: { status: 'active' },
  });
}

export async function completeSkillCanary(
  db: Db,
  opts: { candidateId: string; outcome: 'ok' | 'regressed'; actorId: string },
): Promise<SkillEvolutionRecord> {
  const canary = await db.collection(COLLECTIONS.skillEvolution).findOne(
    { candidate_id: opts.candidateId, kind: 'canary' },
    { projection: { _id: 0 } },
  ) as unknown as SkillEvolutionRecord | null;
  if (!canary) throw new Error(`no canary recorded for ${opts.candidateId}`);
  return record(db, {
    kind: 'canary',
    skill: canary.skill,
    version: canary.version,
    actor_id: opts.actorId,
    candidate_id: opts.candidateId,
    mission_id: canary.mission_id,
    detail: { status: 'completed', outcome: opts.outcome },
  });
}

// ── promotion (the gated end of the chain) ────────────────────────────────

export async function promoteSkillVersion(
  db: Db,
  opts: { candidateId: string; actorId: string },
): Promise<SkillEvolutionRecord> {
  const candidate = await db.collection(COLLECTIONS.skillEvolution).findOne(
    { candidate_id: opts.candidateId, kind: 'candidate' },
    { projection: { _id: 0 } },
  ) as unknown as SkillEvolutionRecord | null;
  if (!candidate) throw new Error(`candidate not found: ${opts.candidateId}`);

  // §4.12 gate 1: replay evidence (a single good run is insufficient by
  // construction — replay requires REPLAY_MIN_USAGE historical missions).
  const replay = await runSkillReplay(db, { candidateId: opts.candidateId, actorId: opts.actorId });
  if (replay.verdict !== 'pass') {
    await refuse(db, candidate.skill, opts.actorId, `promotion refused: no replay evidence (verdict ${replay.verdict})`, opts.candidateId);
    throw new Error(`promotion refused: no replay evidence (verdict ${replay.verdict}, refusal recorded)`);
  }

  // §4.12 gate 2: canary evidence — started AND completed with outcome 'ok'.
  // (Filtered on the completed marker, not sort order: same-millisecond rows
  // would otherwise tie and the active row could be read.)
  const canary = await db.collection(COLLECTIONS.skillEvolution).findOne(
    { candidate_id: opts.candidateId, kind: 'canary', 'detail.status': 'completed' },
    { projection: { _id: 0 } },
  ) as unknown as SkillEvolutionRecord | null;
  if (!canary || canary.detail?.outcome !== 'ok') {
    await refuse(db, candidate.skill, opts.actorId, `promotion refused: no completed ok-canary evidence${canary ? ` (canary outcome ${JSON.stringify(canary.detail?.outcome)})` : ''}`, opts.candidateId);
    throw new Error('promotion refused: no completed ok-canary evidence (refusal recorded)');
  }

  await db.collection(COLLECTIONS.skillRegistry).updateOne(
    { skill: candidate.skill },
    { $set: { skill: candidate.skill, current_version: candidate.version, promoted_by: opts.actorId, promoted_at: new Date().toISOString(), candidate_id: opts.candidateId } },
    { upsert: true } as any,
  );
  return record(db, {
    kind: 'promotion',
    skill: candidate.skill,
    version: candidate.version,
    actor_id: opts.actorId,
    candidate_id: opts.candidateId,
    detail: { replay: replay.detail, canary: canary.detail },
  });
}

// ── pin (explicit migration approval; trusted callers only at the tool layer) ─

export async function pinSkillVersion(
  db: Db,
  opts: { missionId: string; skill: string; version: string; actorId: string },
): Promise<SkillEvolutionRecord> {
  const mission = await db.collection(COLLECTIONS.missionStates).findOne({ mission_id: opts.missionId }, { projection: { mission_id: 1 } });
  if (!mission) throw new Error(`mission not found: ${opts.missionId}`);
  return record(db, {
    kind: 'pin',
    skill: opts.skill.trim(),
    version: opts.version.trim(),
    actor_id: opts.actorId,
    mission_id: opts.missionId,
    note: 'explicit version migration for an active mission (§4.15)',
  });
}

// ── state ─────────────────────────────────────────────────────────────────

export async function candidateState(db: Db, candidateId: string): Promise<SkillCandidateState | null> {
  const rows = (await db
    .collection(COLLECTIONS.skillEvolution)
    .find({ candidate_id: candidateId }, { projection: { _id: 0 } })
    .sort({ created_at: 1 })
    .toArray()) as unknown as SkillEvolutionRecord[];
  const candidate = rows.find(r => r.kind === 'candidate');
  if (!candidate) return null;
  const replay = rows.find(r => r.kind === 'replay');
  const canaries = rows.filter(r => r.kind === 'canary');
  const lastCanary = canaries[canaries.length - 1];
  const promotion = rows.find(r => r.kind === 'promotion');
  return {
    candidate_id: candidateId,
    skill: candidate.skill,
    version: candidate.version!,
    note: candidate.note ?? '',
    proposed_by: candidate.actor_id,
    proposed_at: candidate.created_at,
    replay_verdict: (replay?.detail?.verdict as any) ?? null,
    replay_detail: replay?.detail,
    canary_started: canaries.length > 0,
    canary_outcome: lastCanary?.detail?.status === 'completed' ? (lastCanary.detail.outcome as any) : null,
    promoted: Boolean(promotion),
    promoted_at: promotion?.created_at,
  };
}

export async function activePinForMission(db: Db, missionId: string, skill: string): Promise<SkillEvolutionRecord | null> {
  return db.collection(COLLECTIONS.skillEvolution).findOne(
    { mission_id: missionId, skill, kind: 'pin' },
    { projection: { _id: 0 }, sort: { created_at: -1 } },
  ) as unknown as SkillEvolutionRecord | null;
}
