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
  | 'SUCCESS_CRITERION_UPDATED'
  | 'BLOCKED' | 'CAPABILITY_REQUESTED' | 'PLAN_CHANGE_PROPOSED'
  | 'CHECKPOINT_CREATED' | 'MISSION_STATUS_CHANGED';
export type DeltaStatus = 'proposed' | 'accepted' | 'rejected' | 'conflict' | 'duplicate';
export type EntryType =
  | 'claim' | 'evidence' | 'assumption' | 'hypothesis' | 'uncertainty'
  | 'contradiction' | 'decision' | 'experiment' | 'result' | 'unknown';
export type EntryStatus =
  | 'proposed' | 'active' | 'accepted' | 'challenged' | 'rejected'
  | 'superseded' | 'invalidated' | 'resolved' | 'deferred' | 'accepted_risk';
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
  /** Must match mission-state.schema.json ($defs/constraint). */
  constraints?: Array<{ id: string; kind: 'time' | 'cost' | 'privacy' | 'safety' | 'legal' | 'technical' | 'authority' | 'other'; description: string }>;
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

// ── Phase 4: cognitive scheduler (shadow mode) ─────────────────────

export type WorkItemStatus = 'queued' | 'allocated' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';

export interface CognitiveWorkItem {
  schema_version: string;
  work_item_id: string;
  mission_id: string;
  description: string;
  mode: BatonMode;
  status: WorkItemStatus;
  authority_class: AuthorityClass;
  trigger: 'open_objective' | 'invalidated_decision' | 'active_uncertainty' | 'stale_checkpoint' | 'blocked_dependency' | 'manual';
  // Priority feature vector (criterion 3).
  features: {
    mission_impact: number;
    uncertainty: number;
    information_value: number;
    dependency_centrality: number;
    urgency: number;
    cognitive_cost: number;
    cost_basis: string; // §2: which basis produced cognitive_cost (proxy | measured)
  };
  created_at: string;
  updated_at: string;
}

export interface SchedulerCandidate {
  work_item_id: string;
  agent_id: string;
  priority: number;
  suitability: number;
  combined: number;
  feature_contributions: Array<{ feature: string; value: number; weight: number }>;
  exclusion_reason?: string;
}

export interface SchedulerDecision {
  schema_version: string;
  decision_id: string;
  mission_id: string;
  scheduler_mode: string;
  created_at: string;
  cost_basis: string;
  candidates: SchedulerCandidate[];
  exclusions: Array<{ work_item_id: string; agent_id: string; reason: string }>;
  rationale: string;
  existing_allocator_note: string; // criterion 15: what real allocation did (shadow => untouched)
  recommended: { work_item_id: string; agent_id: string } | null;
  recommended_was_acted_on: boolean;
  // Phase 6 (additive — Phase 1 schema widened, declared in the work-log):
  // what the existing allocator actually did at decision time, when observable.
  allocator_observation?: AllocatorObservation;
}

// ── Phase 6: controlled activation ────────────────────────────────────────

export type SchedulerMode = 'off' | 'shadow' | 'recommend' | 'allocate_internal' | 'allocate_gated';

/** What the existing allocator actually did, attached to a scheduler decision. */
export interface AllocatorObservation {
  /** The agent the existing allocator actually chose; null = no allocation happened. */
  agent_id: string | null;
  observed_at: string;
  /** 'manual' = recorded via record_allocator_observation; 'auto-observer' = read from stored allocator output. */
  source: 'manual' | 'auto-observer';
  /** Reference to the stored record the observation was read from (episodic event id) or a free note. */
  evidence_ref?: string;
  note?: string;
}

export type ActivationLedgerKind =
  | 'mode_change'
  | 'mode_change_refused'
  | 'opt_in'
  | 'opt_in_revoke'
  | 'cycle_start'
  | 'cycle_halt'
  | 'influence_applied'
  | 'counterfactual_recorded'
  | 'evidence_acknowledged'
  | 'kill_switch_forced_off';

export interface ActivationLedgerEntry {
  ledger_id: string;
  kind: ActivationLedgerKind;
  actor_id: string;
  created_at: string;
  mission_id?: string;
  mode_from?: SchedulerMode;
  mode_to?: SchedulerMode;
  reason: string;
  evidence_ref?: string;
  cycle_id?: string;
  detail?: Record<string, unknown>;
}

