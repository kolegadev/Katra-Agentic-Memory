/**
 * Skill Synthesis Service
 *
 * Singleton that uses the LLM to convert observed procedural patterns
 * (CandidateSkillSpec) into full SKILL.md files following the Agent
 * Skills specification. Also handles manual skill requests from users.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { llmService } from '../infrastructure/llm-service.js';
import { SkillLoaderService } from '../memory/skill-loader-service.js';
import type { CandidateSkillSpec, SkillCategory } from '../../types/memory.js';

export class SkillSynthesisService {
  private static instance: SkillSynthesisService | null = null;

  private constructor() {}

  static get_instance(): SkillSynthesisService {
    if (!SkillSynthesisService.instance) {
      SkillSynthesisService.instance = new SkillSynthesisService();
    }
    return SkillSynthesisService.instance;
  }

  /**
   * Synthesize a SKILL.md from an auto-distilled CandidateSkillSpec.
   */
  async synthesizeSkill(spec: CandidateSkillSpec): Promise<{
    success: boolean;
    skillPath?: string;
    error?: string;
  }> {
    const totalObs = spec.success_count + spec.failure_count;
    const successRate = totalObs > 0 ? spec.success_count / totalObs : 0.5;
    const confidence = Math.min(0.95, Math.max(0.1, successRate));

    const prompt = `You are a skill synthesis engine. Convert the following observed procedural pattern into a SKILL.md file following the Agent Skills specification.

OBSERVED PATTERN:
- Tool sequence: ${spec.observed_sequence.join(' → ')}
- Observed ${spec.observation_count} times across sessions
- Success rate: ${(successRate * 100).toFixed(0)}%
- Category: ${spec.category}
- Sessions where observed: ${spec.source_session_ids.slice(0, 5).join(', ')}

Generate a complete SKILL.md file with YAML frontmatter and Markdown body. Follow this exact format:

---
name: ${spec.name}
title: ${spec.title}
category: ${spec.category}
description: One-sentence description of what this skill does and when to use it.
status: candidate
observation_count: ${spec.observation_count}
success_count: ${spec.success_count}
failure_count: ${spec.failure_count}
confidence: ${confidence.toFixed(2)}
triggers:
${spec.trigger_conditions.map(t => `  - ${t}`).join('\n')}
created_at: ${new Date().toISOString()}
source: auto-distilled
---

# ${spec.title}

${spec.description}

## Identity & Role
You are a specialist who executes the ${spec.title} procedure. You perform this reliably based on ${spec.observation_count} observed executions.

## Core Mission
- Execute the procedural sequence: ${spec.observed_sequence.join(' → ')}
- Complete each phase before advancing to the next
- Report results at each step

## When to Use This Skill
${spec.trigger_conditions.map(t => `- When the task involves "${t}"`).join('\n')}
- When the observed pattern ${spec.observed_sequence.join(' → ')} matches the current task

## Workflow Process
${spec.observed_sequence.map((t, i) => `**Phase ${i + 1} — ${t.replace(/^mcp_tool_|^tool_/g, '')}:** Execute the ${t} operation as observed in ${spec.observation_count} prior sessions.`).join('\n\n')}

## Critical Rules
- Follow the sequence in order — do not skip phases
- Verify each phase succeeded before moving to the next
- Report failures immediately
- This skill has a ${(successRate * 100).toFixed(0)}% observed success rate — if it fails, report it for refinement

Return ONLY the valid SKILL.md content. No explanations, no markdown outside the file.`;

    try {
      const response = await llmService.generateResponse(prompt);

      // Parse the response to extract SKILL.md content
      const skillContent = this.extractSkillContent(response);

      // Validate the content has required fields
      if (!skillContent.includes('name:') || !skillContent.includes('title:')) {
        throw new Error('LLM response missing required frontmatter fields');
      }

      // Write to disk
      const skillDir = this.ensureSkillDir(spec.name, spec.category);
      const skillPath = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(skillPath, skillContent, 'utf-8');

      // Refresh the skill loader
      try {
        SkillLoaderService.get_instance().refresh();
      } catch {
        // Non-critical
      }

      console.log(`[SkillSynthesis] Synthesized skill: ${spec.name} → ${skillPath}`);
      return { success: true, skillPath };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Synthesize a SKILL.md from a manual user description.
   */
  async synthesizeFromDescription(
    description: string,
    category: SkillCategory,
  ): Promise<{ success: boolean; skillPath?: string; error?: string }> {
    // Generate kebab-case name from description
    const name = description
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);

    // Derive title from description
    const title = description
      .replace(/\b\w/g, c => c.toUpperCase())
      .slice(0, 80);

    const prompt = `You are a skill synthesis engine. Generate a complete SKILL.md file for the following requested skill.

REQUEST:
"${description}"

Category: ${category}

Generate a complete SKILL.md file with YAML frontmatter and Markdown body. Follow this exact format:

---
name: ${name}
title: ${title}
category: ${category}
description: One-sentence description of what this skill does and when to use it.
status: candidate
observation_count: 1
success_count: 1
failure_count: 0
confidence: 0.7
triggers:
  - keyword-from-description-1
  - keyword-from-description-2
created_at: ${new Date().toISOString()}
source: manual-request
---

# ${title}

Description paragraph that explains what this skill does.

## Identity & Role
You are a specialist who...

## Core Mission
...

## When to Use This Skill
...

## Workflow Process
**Phase 1 — ...**
**Phase 2 — ...**
...

## Critical Rules
...

Return ONLY the valid SKILL.md content. No explanations, no markdown outside the file.`;

    try {
      const response = await llmService.generateResponse(prompt);

      // Parse the response
      let skillContent = this.extractSkillContent(response);

      // Ensure the name is correct (the LLM might have changed it)
      skillContent = skillContent.replace(/^name:\s*.*$/m, `name: ${name}`);

      // Validate
      if (!skillContent.includes('name:') || !skillContent.includes('title:')) {
        throw new Error('LLM response missing required frontmatter fields');
      }

      // Write to disk
      const skillDir = this.ensureSkillDir(name, category);
      const skillPath = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(skillPath, skillContent, 'utf-8');

      // Refresh the skill loader
      try {
        SkillLoaderService.get_instance().refresh();
      } catch {
        // Non-critical
      }

      console.log(`[SkillSynthesis] Synthesized from description: ${name} → ${skillPath}`);
      return { success: true, skillPath };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Extract clean SKILL.md content from an LLM response that may contain
   * explanatory text or markdown fences.
   */
  private extractSkillContent(response: string): string {
    let content = response.trim();

    // Remove markdown code fences if present
    const fenceMatch = content.match(/```(?:markdown|md|yaml)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      content = fenceMatch[1].trim();
    }

    // Ensure it starts with ---
    if (!content.startsWith('---')) {
      // Try to find the first ---
      const frontmatterStart = content.indexOf('---');
      if (frontmatterStart > 0) {
        content = content.slice(frontmatterStart);
      }
    }

    return content;
  }

  /**
   * Get the filesystem path for a skill directory, creating it if needed.
   * Uses the same candidate resolution as SkillLoaderService.
   */
  private ensureSkillDir(name: string, category: string): string {
    const skillsDir = this.resolveSkillsDir();
    const skillDir = path.join(skillsDir, category, name);
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }
    return skillDir;
  }

  /**
   * Resolve the skills directory using the same logic as SkillLoaderService.
   */
  private resolveSkillsDir(): string {
    if (process.env.KATRA_SKILLS_DIR) {
      return process.env.KATRA_SKILLS_DIR;
    }
    const candidates = [
      path.join(process.cwd(), 'server/src/skills'),
      path.join(process.cwd(), 'src/skills'),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    return found || candidates[0];
  }
}
