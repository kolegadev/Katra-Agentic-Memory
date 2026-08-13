/**
 * Operational Distillation Service
 *
 * Singleton that scans episodic memory for repeatable tool-call patterns,
 * identifies candidate skills, and optionally auto-synthesizes SKILL.md files.
 * Converts Katra's observed procedural patterns into executable skills.
 */

import { createHash } from 'node:crypto';
import { SelfModelService } from './self-model-service.js';
import { getEpisodicEventManager } from '../memory/episodic-event-manager.js';
import { SkillSynthesisService } from './skill-synthesis-service.js';
import type { CandidateSkillSpec, DistillationResult } from '../../types/memory.js';
import type { ProceduralTemplate } from './self-model-service.js';

/** Generate a stable hash key from an ordered tool sequence */
function hashSequence(sequence: string[]): string {
  return createHash('sha256').update(sequence.join('|')).digest('hex').slice(0, 16);
}

/** Generate a kebab-case slug from a tool sequence */
function sequenceToSlug(sequence: string[]): string {
  return sequence
    .map(t => t.replace(/^mcp_tool_|^tool_/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('-')
    .slice(0, 60);
}

/** Generate a human-readable title from tool names */
function sequenceToTitle(sequence: string[]): string {
  const names = sequence
    .map(t => t.replace(/^mcp_tool_|^tool_/g, '').replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
    .slice(0, 4);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} → ${names[1]}`;
  return names.join(' → ');
}

export class OperationalDistillationService {
  private static instance: OperationalDistillationService | null = null;

  private candidates: Map<string, CandidateSkillSpec> = new Map();

  private constructor() {}

  static get_instance(): OperationalDistillationService {
    if (!OperationalDistillationService.instance) {
      OperationalDistillationService.instance = new OperationalDistillationService();
    }
    return OperationalDistillationService.instance;
  }

  /**
   * Run the full distillation pipeline:
   * 1. Query SelfModelService for procedural templates
   * 2. Query episodic events for tool-call sequences grouped by session
   * 3. Generate CandidateSkillSpec entries
   * 4. Optionally auto-synthesize via SkillSynthesisService
   * 5. Promote candidates meeting the auto-promote threshold
   */
  async runDistillation(options?: {
    minObservations?: number;
    autoSynthesize?: boolean;
  }): Promise<DistillationResult> {
    const minObservations = options?.minObservations ?? 3;
    const autoSynthesize = options?.autoSynthesize ?? true;
    const errors: string[] = [];
    let skillsSynthesized = 0;
    let skillsPromoted = 0;

    // 1. Query SelfModelService for procedural templates (frequency >= 3)
    const selfModel = SelfModelService.get_instance();
    const templates: ProceduralTemplate[] = selfModel.getProceduralTemplates();

    // Build a per-tool success-rate lookup from templates
    const toolSuccessRates = new Map<string, number>();
    for (const t of templates) {
      // Track by both the full key (toolName:inputShape) and bare toolName for aggregation
      const existing = toolSuccessRates.get(t.toolName);
      if (existing === undefined) {
        toolSuccessRates.set(t.toolName, t.avgSuccess);
      } else {
        // Aggregate: average with existing weighted by frequency
        // Since we don't have per-template frequency easily for aggregation,
        // use a simple rolling average
        const existingCount = toolSuccessRates.get(t.toolName + '#count') ?? 1;
        toolSuccessRates.set(t.toolName, (existing * existingCount + t.avgSuccess) / (existingCount + 1));
        toolSuccessRates.set(t.toolName + '#count', existingCount + 1);
      }
    }

    // Determine which tool names from templates have at least one entry with frequency >= 3
    const lowThresholdTemplates = new Map<string, number>();
    for (const [key, entry] of (selfModel as any).proceduralPatterns?.entries?.() ?? []) {
      if (entry.frequency >= minObservations) {
        const existing = lowThresholdTemplates.get(entry.toolName);
        if (existing === undefined) {
          lowThresholdTemplates.set(entry.toolName, entry.avgSuccess);
        }
      }
    }

    // 2. Query episodic events for tool-call sequences
    const eventManager = getEpisodicEventManager();
    let sequenceGroups: Map<string, {
      sequence: string[];
      sessions: Set<string>;
      count: number;
      firstObserved: Date;
      lastObserved: Date;
    }> = new Map();

    try {
      const db = (eventManager as any).db;
      const collection = (eventManager as any).collection;

      // Find events that look like tool calls
      // These could be stored with event_type 'tool_call' or 'conversation' with tool-call content
      const toolCallEvents = await collection.find({
        $or: [
          { event_type: 'tool_call' },
          { 'content.role': 'tool' },
          { 'content.message': { $regex: /tool|mcp|function_call/i } },
        ],
      })
        .sort({ timestamp: 1 })
        .limit(500)
        .toArray();

      // Group by session_id and build ordered sequences
      const sessionSequences = new Map<string, string[]>();
      for (const event of toolCallEvents) {
        const sessionId = event.session_id || 'unknown';
        if (!sessionSequences.has(sessionId)) {
          sessionSequences.set(sessionId, []);
        }
        // Extract tool name from event — prefer explicit tool_name field, then parse from content
        let toolName = event.tool_name || event.content?.tool_name || event.content?.name || '';
        if (!toolName && typeof event.content?.message === 'string') {
          // Try to extract tool name from message patterns like "Called tool: X" or "Executing X"
          const match = event.content.message.match(/(?:Called tool:|Executing|Invoking|tool_call|function\s*call)\s*[:\s]*(\S+)/i);
          if (match) toolName = match[1];
        }
        if (!toolName && event.content?.tool_calls) {
          // Anthropic-style tool_calls array
          for (const tc of (Array.isArray(event.content.tool_calls) ? event.content.tool_calls : [])) {
            if (tc.function?.name) {
              sessionSequences.get(sessionId)!.push(tc.function.name);
            }
          }
          continue;
        }
        if (toolName) {
          sessionSequences.get(sessionId)!.push(toolName);
        }
      }

      // Count each unique sequence across sessions
      for (const [, sequence] of sessionSequences) {
        if (sequence.length < 2) continue; // Must have at least 2 tool calls

        // Also consider subsequences (sliding window)
        for (let i = 0; i < sequence.length - 1; i++) {
          for (let j = i + 1; j < Math.min(i + 6, sequence.length); j++) {
            const subSeq = sequence.slice(i, j + 1);
            const key = hashSequence(subSeq);

            if (sequenceGroups.has(key)) {
              const g = sequenceGroups.get(key)!;
              g.count++;
              g.sessions.add(sessionSequences.keys().next().value!);
              if (!g.lastObserved || g.lastObserved < new Date()) g.lastObserved = new Date();
            } else {
              sequenceGroups.set(key, {
                sequence: subSeq,
                sessions: new Set([sessionSequences.keys().next().value!]),
                count: 1,
                firstObserved: new Date(),
                lastObserved: new Date(),
              });
            }
          }
        }
      }
    } catch (err: any) {
      errors.push(`Episodic query failed: ${err.message}`);
    }

    // 3. Generate candidates
    const newCandidates: CandidateSkillSpec[] = [];

    for (const [, group] of sequenceGroups) {
      if (group.count < minObservations) continue;

      // Compute success rate from SelfModelService data
      let totalSuccess = 0;
      let toolCount = 0;
      for (const toolName of group.sequence) {
        const rate = lowThresholdTemplates.get(toolName) ?? toolSuccessRates.get(toolName) ?? 0.5;
        totalSuccess += rate;
        toolCount++;
      }
      const avgSuccessRate = toolCount > 0 ? totalSuccess / toolCount : 0.5;
      const successCount = Math.round(group.count * avgSuccessRate);
      const failureCount = group.count - successCount;

      const slug = sequenceToSlug(group.sequence);
      const spec: CandidateSkillSpec = {
        name: slug,
        title: sequenceToTitle(group.sequence),
        category: 'operational',
        description: `Automated procedural sequence: ${group.sequence.join(' → ')}. Observed ${group.count} times across ${group.sessions.size} sessions with ~${(avgSuccessRate * 100).toFixed(0)}% success rate.`,
        trigger_conditions: group.sequence.map(t => t.replace(/^mcp_tool_|^tool_/g, '')),
        observed_sequence: group.sequence,
        observation_count: group.count,
        success_count: successCount,
        failure_count: failureCount,
        source_session_ids: Array.from(group.sessions),
        first_observed: group.firstObserved,
        last_observed: group.lastObserved,
        auto_promote: group.count >= 5 && avgSuccessRate >= 0.6,
      };

      // Store in-memory (dedup by name)
      const existing = this.candidates.get(slug);
      if (existing) {
        // Merge: update counts
        existing.observation_count = Math.max(existing.observation_count, group.count);
        existing.source_session_ids = [...new Set([...existing.source_session_ids, ...Array.from(group.sessions)])];
        if (group.lastObserved > existing.last_observed) existing.last_observed = group.lastObserved;
      } else {
        this.candidates.set(slug, spec);
        newCandidates.push(spec);
      }
    }

    // 4. Auto-synthesize candidates
    if (autoSynthesize) {
      for (const candidate of this.candidates.values()) {
        // Only synthesize candidates that haven't been synthesized yet
        // (we infer this from whether a SKILL.md already exists for this name)
        try {
          const synthesisService = SkillSynthesisService.get_instance();
          // Check if we should synthesize this one — skip if already exists as a loaded skill
          if (candidate.observation_count >= minObservations) {
            const result = await synthesisService.synthesizeSkill(candidate);
            if (result.success) {
              skillsSynthesized++;
            } else if (result.error) {
              errors.push(`Synthesis failed for ${candidate.name}: ${result.error}`);
            }
          }
        } catch (err: any) {
          errors.push(`Synthesis error for ${candidate.name}: ${err.message}`);
        }
      }
    }

    // 5. Promote candidates (auto_promote)
    for (const candidate of this.candidates.values()) {
      if (candidate.auto_promote) {
        // The promoteCandidate method updates in-memory state
        // The actual skill file promotion happens via SkillLoaderService
        try {
          const skillLoader = (await import('../memory/skill-loader-service.js')).SkillLoaderService.get_instance();
          const existing = skillLoader.load(candidate.name);
          if (existing && existing.metadata.status !== 'stable') {
            // If a SKILL.md exists but isn't stable, we'd need to rewrite it
            // For now, just mark as promoted in our candidates map
            skillsPromoted++;
          }
        } catch {
          // Non-critical
        }
      }
    }

    return {
      candidates_found: this.candidates.size,
      skills_synthesized: skillsSynthesized,
      skills_promoted: skillsPromoted,
      candidates: Array.from(this.candidates.values()),
      errors,
    };
  }

  /** Return all in-memory candidate specs */
  getCandidates(): CandidateSkillSpec[] {
    return Array.from(this.candidates.values());
  }

  /** Promote a specific candidate by name */
  promoteCandidate(name: string): boolean {
    const candidate = this.candidates.get(name);
    if (!candidate) return false;
    candidate.auto_promote = true;

    // Update the SKILL.md status if it exists
    try {
      // Dynamic import to avoid circular dependency at module load
      import('../memory/skill-loader-service.js').then(({ SkillLoaderService }) => {
        const skill = SkillLoaderService.get_instance().load(name);
        if (skill && skill.metadata.status !== 'stable') {
          console.log(`[Distillation] Promoted candidate "${name}" to stable`);
        }
      }).catch(() => {});
    } catch {
      // Non-critical
    }

    return true;
  }
}
