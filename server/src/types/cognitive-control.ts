// Katra Long Horizon Cognitive Control — domain types (Phase 0/1/2).
// Mirrors handoff/schemas/*.schema.json (draft 2020-12, additionalProperties relaxed
// at root per the "tolerate additive minor fields" policy).
// This module is part of the no-publish branch feat/cognitive-control-local.

export type AuthorityClass = 'A' | 'B' | 'C';
export type MissionStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
export type DeltaType =
  | 'CLAIM_ADDED' | 'EVIDENCE_ADDED' | 'ASSUMPTION_CHALLENGED'
  | 'UNCERTAINTY_OPENED' | 'UNCERTAINTY_UPDATED' | 'UNCERTAINTY_RESOLVED'
  | 'HYPOTHESIS_ADDED' | 'HYPOTHESIS_REJECTED'
  | 'EXPERIMENT_PROPOSED' | 'EXPERIMENT_RESULT'
  | 'DECISION_PROPOSED' | 'DECISION_ACCEPTED' | 'DECISION_INVALIDATED'
  | 'OBJECTIVE_CREATED' | 'OBJECTIVE_UPDATED' | 'OBJECTIVE_COMPLETED'
  | 'BLOCKED' | 'CAPABILITY_REQUESTED' | 'PLAN_CHANGE_PROPOSED'
  | 'CHECKPOINT_CREATED' | 'MISSION_STATUS_CHANGED';
export type DeltaStatus = 'proposed' | 'accepted' | 'rejected' | 'conflict' | 'duplicate';
export type EntryType =
  | 'claim' | 'evidence' | 'assumption' | 'hypothesis' | 'uncertainty'
  | 'contradiction' | 'decision' | 'experiment' | 'result' | 'unknown';
export type EntryStatus = 'proposed' | 'accepted' | 'superseded' | 'invalidated' | 'open';
export type BatonMode = 'execute' | 'explore' | 'challenge' | 'synthesize' | 'verify' | 'monitor';

export interface ConfidenceChange {
  prior: number;
  next: number;
  reason: string;
  actor_id: string;
  at: string;
}

export interface CapabilityRef {
  capability_id: string;
  scope?: string;
  operations?: string[];
  approval?: 'autonomous' | 'gated' | 'cautious';
}

export interface SuccessCriterion {
  id: string;
  description: string;
  status: 'unmet' | 'partial' | 'met' | 'waived';
  evidence_refs?: string[];
}

export interface MissionObjective {
  id: string;
  description: string;
  status: 'pending' | 'ready' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
  owner_id: string;
  dependency_ids?: string[];
  evidence_refs?: string[];
}

export interface MissionState {
  schema_version: string;
  mission_id: string;
  version: number;
  title: string;
  intent: string;
  status: MissionStatus;
  phase?: string;
  owner_id: string;
  shared_id?: string;
  success_criteria: SuccessCriterion[];
  stop_conditions?: string[];
  constraints?: Record<string, string[]>;
  authority_class: AuthorityClass;
  objectives?: MissionObjective[];
  ledger_refs?: string[];
  artifact_refs?: string[];
  capability_refs?: CapabilityRef[];
  active_baton_ids?: string[];
  checkpoint_id?: string;
  next_cognition?: string;
  created_at: string;
  updated_at: string;
}

export interface LedgerEntryDraft {
  schema_version: string;
  entry_id?: string;
  mission_id: string;
  entry_type: EntryType;
  statement: string;
  status: EntryStatus;
  author_id: string;
  source?: string;
  confidence: number;
  depends_on?: string[];
  supersedes?: string;
  evidence_for?: string[];
  evidence_against?: string[];
  alternative_hypotheses?: string[];
  consequence_if_false?: string;
  information_needed?: string;
  independence_requirement?: boolean;
  artifact_refs?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface LedgerEntry extends LedgerEntryDraft {
  entry_id: string;
  created_at: string;
  updated_at: string;
  confidence_history?: ConfidenceChange[];
}

export interface StateDeltaDraft {
  schema_version: string;
  delta_id?: string;
  idempotency_key: string;
  mission_id: string;
  base_mission_version: number;
  author_id: string;
  execution_identity?: string;
  baton_id?: string;
  work_item_id?: string;
  delta_type: DeltaType;
  operations: Record<string, unknown>[];
  ledger_entries?: LedgerEntryDraft[];
  rationale: string;
  confidence: number;
  evidence_refs?: string[];
  expected_effects?: string[];
  human_gate?: 'none' | 'approval' | 'review';
  skills_used?: Record<string, string>;
  created_at?: string;
  audit_hash?: string;
}

export interface StateDelta extends StateDeltaDraft {
  delta_id: string;
  status: DeltaStatus;
  created_at: string;
  applied_at?: string;
}

export interface BlindnessPolicy {
  enabled: boolean;
  withheld_classes: string[];
}

export interface CognitiveBatonDraft {
  schema_version: string;
  baton_id?: string;
  mission_id: string;
  mission_version: number;
  recipient_id: string;
  mode: BatonMode;
  objective: string;
  non_objectives?: string[];
  deliverable: string;
  context?: {
    claims?: string[];
    decisions?: string[];
    assumptions?: string[];
    uncertainties?: string[];
    contradictions?: string[];
    evidence?: string[];
  };
  ownership?: { agent_id: string; work_item_id?: string }[];
  capabilities?: CapabilityRef[];
  required_delta_types?: DeltaType[];
  budget?: { max_cost?: number; max_hours?: number };
  stop_conditions?: string[];
  blindness?: BlindnessPolicy;
  skill_versions?: Record<string, string>;
  issued_at?: string;
  expires_at: string;
}

export interface CognitiveBaton extends CognitiveBatonDraft {
  baton_id: string;
  issued_at: string;
  revoked?: boolean;
  revoked_at?: string;
}

export interface MissionEvent {
  event_id: string;
  mission_id: string;
  event_type: string;
  version?: number;
  delta_id?: string;
  baton_id?: string;
  entry_id?: string;
  summary: string;
  created_at: string;
}
