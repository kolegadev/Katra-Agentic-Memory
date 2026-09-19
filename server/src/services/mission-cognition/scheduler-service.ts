// Phase 4 scheduler service — SHADOW MODE ONLY (contract §3, §5).
// Generates work items from real triggers, scores priority (deterministic)
// and suitability (observable outcomes), persists the FULL decision record
// with per-feature explanations and exclusions, and recommends — without
// ever touching real allocation. It imports nothing from the existing
// allocator (autonomous-executive.ts is out of bounds and never referenced).
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import { generateWorkItems } from './work-item-generator.js';
import { scorePriority, type ScoredItem } from './priority-scorer.js';
import { candidateAgents, scoreSuitability } from './suitability-scorer.js';
import { schedulerMode } from './index.js';
import type { CognitiveWorkItem, SchedulerCandidate, SchedulerDecision } from '../../types/cognitive-control.js';

export interface ShadowRunResult {
  decision: SchedulerDecision;
  queue: CognitiveWorkItem[];
}

export class SchedulerService {
  constructor(private readonly db: Db) {}

  private items() {
    return this.db.collection<CognitiveWorkItem & { _id?: unknown }>(COLLECTIONS.cognitiveWorkItems);
  }

  private decisions() {
    return this.db.collection<SchedulerDecision & { _id?: unknown }>(COLLECTIONS.schedulerDecisions);
  }

  /** Persist generated work items (dedupe by trigger+description+mission). */
  async upsertWorkItems(missionId: string): Promise<CognitiveWorkItem[]> {
    const generated = await generateWorkItems(this.db, missionId);
    const now = new Date().toISOString();
    const stored: CognitiveWorkItem[] = [];
    for (const g of generated) {
      const existing = await this.items().findOne(
        { mission_id: missionId, trigger: g.trigger, description: g.description },
        { projection: { _id: 0 } },
      );
      if (existing) {
        // Refresh the measured cost feature on existing queued items so a
        // stale pre-ledger (proxy-band) item can never masquerade as measured.
        const e = existing as unknown as CognitiveWorkItem;
        if (e.status === 'queued' && (e.features.cost_basis !== g.item.features.cost_basis || e.features.cognitive_cost !== g.item.features.cognitive_cost)) {
          await this.items().updateOne(
            { work_item_id: e.work_item_id },
            { $set: { 'features.cognitive_cost': g.item.features.cognitive_cost, 'features.cost_basis': g.item.features.cost_basis, updated_at: now } },
          );
          e.features.cognitive_cost = g.item.features.cognitive_cost;
          e.features.cost_basis = g.item.features.cost_basis;
          e.updated_at = now;
        }
        stored.push(e);
        continue;
      }
      const item: CognitiveWorkItem = {
        ...(g.item as CognitiveWorkItem),
        work_item_id: randomUUID(),
        created_at: now,
        updated_at: now,
      };
      await this.items().insertOne(item);
      stored.push(item);
    }
    return stored;
  }

  async listQueue(missionId?: string): Promise<CognitiveWorkItem[]> {
    const filter: Record<string, unknown> = missionId ? { mission_id: missionId } : {};
    return this.items()
      .find(filter, { projection: { _id: 0 } })
      .sort({ updated_at: -1 })
      .limit(100)
      .toArray() as unknown as CognitiveWorkItem[];
  }

