/**
 * Phase 2 Smoke Test (No-MongoDB mode)
 * Tests OperationalDistillationService and SkillSynthesisService
 * File-system and in-memory operations verified.
 */
import 'dotenv/config';
import { OperationalDistillationService } from './build/services/processing/operational-distillation-service.js';
import { SkillSynthesisService } from './build/services/processing/skill-synthesis-service.js';
import { SkillLoaderService } from './build/services/memory/skill-loader-service.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function main() {
  console.log('=== Phase 2 Smoke Test (No-MongoDB) ===\n');

  // ── 1. OperationalDistillationService singleton ─────────────
  console.log('1. OperationalDistillationService singleton:');
  const ods1 = OperationalDistillationService.get_instance();
  const ods2 = OperationalDistillationService.get_instance();
  check('get_instance returns same object', ods1 === ods2);

  // ── 2. getCandidates initial state ─────────────────────────
  console.log('\n2. getCandidates initial state:');
  const candidatesBefore = ods1.getCandidates();
  check('getCandidates() returns empty array initially', Array.isArray(candidatesBefore) && candidatesBefore.length === 0);

  // ── 3. promoteCandidate on non-existent ────────────────────
  console.log('\n3. promoteCandidate on non-existent:');
  const promoted = ods1.promoteCandidate('non-existent-skill');
  check('promoteCandidate returns false for non-existent', promoted === false);

  // ── 4. SkillSynthesisService singleton ─────────────────────
  console.log('\n4. SkillSynthesisService singleton:');
  const sss1 = SkillSynthesisService.get_instance();
  const sss2 = SkillSynthesisService.get_instance();
  check('get_instance returns same object', sss1 === sss2);

  // ── 5. Skills directory exists ─────────────────────────────
  console.log('\n5. Skills directory:');
  const skillsDir = process.env.KATRA_SKILLS_DIR || path.join(process.cwd(), 'src/skills');
  console.log(`   Path: ${skillsDir}`);
  check('skills directory exists', fs.existsSync(skillsDir));

  // ── 6. Subdirectories exist ────────────────────────────────
  console.log('\n6. Skill category directories:');
  for (const cat of ['operational', 'decision', 'troubleshooting']) {
    const catDir = path.join(skillsDir, cat);
    check(`  ${cat} directory exists`, fs.existsSync(catDir));
  }

  // ── 7. Test SKILL.md file creation (without LLM) ───────────
  console.log('\n7. Manual SKILL.md file creation test:');
  const testCategory = 'operational';
  const testName = 'test-phase2-smoke';
  const testDir = path.join(skillsDir, testCategory, testName);
  
  // Clean up from previous runs
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }

  // Create directory and write a minimal SKILL.md
  fs.mkdirSync(testDir, { recursive: true });
  const testSkillContent = `---
name: test-phase2-smoke
title: Phase 2 Smoke Test Skill
category: operational
description: A test skill created during the Phase 2 smoke test. Verifies that the skill synthesis pipeline correctly writes files to the proper directory structure.
status: candidate
observation_count: 1
success_count: 1
failure_count: 0
confidence: 0.7
triggers:
  - test
  - smoke
  - phase2
created_at: ${new Date().toISOString()}
source: auto-distilled
---

# Phase 2 Smoke Test Skill

This is a test skill to verify the Phase 2 operational distillation pipeline.

## Identity & Role
You are a test verification specialist.

## Core Mission
Verify that the skill synthesis pipeline works correctly.

## When to Use This Skill
- When running smoke tests
- When verifying Phase 2

## Workflow Process
**Phase 1 — Setup:** Create test directories
**Phase 2 — Verify:** Check file contents
**Phase 3 — Cleanup:** Remove test artifacts

## Critical Rules
- Always verify before asserting
- Report results clearly
`;

  const skillFilePath = path.join(testDir, 'SKILL.md');
  fs.writeFileSync(skillFilePath, testSkillContent, 'utf-8');
  check('SKILL.md file written', fs.existsSync(skillFilePath));
  check('Content starts with ---', testSkillContent.startsWith('---'));
  check('Contains name field', testSkillContent.includes('name: test-phase2-smoke'));
  check('Contains title field', testSkillContent.includes('title: Phase 2 Smoke Test Skill'));

  // ── 8. SkillLoaderService refresh picks up new skill ───────
  console.log('\n8. SkillLoaderService refresh:');
  const sls = SkillLoaderService.get_instance();
  
  // Check if skill already existed before refresh
  const beforeLoad = sls.load(testName);
  console.log(`   Before refresh: ${beforeLoad ? 'found' : 'not found'}`);
  
  sls.refresh();
  const afterLoad = sls.load(testName);
  check('SkillLoaderService.load finds test skill', afterLoad !== null);
  
  if (afterLoad) {
    const { metadata, content } = afterLoad;
    check('  name matches', metadata.name === testName);
    check('  category is operational', metadata.category === 'operational');
    check('  status is candidate', metadata.status === 'candidate');
    check('  confidence ~0.7', Math.abs(metadata.confidence - 0.7) < 0.01);
    check('  has 3 triggers', metadata.triggers.length === 3);
    check('  source is auto-distilled', metadata.source === 'auto-distilled');
    check('  content has body text', content.length > 50);
    check('  content includes Identity & Role', content.includes('Identity & Role'));
  }

  // ── 9. Search picks up test skill ──────────────────────────
  console.log('\n9. TF-IDF search:');
  const searchResults = sls.search('test verification specialist', 5);
  check('search finds results', searchResults.length > 0);

  const foundTestSkill = searchResults.find(r => r.name === testName);
  check('  search finds test skill by description', foundTestSkill !== undefined);
  if (foundTestSkill) {
    check('  search score > 0', foundTestSkill.score > 0);
    console.log(`   Score: ${foundTestSkill.score.toFixed(3)}`);
  }

  // ── 10. List filters by category ───────────────────────────
  console.log('\n10. List by category:');
  const operationalSkills = sls.list('operational');
  check('list("operational") returns skills', operationalSkills.length > 0);
  const foundOp = operationalSkills.find(s => s.name === testName);
  check('  test skill is in operational list', foundOp !== undefined);

  const decisionSkills = sls.list('decision');
  const foundDec = decisionSkills.find(s => s.name === testName);
  check('  test skill is NOT in decision list', foundDec === undefined);

  // ── 11. getActivationContext ───────────────────────────────
  console.log('\n11. getActivationContext:');
  const ctx = sls.getActivationContext('verify phase two smoke test pipeline', 5);
  check('returns SkillActivationContext', ctx !== null && typeof ctx === 'object');
  check('  has task_description', typeof ctx.task_description === 'string');
  check('  has skills array', Array.isArray(ctx.skills));
  check('  has activation_paths', typeof ctx.activation_paths === 'object');
  check('  context_pre_seed is array', Array.isArray(ctx.activation_paths.context_pre_seed));
  console.log(`   Found ${ctx.skills.length} relevant skills`);

  // ── 12. recordFeedback ─────────────────────────────────────
  console.log('\n12. recordFeedback:');
  const skillBeforeFeedback = sls.load(testName);
  const obsBefore = skillBeforeFeedback?.metadata.observation_count || 0;
  
  sls.recordFeedback(testName, 'test-session-1', 'success', 'Test feedback');
  
  const skillAfterFeedback = sls.load(testName);
  check('  observation_count incremented', (skillAfterFeedback?.metadata.observation_count || 0) > obsBefore);
  check('  success_count incremented', (skillAfterFeedback?.metadata.success_count || 0) > 0);
  // Confidence recalculated: 2 successes / 2 total = 1.0 (was 0.7)
  check('  confidence updated (now 1.0)', Math.abs((skillAfterFeedback?.metadata.confidence || 0) - 1.0) < 0.01);

  // ── 13. Cleanup ────────────────────────────────────────────
  console.log('\n13. Cleanup:');
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
    check('test skill directory cleaned up', !fs.existsSync(testDir));
  }
  sls.refresh();
  const afterCleanup = sls.load(testName);
  check('skill no longer loaded after cleanup + refresh', afterCleanup === null);

  // ── Summary ────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
