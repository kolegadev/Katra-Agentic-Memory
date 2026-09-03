/**
 * Skill Refinement Service
 *
 * Singleton that manages the two-way feedback loop for Katra skills:
 * confidence tracking, auto-challenging, LLM-driven refinement,
 * and feedback history persistence via MongoDB.
 */

import { get_database } from '../../database/connection.js';
import { SkillLoaderService } from '../memory/skill-loader-service.js';
import { llmService } from '../infrastructure/llm-service.js';
import { assertVaultCollectionAllowed } from '../vault/denylist.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillFeedbackRecord, KatraSkill } from '../../types/memory.js';

export class SkillRefinementService {
  private static instance: SkillRefinementService | null = null;

  private constructor() {}

  static get_instance(): SkillRefinementService {
    if (!SkillRefinementService.instance) {
      SkillRefinementService.instance = new SkillRefinementService();
    }
    return SkillRefinementService.instance;
  }

  /**
   * Check whether a skill's confidence has dropped below the degradation threshold.
   * If so, mark it as 'challenged' in the SKILL.md frontmatter on disk.
   */
  async checkConfidence(skillName: string): Promise<{ challenged: boolean; reason?: string }> {
    const loader = SkillLoaderService.get_instance();
    const result = loader.load(skillName);

    if (!result) {
      return { challenged: false };
    }

    const skill = result.metadata;
    const conf = skill.confidence;
    const obs = skill.observation_count;

    if (conf >= 0.4 || obs < 5) {
      return { challenged: false };
    }

    // Update status to 'challenged' on disk
    loader.updateSkillFrontmatter(skillName, { status: 'challenged' });

    const reason = `Confidence dropped to ${(conf * 100).toFixed(0)}% after ${obs} uses`;
    console.log(`[SkillRefinement] ⚠️ ${skillName}: ${reason}`);

    return { challenged: true, reason };
  }

  /**
   * Refine a challenged or degraded skill using LLM analysis of its feedback history.
   * Generates an improved SKILL.md, backs up the old one, and resets the skill to candidate.
   */
  async refineSkill(skillName: string): Promise<{ success: boolean; newPath?: string; changes?: string; error?: string }> {
    const loader = SkillLoaderService.get_instance();
    const result = loader.load(skillName);
    if (!result) {
      return { success: false, error: `Skill "${skillName}" not found.` };
    }

    const skill = result.metadata;
    const filePath = loader.getSkillFilePath(skillName);
    if (!filePath) {
      return { success: false, error: `No file path found for skill "${skillName}".` };
    }

    try {
      // 1. Query MongoDB for all feedback records for this skill
      const feedback = await this.getFeedbackHistory(skillName, 100, 0);

      // 2. Build LLM refinement prompt
      const prompt = this.buildRefinementPrompt(skill, feedback);

      // 3. Call LLM to generate improved SKILL.md
      const improvedContent = await llmService.generateResponse(prompt);

      // 4. Validate response has frontmatter
      if (!improvedContent.includes('---') || !improvedContent.includes('name:')) {
        throw new Error('LLM response missing required frontmatter — refine aborted');
      }

      // 5. Backup old file: rename SKILL.md → SKILL.md.bak
      const backupPath = filePath + '.bak';
      fs.copyFileSync(filePath, backupPath);

      // 6. Write new SKILL.md
      fs.writeFileSync(filePath, improvedContent, 'utf-8');

      // 7. Refresh the loader
      loader.refresh();

      console.log(`[SkillRefinement] ✅ Refined skill: ${skillName} → ${filePath}`);
      console.log(`[SkillRefinement] 📋 Backup: ${backupPath}`);

      return {
        success: true,
        newPath: filePath,
        changes: `Skill refined using LLM analysis of ${feedback.length} feedback records. Original backed up to ${path.basename(backupPath)}.`,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Query MongoDB for feedback records for a specific skill.
   * Returns records sorted by timestamp descending with pagination support.
   */
  async getFeedbackHistory(skillName: string, limit: number = 20, offset: number = 0): Promise<SkillFeedbackRecord[]> {
    // Guard: feedback documents below are built into the LLM refinement
    // prompt (refineSkill → generateResponse). Guard sits outside the
    // catch-all so denylist blocks propagate.
    assertVaultCollectionAllowed('skill_feedback', 'skill-refinement-service:getFeedbackHistory');
    try {
      const db = get_database();
      if (!db) return [];

      const collection = db.collection('skill_feedback');
      const docs = await collection
        .find({ skill_name: skillName })
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .toArray();

      return docs.map(doc => ({
        skill_name: doc.skill_name,
        session_id: doc.session_id,
        outcome: doc.outcome,
        notes: doc.notes || undefined,
        task_description: doc.task_description || undefined,
        confidence_before: doc.confidence_before,
        confidence_after: doc.confidence_after,
        timestamp: doc.timestamp instanceof Date ? doc.timestamp : new Date(doc.timestamp),
      }));
    } catch (error) {
      console.warn(`[SkillRefinement] Failed to query feedback history: ${error}`);
      return [];
    }
  }

  /**
   * Build an LLM prompt for skill refinement that summarizes failure patterns
   * and recent successes so the LLM can produce an improved SKILL.md.
   */
  private buildRefinementPrompt(skill: KatraSkill, feedback: SkillFeedbackRecord[]): string {
    const failures = feedback.filter(f => f.outcome === 'failure');
    const successes = feedback.filter(f => f.outcome === 'success');

    return `You are a skill refinement engine. A Katra skill has degraded in confidence and needs improvement.

CURRENT SKILL:
${skill.title} (${skill.name})
Category: ${skill.category}
Confidence: ${(skill.confidence * 100).toFixed(0)}%
Uses: ${skill.observation_count} | Successes: ${skill.success_count} | Failures: ${skill.failure_count}

FAILURE PATTERNS (last ${Math.min(failures.length, 5)}):
${failures.slice(0, 5).map(f => `- ${f.outcome}: ${f.notes || 'no notes'} (session: ${f.session_id})`).join('\n')}

RECENT SUCCESSES (last ${Math.min(successes.length, 3)}):
${successes.slice(0, 3).map(f => `- ${f.notes || 'no notes'}`).join('\n')}

TASK: Generate an improved version of this skill's SKILL.md file. 
- Keep the same name and category
- Update the description based on what worked and what didn't
- Update the workflow process to incorporate lessons learned from failures
- Add critical rules that would have prevented the observed failures
- Keep the YAML frontmatter format
- Set status: candidate, confidence: 0.5 (reset after refinement)
- Source: auto-refined

Return ONLY the complete SKILL.md content. No explanations.`;
  }
}
