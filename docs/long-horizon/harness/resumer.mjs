// Iteration 1 decisive-test harness — PHASE B: resumer.
// A GENUINELY FRESH process: its ONLY input is the mission_id argv.
// No creator transcript, no shared file, no conversation history — everything
// below comes from Mission State + checkpoint + accepted deltas + ledger.
// Harness defect fixes (Lilly review 2026-09-19): env-configurable build dir,
// non-destructive env load, no forced REDIS_URL, explicit process.exit.
import { readFileSync, existsSync } from 'node:fs';

const missionId = process.argv[2];
if (!missionId) { console.error('usage: node resumer.mjs <mission_id>'); process.exit(2); }

const BUILD = process.env.KATRA_BUILD_DIR || '/repos/katra-server/build';
const conn = await import(`${BUILD}/database/connection.js`);
const { buildResumeReport } = await import(`${BUILD}/services/mission-cognition/resume.js`);
const { MissionStateService } = await import(`${BUILD}/services/mission-cognition/mission-state-service.js`);

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

const report = await buildResumeReport(db, missionId);
console.log('RESUMER_REPORT ' + JSON.stringify(report, null, 2));

// determinism check: current state must equal checkpoint + replay of accepted deltas
const missions = new MissionStateService(db);
const current = await missions.getMissionState(missionId);
const rebuilt = await missions.rebuildFromCheckpoint(missionId);
const currentJson = JSON.stringify(current);
const rebuiltJson = JSON.stringify(rebuilt);
console.log(`DETERMINISM ${currentJson === rebuiltJson ? 'PASS' : 'FAIL'}`);
if (currentJson !== rebuiltJson) {
  console.log('DETERMINISM_MISMATCH current=' + currentJson.slice(0, 400));
  console.log('DETERMINISM_MISMATCH rebuilt=' + rebuiltJson.slice(0, 400));
}
console.log('RESUMER_INPUTS mission_id_only=' + (process.argv.length === 3 ? 'true' : 'false'));
await conn.close_connection();
process.exit(0); // defect #2: never leave the process sitting in ep_poll