  /** One shadow decision pass: score, rank, explain, persist. Changes NO real allocation. */
  async runShadowPass(missionId: string): Promise<ShadowRunResult> {
    if (schedulerMode() === 'off') {
      throw new Error('COGNITIVE_SCHEDULER_MODE is off — shadow pass refused');
    }
    const queue = await this.upsertWorkItems(missionId);
    const agents = await candidateAgents(this.db);
    const incumbent = await this.db
      .collection(COLLECTIONS.epistemicEntries)
      .findOne(
        { mission_id: missionId, entry_type: 'hypothesis', status: { $in: ['active', 'accepted'] } },
        { projection: { _id: 0, author_id: 1 }, sort: { created_at: -1 } },
      );
    const incumbentAuthorId = (incumbent as any)?.author_id as string | undefined;

    const scored: ScoredItem[] = queue.map(scorePriority).sort((a, b) => b.priority - a.priority);

    const candidates: SchedulerCandidate[] = [];
    const exclusions: SchedulerDecision['exclusions'] = [];
    for (const s of scored) {
      for (const agentId of agents) {
        const suit = await scoreSuitability(this.db, {
          agentId,
          workItemDescription: s.workItem.description,
          incumbentAuthorId,
          missionId,
        });
        if (suit.exclusion_reason) {
          exclusions.push({ work_item_id: s.workItem.work_item_id, agent_id: agentId, reason: suit.exclusion_reason });
          continue;
        }
        const combined = s.priority + suit.suitability;
        candidates.push({
          work_item_id: s.workItem.work_item_id,
          agent_id: agentId,
          priority: s.priority,
          suitability: suit.suitability,
          combined,
          feature_contributions: [
            ...s.contributions.map(c => ({ ...c, feature: `priority.${c.feature}` })),
            ...suit.factors.map(f => ({ feature: `suitability.${f.factor}`, value: f.value, weight: 1 })),
          ],
        });
      }
    }
    candidates.sort((a, b) => b.combined - a.combined);

    const winner = candidates[0] ?? null;
    const now = new Date().toISOString();
    const bases = new Set(scored.map(s => s.workItem.features.cost_basis));
    const decisionCostBasis = bases.size === 1 ? [...bases][0] : 'mixed';
    const decision: SchedulerDecision = {
      schema_version: '1.0',
      decision_id: randomUUID(),
      mission_id: missionId,
      scheduler_mode: 'shadow',
      created_at: now,
      cost_basis: decisionCostBasis,
      candidates,
      exclusions,
      rationale: winner
        ? `Shadow recommendation: ${winner.work_item_id} for ${winner.agent_id} (priority ${winner.priority.toFixed(2)}, suitability ${winner.suitability.toFixed(2)}). ` +
          `Highest-priority trigger: ${scored[0]?.workItem.trigger ?? 'none'}. ` +
          `This pass did NOT change real allocation; the existing allocator was not invoked or modified.`
        : 'No work items generated — no recommendation made. Real allocation unchanged.',
      existing_allocator_note:
        'shadow mode: the existing allocator was neither invoked nor modified; its output is untouched (criterion 12).',
      recommended: winner ? { work_item_id: winner.work_item_id, agent_id: winner.agent_id } : null,
      recommended_was_acted_on: false,
    };
    await this.decisions().insertOne(decision);
    return { decision, queue };
  }

  async latestDecision(missionId: string): Promise<SchedulerDecision | null> {
    return this.decisions().findOne(
      { mission_id: missionId },
      { projection: { _id: 0 }, sort: { created_at: -1 } },
    ) as unknown as SchedulerDecision | null;
  }

  /** Human-readable explanation of the latest decision (decisive test A). */
  async explainLatest(missionId: string): Promise<string> {
    const d = await this.latestDecision(missionId);
    if (!d) return 'No scheduler decision recorded for this mission.';
    const lines: string[] = [
      `Scheduler decision ${d.decision_id} — mode ${d.scheduler_mode} · cost basis ${d.cost_basis}`,
      `Recommended: ${d.recommended ? `${d.recommended.work_item_id} → ${d.recommended.agent_id}` : '(none)'}`,
      `Rationale: ${d.rationale}`,
      `Existing allocator: ${d.existing_allocator_note}`,
      '',
      'Ranked candidates:',
    ];
    d.candidates.slice(0, 10).forEach((c, i) => {
      lines.push(
        `#${i + 1} ${c.work_item_id} → ${c.agent_id} · combined ${c.combined.toFixed(2)} ` +
        `(priority ${c.priority.toFixed(2)} + suitability ${c.suitability.toFixed(2)})`,
      );
      lines.push('   ' + c.feature_contributions.map(f => `${f.feature}=${f.value.toFixed(2)}`).join(' · '));
    });
    if (d.exclusions.length > 0) {
      lines.push('', 'Exclusions:');
      for (const e of d.exclusions) lines.push(`  - ${e.work_item_id} × ${e.agent_id}: ${e.reason}`);
    }
    return lines.join('\n');
  }
}