export interface MissionOptIn {
  opt_in_id: string;
  mission_id: string;
  owner_id: string;
  opted_in_by: string;
  reason: string;
  created_at: string;
  revoked_at?: string;
  revoked_by?: string;
  revoke_reason?: string;
}

export interface AllocationCounterfactual {
  counterfactual_id: string;
  mission_id: string;
  decision_id: string;
  cycle_id: string;
  work_item_id: string;
  mode: SchedulerMode;
  /** true = the scheduler's choice was taken; false = the existing allocator's choice was taken. */
  influenced: boolean;
  chosen_agent_id: string;
  /** What the existing allocator would have chosen (its own scoring, unmodified). */
  existing_allocator_agent_id: string;
  recorded_at: string;
  reason: string;
}

export interface EvidenceAcknowledgement {
  acknowledgement_id: string;
  acknowledged_by: string;
  created_at: string;
  /** Counts computed from stored records at acknowledgement time (never caller-asserted). */
  decision_count: number;
  observed_decisions: number;
  agreement_rate: number | null;
  note?: string;
}

export interface EvidenceGateState {
  gate_open: boolean;
  threshold: number;
  qualifying_decisions: number;
  observed_decisions: number;
  agreement_rate: number | null;
  acknowledged: boolean;
  latest_acknowledgement: EvidenceAcknowledgement | null;
  reason: string;
}

// ── Phase 8: skill evolution gates (contract §4.11-4.16) ─────────────────

export type SkillEvolutionKind =
  | 'candidate'
  | 'replay'
  | 'canary'
  | 'promotion'
  | 'refusal'
  | 'pin';

export interface SkillEvolutionRecord {
  entry_id: string;
  kind: SkillEvolutionKind;
  skill: string;
  actor_id: string;
  created_at: string;
  candidate_id?: string;
  version?: string;
  note?: string;
  mission_id?: string;
  detail?: Record<string, unknown>;
}

/** The chain a candidate must pass, in order: candidate -> replay -> canary -> promotion. */
export interface SkillCandidateState {
  candidate_id: string;
  skill: string;
  version: string;
  note: string;
  proposed_by: string;
  proposed_at: string;
  replay_verdict: 'pass' | 'fail' | 'insufficient' | null;
  replay_detail?: Record<string, unknown>;
  canary_started: boolean;
  canary_outcome?: 'ok' | 'regressed' | null;
  promoted: boolean;
  promoted_at?: string;
}

// ── Phase 5: uncertainty engine (deterministic triggers, shadow) ─────────

export type TriggerType =
  | 'repeated_failure_stable_confidence'
  | 'high_confidence_unsupported'
  | 'single_hypothesis_high_impact'
  | 'material_contradictory_evidence'
  | 'unexpected_experiment_result'
  | 'plan_unchanged_despite_evidence'
  | 'critic_disagreement'
  | 'convergent_agents';

export interface FiredTrigger {
  trigger: TriggerType;
  mission_id: string;
  entry_id?: string;        // the entry/decision/assumption the trigger concerns
  reason: string;           // human-readable, deterministic
  consequence_if_false?: string;
  independence_requirement?: boolean | 'blind_parallel';
}

export type TriggerOutcome = 'useful_information' | 'mere_variance' | 'unnecessary_cost';

export interface TriggerEvaluationRecord {
  evaluation_id: string;
  mission_id: string;
  trigger: TriggerType;
  entry_id?: string;
  fired_at: string;
  outcome: TriggerOutcome;
  token_cost: number;       // measured from the usage ledger (never estimated)
  note?: string;
}

export interface DependencyTrace {
  root_entry_id: string;
  dependents: string[];     // transitive dependents via depends_on
  depth_bound_applied: number;
  cycle_detected: boolean;
}

export interface ExperimentRecord {
  schema_version: string;
  entry_id: string;
  mission_id: string;
  entry_type: 'experiment';
  statement: string;
  status: string;
  author_id: string;
  confidence: number;
  depends_on: string[];     // hypothesis entry ids this experiment separates
  information_needed?: string[];
  result?: { outcome: string; supports_entry_id?: string; contradicts_entry_id?: string; created_at: string };
}
