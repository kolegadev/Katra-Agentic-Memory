// Phase 4 priority scorer — deterministic, floor-guarded, explainable.
// doc 03 formula, adapted with the §2 proxy cost:
//   priority = mission_impact * max(uncertainty, uncertainty_floor)
//            * information_value * (1 + dependency_centrality/10) * urgency
//            / max(cognitive_cost, cost_floor)
// Zero/missing cost or uncertainty can never divide by zero or blow up
// (criterion 5); identical inputs yield identical scores (criterion 4).
// Part of the no-publish branch feat/cognitive-control-local.
import type { CognitiveWorkItem } from '../../types/cognitive-control.js';

export const UNCERTAINTY_FLOOR = 0.1;
export const COST_FLOOR = 1;

export interface FeatureContribution {
  feature: string;
  value: number;
  weight: number;
}

export interface ScoredItem {
  workItem: CognitiveWorkItem;
  priority: number;
  contributions: FeatureContribution[];
}

export function scorePriority(item: CognitiveWorkItem): ScoredItem {
  const f = item.features;
  const uncertainty = Number.isFinite(f.uncertainty) ? Math.max(f.uncertainty, UNCERTAINTY_FLOOR) : UNCERTAINTY_FLOOR;
  const cost = Number.isFinite(f.cognitive_cost) ? Math.max(f.cognitive_cost, COST_FLOOR) : COST_FLOOR;
  const impact = Number.isFinite(f.mission_impact) ? f.mission_impact : 1;
  const info = Number.isFinite(f.information_value) ? f.information_value : 1;
  const centrality = Number.isFinite(f.dependency_centrality) ? 1 + f.dependency_centrality / 10 : 1;
  const urgency = Number.isFinite(f.urgency) ? f.urgency : 1;

  const priority = (impact * uncertainty * info * centrality * urgency) / cost;

  return {
    workItem: item,
    priority: Number.isFinite(priority) ? priority : 0,
    contributions: [
      { feature: 'mission_impact', value: impact, weight: 1 },
      { feature: 'uncertainty', value: uncertainty, weight: 1 },
      { feature: 'information_value', value: info, weight: 1 },
      { feature: 'dependency_centrality', value: centrality, weight: 1 },
      { feature: 'urgency', value: urgency, weight: 1 },
      { feature: 'cognitive_cost', value: cost, weight: -1 },
    ],
  };
}
