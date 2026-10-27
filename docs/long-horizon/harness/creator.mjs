// Iteration 1 decisive-test harness — PHASE A: creator.
// A fresh node process that builds mission state in REAL Katra Mongo via the
// cognitive-control services, then exits. It prints ONLY the mission_id.
// Harness defect fixes (Lilly review 2026-09-19):
//   #3 env-configurable build dir (KATRA_BUILD_DIR; default /repos/katra-server/build)
//   #4 non-destructive .env load (never overwrite already-set vars)
//   #1 no forced REDIS_URL (container env carries the right one)
//   #2 explicit process.exit(0) after close
import { readFileSync, existsSync } from 'node:fs';

const BUILD = process.env.KATRA_BUILD_DIR || '/repos/katra-server/build';
const conn = await import(`${BUILD}/database/connection.js`);
const { MissionStateService } = await import(`${BUILD}/services/mission-cognition/mission-state-service.js`);
const { StateDeltaService } = await import(`${BUILD}/services/mission-cognition/state-delta-service.js`);

// Non-destructive env load: only set vars that are not already present.
const envPath = process.env.KATRA_ENV_FILE || ((process.env.HOME ?? '') + '/Katra-Agentic-Memory/.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = t.slice(eq + 1).trim();
  }
}

await conn.connect_to_mongodb();
const db = conn.get_database();
const missions = new MissionStateService(db);
const deltas = new StateDeltaService(db);

const stamp = Date.now();
const missionId = `iter1_${stamp}_${Math.random().toString(36).slice(2, 8)}`;

const state = await missions.createMissionState({
  schema_version: '1.0',
  mission_id: missionId,
  title: 'Iteration-1 decisive context-clear test',
  intent: 'Prove a mission survives a total context clear without transcript replay.',
  status: 'active',
  owner_id: 'satori',
  success_criteria: [{ id: 'c1', description: 'resume reconstructs state from stores only', status: 'unmet' }],
  authority_class: 'B',
  objectives: [
    { id: 'o1', description: 'Establish baseline facts about egress throttling', status: 'in_progress', owner_id: 'satori', dependency_ids: [] },
    { id: 'o2', description: 'Design the fix for the throttled path', status: 'pending', owner_id: 'satori', dependency_ids: ['o1'] },
  ],
});

// delta 1: a claim (v1 -> v2)
const d1 = await deltas.submitDelta({
  schema_version: '1.0',
  idempotency_key: `iter1-claim-${missionId}`,
  mission_id: missionId,
  base_mission_version: 1,
  author_id: 'satori',
  delta_type: 'CLAIM_ADDED',
  operations: [{ op: 'add', path: '/ledger_refs/-', value: 'claim-baseline' }],
  ledger_entries: [{
    schema_version: '1.0', mission_id: missionId, entry_type: 'claim',
    statement: 'YouTube caption endpoints are IP-throttled from Montenegro and GCP egress; audio download is not.',
    status: 'accepted', author_id: 'satori', confidence: 0.9,
  }],
  rationale: 'baseline observation',
  confidence: 0.9,
}, { actorId: 'satori' });

// delta 2: open an uncertainty (v2 -> v3)
const d2 = await deltas.submitDelta({
  schema_version: '1.0',
  idempotency_key: `iter1-uncertainty-${missionId}`,
  mission_id: missionId,
  base_mission_version: 2,
  author_id: 'satori',
  delta_type: 'UNCERTAINTY_OPENED',
  operations: [{ op: 'add', path: '/ledger_refs/-', value: 'uncertainty-egress' }],
  ledger_entries: [{
    schema_version: '1.0', mission_id: missionId, entry_type: 'uncertainty',
    statement: 'Whether the throttling is per-IP or per-region (affects fix design).',
    status: 'active', author_id: 'satori', confidence: 0.5,
    information_needed: ['a second egress IP to compare against'],
  }],
  rationale: 'fix design depends on unknown scope of throttling',
  confidence: 0.5,
}, { actorId: 'satori' });

// checkpoint at v3
await missions.checkpointMission(missionId, 'satori');

// delta 3 AFTER the checkpoint (v3 -> v4): new evidence lands while context is "lost"
const d3 = await deltas.submitDelta({
  schema_version: '1.0',
  idempotency_key: `iter1-evidence-${missionId}`,
  mission_id: missionId,
  base_mission_version: 3,
  author_id: 'satori',
  delta_type: 'EVIDENCE_ADDED',
  operations: [{ op: 'add', path: '/ledger_refs/-', value: 'evidence-egress' }],
  ledger_entries: [{
    schema_version: '1.0', mission_id: missionId, entry_type: 'evidence',
    statement: 'A second egress IP reproduces the 429 — throttling is per-IP, not per-region.',
    status: 'accepted', author_id: 'satori', confidence: 0.85,
  }],
  rationale: 'discriminating evidence for the open uncertainty',
  confidence: 0.85,
}, { actorId: 'satori' });

console.log(`CREATOR_OK mission_id=${missionId} deltas=${[d1.status, d2.status, d3.status].join(',')}`);
await conn.close_connection();
process.exit(0); // defect #2: never leave the process sitting in ep_poll
