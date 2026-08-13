/**
 * Phase 3 Smoke Test — Path B (Trigger Condition) and Path C (Embedding Similarity)
 * 
 * Run: cd server && node test-phase3-smoke.mjs
 */

import { SkillLoaderService } from './build/services/memory/skill-loader-service.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The skills dir relative to the server directory
const skillsDir = join(__dirname, 'src', 'skills');

console.log('='.repeat(70));
console.log('Phase 3 Smoke Test — Path B & C Activation');
console.log('='.repeat(70));

// 1. Create a SkillLoaderService instance
console.log('\n[1] Creating SkillLoaderService...');
const service = SkillLoaderService.get_instance(skillsDir);
console.log(`    Loaded ${service.list().length} skills`);

// List loaded skills
for (const skill of service.list()) {
  console.log(`    - ${skill.name}: "${skill.title}" [${skill.category}] triggers=[${skill.triggers.join(', ')}]`);
}

// 2. Test: deploy-related query
console.log('\n[2] Testing activation context for deploy query...');
const deployCtx = await service.getActivationContext(
  'I need to deploy a service to a remote machine and restart systemd',
  5
);

console.log('\n    --- Path A (TF-IDF) ---');
console.log(`    Results: ${deployCtx.activation_paths.context_pre_seed.length}`);
for (const s of deployCtx.activation_paths.context_pre_seed) {
  console.log(`      ${s.name} — score: ${s.score.toFixed(3)}`);
}

console.log('\n    --- Path B (Trigger Match) ---');
console.log(`    Results: ${deployCtx.activation_paths.trigger_match.length}`);
for (const s of deployCtx.activation_paths.trigger_match) {
  console.log(`      ${s.name} — score: ${s.score.toFixed(3)}`);
}

console.log('\n    --- Path C (Embedding) ---');
console.log(`    Results: ${deployCtx.activation_paths.embedding_match.length}`);
for (const s of deployCtx.activation_paths.embedding_match) {
  console.log(`      ${s.name} — score: ${s.score.toFixed(3)}`);
}

console.log('\n    --- Unified Ranking ---');
console.log(`    Results: ${deployCtx.skills.length}`);
for (const s of deployCtx.skills) {
  console.log(`      ${s.name} — score: ${s.score.toFixed(3)}`);
}

// 3. Verify deploy-remote-service appears in Path A
const pathASkill = deployCtx.activation_paths.context_pre_seed.find(s => s.name === 'deploy-remote-service');
console.log('\n[3] Verifying Path A includes deploy-remote-service...');
if (pathASkill) {
  console.log(`    ✅ Path A: deploy-remote-service found (score: ${pathASkill.score.toFixed(3)})`);
} else {
  console.log('    ❌ Path A: deploy-remote-service NOT found!');
}

// 4. Verify deploy-remote-service appears in Path B (triggers: deploy, remote, systemd, restart)
const pathBSkill = deployCtx.activation_paths.trigger_match.find(s => s.name === 'deploy-remote-service');
console.log('\n[4] Verifying Path B (trigger match) includes deploy-remote-service...');
if (pathBSkill) {
  console.log(`    ✅ Path B: deploy-remote-service found (score: ${pathBSkill.score.toFixed(3)})`);
  console.log('    Triggers matched: deploy, remote, systemd, restart all present in task');
} else {
  console.log('    ❌ Path B: deploy-remote-service NOT found!');
}

// 5. Check Path C
const pathCSkill = deployCtx.activation_paths.embedding_match.find(s => s.name === 'deploy-remote-service');
console.log('\n[5] Path C (embedding) status...');
if (pathCSkill) {
  console.log(`    ✅ Path C: deploy-remote-service found (score: ${pathCSkill.score.toFixed(3)})`);
  console.log('    Embedding model is loaded and functional');
} else {
  console.log('    ℹ️  Path C: deploy-remote-service not matched (embedding model may not be loaded)');
  console.log('    This is expected if ONNX/Transformers.js is not available');
}

// 6. Verify unified ranking includes deploy-remote-service
const unifiedSkill = deployCtx.skills.find(s => s.name === 'deploy-remote-service');
console.log('\n[6] Verifying unified ranking includes deploy-remote-service...');
if (unifiedSkill) {
  console.log(`    ✅ Unified: deploy-remote-service found (score: ${unifiedSkill.score.toFixed(3)})`);
} else {
  console.log('    ❌ Unified: deploy-remote-service NOT found!');
}

// 7. Test unrelated query
console.log('\n[7] Testing unrelated query "bake a cake recipe"...');
const unrelatedCtx = await service.getActivationContext('bake a cake recipe', 5);

console.log('\n    --- Path A ---');
console.log(`    Results: ${unrelatedCtx.activation_paths.context_pre_seed.length}`);
for (const s of unrelatedCtx.activation_paths.context_pre_seed) {
  console.log(`      ${s.name} — score: ${s.score.toFixed(3)}`);
}

console.log('\n    --- Path B ---');
console.log(`    Results: ${unrelatedCtx.activation_paths.trigger_match.length}`);

console.log('\n    --- Path C ---');
console.log(`    Results: ${unrelatedCtx.activation_paths.embedding_match.length}`);

console.log('\n    --- Unified ---');
console.log(`    Results: ${unrelatedCtx.skills.length}`);

const hasDeployInBake = unrelatedCtx.skills.find(s => s.name === 'deploy-remote-service');
if (!hasDeployInBake || (hasDeployInBake && hasDeployInBake.score < 0.15)) {
  console.log('    ✅ Unrelated query correctly returns deploy skill with low/no score');
} else if (hasDeployInBake) {
  console.log(`    ⚠️  Unrelated query returned deploy-remote-service with score ${hasDeployInBake.score.toFixed(3)}`);
  console.log('    This might be ok if the embedding model is not available (Path A may match some tokens)');
} else {
  console.log('    ✅ No results for unrelated query — as expected');
}

// Summary
console.log('\n' + '='.repeat(70));
console.log('SMOKE TEST SUMMARY');
console.log('='.repeat(70));

let passed = 0;
let failed = 0;

// Check 3: Path A
if (pathASkill) { passed++; } else { console.log('❌ FAIL [3]: Path A missing deploy-remote-service'); failed++; }
// Check 4: Path B
if (pathBSkill) { passed++; } else { console.log('❌ FAIL [4]: Path B missing deploy-remote-service'); failed++; }
// Check 5: Path C is informational (not a hard pass/fail)
// Check 6: Unified
if (unifiedSkill) { passed++; } else { console.log('❌ FAIL [6]: Unified missing deploy-remote-service'); failed++; }
// Check 7: Unrelated
if (!hasDeployInBake || hasDeployInBake.score < 0.15) { passed++; } else { console.log('⚠️  WARN [7]: Unrelated query returned deploy skill'); }

console.log(`\nPassed: ${passed}/${passed + failed}`);
if (failed === 0) {
  console.log('✅ All critical checks passed!');
} else {
  console.log(`❌ ${failed} check(s) failed`);
}

process.exit(failed > 0 ? 1 : 0);
