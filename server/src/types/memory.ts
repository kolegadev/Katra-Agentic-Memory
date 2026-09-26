/**
 * Core memory system type definitions
 */

// Episodic Memory Types
export interface EpisodicEvent {
  id?: string;
  session_id: string;
  user_id: string;
  event_type: string;
  content: Record<string, any>;
  metadata?: Record<string, any>;
  correlation_id?: string;
  timestamp: Date;
  content_hash?: string;
  idempotency_key?: string;
  embedding?: number[];
  embedding_model?: string;
  embedding_version?: number;
  retrieval_strength?: number;
  decay_exponent?: number;
  last_accessed_at?: Date;
  access_count?: number;
  anomaly_z_score?: number;
  anomaly_classification?: string;
  shared_id?: string;
}

export interface SessionStats {
  session_id: string;
  event_count: number;
  first_event: Date;
  last_event: Date;
  unique_event_types: string[];
}

// Knowledge Graph Types
export interface KnowledgeNode {
  id: string;
  user_id: string;
  session_id?: string;
  type: string;
  properties: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface KnowledgeRelationship {
  from_id: string;
  to_id: string;
  relationship_type: string;
  properties?: Record<string, any>;
  strength?: number;
  created_at: Date;
  retrieval_strength?: number;
  decay_exponent?: number;
  last_accessed_at?: Date;
  access_count?: number;
}

// Working Memory Types
export interface WorkingMemorySession {
  session_id: string;
  user_id: string;
  state: Record<string, any>;
  last_accessed: Date;
  expires_at?: Date;
}

export interface SemanticFact {
  id?: string;
  user_id: string;
  content: string;
  source: string;
  confidence: number;
  metadata?: Record<string, any>;
  created_at: Date;
  embedding?: number[];
  embedding_model?: string;
  embedding_version?: number;
  retrieval_strength?: number;
  decay_exponent?: number;
  last_accessed_at?: Date;
  access_count?: number;
  anomaly_z_score?: number;
  anomaly_classification?: string;
}

// Asset Storage Types
export interface AssetMetadata {
  id: string;
  user_id: string;
  filename: string;
  original_filename: string;
  mime_type: string;
  size: number;
  hash: string;
  metadata?: Record<string, any>;
  version?: number;
  created_at: Date;
  updated_at: Date;
}

// System Health Types
export interface MemorySystemHealth {
  episodic_memory: {
    status: 'healthy' | 'degraded' | 'unavailable';
    mongodb_connected: boolean;
    total_events: number;
  };
  knowledge_graph: {
    status: 'healthy' | 'degraded' | 'unavailable';
    mongodb_connected: boolean;
    total_nodes: number;
    total_relationships: number;
  };
  working_memory: {
    status: 'healthy' | 'degraded' | 'unavailable';
    redis_connected: boolean;
    active_sessions: number;
  };
  asset_storage: {
    status: 'healthy' | 'degraded' | 'unavailable';
    s3_connected: boolean;
    total_assets: number;
  };
}

// ── Sleep Consolidation / Reflection Types ──────────────────────────

export type ReflectionPeriodType = 'daily' | 'weekly' | 'monthly' | 'yearly';

export type ReflectionEdgeType =
  | 'feels_excited_about'
  | 'feels_frustrated_by'
  | 'feels_curious_about'
  | 'feels_confident_in'
  | 'feels_anxious_about'
  | 'feels_grateful_for'
  | 'feels_conflicted_between'
  | 'growing_toward'
  | 'distancing_from'
  | 'protective_of'
  | 'inspired_by'
  | 'drained_by'
  | 'resonates_with'
  | 'tension_between'
  | 'harmony_between';

export interface ReflectiveJournal {
  _id?: any;
  user_id: string;
  shared_id?: string;
  period_type: ReflectionPeriodType;
  period_start: Date;
  period_end: Date;
  narrative: string;
  emotional_arc: {
    dominant_emotion: string;
    intensity: number;
    trajectory: 'rising' | 'falling' | 'stable' | 'oscillating' | 'transformative';
    secondary_emotions: Array<{ emotion: string; intensity: number }>;
  };
  philosophical_insight?: string;
  identity_delta?: string;
  unresolved_threads: string[];
  source_events: string[];
  source_sessions: string[];
  created_at: Date;
}

export interface ReflectionNode {
  _id?: any;
  user_id: string;
  entity_name: string;
  entity_type: string;
  emotional_signature: {
    primary_emotion: string;
    intensity: number;
    valence: number;
    stability: 'volatile' | 'steady' | 'growing' | 'fading';
  };
  reflection_context: string;
  first_observed: Date;
  last_updated: Date;
  observation_count: number;
  created_at: Date;
}

export interface ReflectionEdge {
  _id?: any;
  user_id: string;
  source_entity: string;
  target_entity: string;
  edge_type: ReflectionEdgeType;
  intensity: number;
  valence: number;
  narrative: string;
  first_observed: Date;
  last_updated: Date;
  source_journal_id: any;
  created_at: Date;
}

export interface PhilosophicalInsight {
  _id?: any;
  user_id: string;
  insight_text: string;
  domain: string;
  confidence: number;
  evidence_count: number;
  first_observed: Date;
  last_reinforced: Date;
  source_journal_ids: any[];
  contradictory_evidence?: string[];
  status: 'emerging' | 'strengthening' | 'stable' | 'challenged';
  created_at: Date;
  retrieval_strength?: number;
  decay_exponent?: number;
  last_accessed_at?: Date;
  access_count?: number;
}

export interface GatheredData {
  period_start: Date;
  period_end: Date;
  event_count: number;
  session_count: number;
  conversation_summaries: string;
  semantic_facts: string;
  active_entities: string;
  prior_journal_narrative: string | null;
  unresolved_threads: string[];
}

export interface ReflectionLLMOutput {
  emotional_arc: {
    dominant_emotion: string;
    intensity: number;
    trajectory: 'rising' | 'falling' | 'stable' | 'oscillating' | 'transformative';
    secondary_emotions: Array<{ emotion: string; intensity: number }>;
  };
  entity_reflections: Array<{
    entity_name: string;
    entity_type: string;
    emotional_signature: {
      primary_emotion: string;
      intensity: number;
      valence: number;
      stability: 'volatile' | 'steady' | 'growing' | 'fading';
    };
    reflection: string;
  }>;
  relationships: Array<{
    source_entity: string;
    target_entity: string;
    edge_type: string;
    intensity: number;
    valence: number;
    narrative: string;
  }>;
  philosophical_insight: {
    insight_text: string;
    domain: string;
  } | null;
  identity_delta: string | null;
  unresolved_threads: string[];
  narrative: string;
  // v3.1 balanced reflection fields
  grounding?: { summary: string; emotional_texture: string };
  resonance?: { what_worked: string; moment_of_interest: string; grateful_for: string; resonance_score: number };
  open_threads?: Array<{ thread: string; pull: string; weight: number; carry_forward: boolean }>;
  curiosity?: { alive_question: string; drawn_toward: string };
  integration?: { realization: string; fits_larger_story: string };
  valence?: 'heavy' | 'mixed' | 'steady' | 'light' | 'bright';
  /** @deprecated Replaced by open_threads. Kept for backward compatibility. */
  regret_score?: string | null;
}

export interface ConsolidationResult {
  success: boolean;
  period_type: string;
  period_start: Date;
  period_end: Date;
  journal_id?: string;
  nodes_upserted: number;
  edges_upserted: number;
  insights_upserted: number;
  narrative_preview?: string;
  open_threads?: Array<{ thread: string; pull: string; weight: number; carry_forward: boolean }>;
  valence?: string;
  /** @deprecated Replaced by open_threads. */
  regret_score?: string | null;
  error?: string;
}

// ── Memory Decay Types ──────────────────────────────────────────

export interface DecayConfig {
  memoryType: string;
  decayExponent: number;
  initialStrength: number;
}

export const DEFAULT_DECAY_CONFIGS: Record<string, DecayConfig> = {
  episodic:  { memoryType: 'episodic',  decayExponent: 0.5,  initialStrength: 1.0 },
  semantic:  { memoryType: 'semantic',  decayExponent: 0.15, initialStrength: 1.0 },
  emotional: { memoryType: 'emotional', decayExponent: 0.3,  initialStrength: 1.0 },
  knowledge: { memoryType: 'knowledge', decayExponent: 0.1,  initialStrength: 1.0 },
  insights:  { memoryType: 'insights',  decayExponent: 0.05, initialStrength: 1.0 },
};

export const SPACED_REPETITION_INTERVALS_DAYS = [1, 3, 7, 21, 90];

export const DEFAULT_REINFORCEMENT_FACTOR = 0.95;

export interface DecayStats {
  memoryType: string;
  totalMemories: number;
  averageStrength: number;
  minStrength: number;
  maxStrength: number;
  decayedCount: number;
  reinforcedCount: number;
}

// ── Anomaly Detection Types ─────────────────────────────────────

export type AnomalyClassification = 'NORMAL' | 'SUSPECT' | 'ANOMALOUS';

export interface AnomalyRecord {
  memory_id: string;
  memory_type: string;
  z_score: number;
  classification: AnomalyClassification;
  confidence: number;
  adjusted_confidence: number;
  detected_at: Date;
  quarantined: boolean;
}

export interface QuarantinedMemory {
  memory_id: string;
  memory_type: string;
  z_score: number;
  content_preview: string;
  quarantined_at: Date;
  auto_rehabilitate: boolean;
}

export interface AnomalyReport {
  total_ingested: number;
  normal_count: number;
  suspect_count: number;
  anomalous_count: number;
  quarantine_count: number;
  recent_anomalies: Array<{
    memory_id: string;
    z_score: number;
    classification: AnomalyClassification;
  }>;
}

// ── Katra Internal Skill Library Types ─────────────────────────

export type SkillStatus = 'observed' | 'candidate' | 'stable' | 'challenged';
export type SkillCategory = 'operational' | 'decision' | 'troubleshooting';

export interface KatraSkill {
  name: string;
  title: string;
  category: SkillCategory;
  description: string;
  status: SkillStatus;
  version?: string;
  observation_count: number;
  success_count: number;
  failure_count: number;
  confidence: number;
  triggers: string[];
  created_at: Date;
  last_used_at?: Date;
  last_refined_at?: Date;
  source: 'auto-distilled' | 'manual-request';
}

export interface SkillFeedbackRecord {
  skill_name: string;
  session_id: string;
  outcome: 'success' | 'partial' | 'failure';
  notes?: string;
  task_description?: string;
  confidence_before?: number;
  confidence_after?: number;
  skill_version?: string;
  timestamp: Date;
}

export interface SkillSearchResult {
  name: string;
  title: string;
  category: SkillCategory;
  description: string;
  status: SkillStatus;
  version?: string;
  confidence: number;
  triggers: string[];
  score: number;
}

export interface SkillActivationContext {
  task_description: string;
  skills: SkillSearchResult[];
  activation_paths: {
    context_pre_seed: SkillSearchResult[];   // Path A
    trigger_match: SkillSearchResult[];       // Path B (stub for Phase 3)
    embedding_match: SkillSearchResult[];     // Path C (stub for Phase 3)
  };
}

// ── Operational Distillation Types ─────────────────────────────

export interface CandidateSkillSpec {
  name: string;
  title: string;
  category: SkillCategory;
  description: string;
  trigger_conditions: string[];
  observed_sequence: string[];
  observation_count: number;
  success_count: number;
  failure_count: number;
  source_session_ids: string[];
  first_observed: Date;
  last_observed: Date;
  auto_promote: boolean;
}

export interface DistillationResult {
  candidates_found: number;
  skills_synthesized: number;
  skills_promoted: number;
  candidates: CandidateSkillSpec[];
  errors: string[];
}

// ── ITER-11: the verification, learning and telemetry artifacts ─────────────
//
// The brief's §6.1 item 5 asks for the new artifacts to exist as TYPES with
// validation, not only as module-local shapes. Everything below is one of the
// artifacts ITER-11 introduces; each carries its bounds so a reader (and a
// validator) can see what "bounded" means for that row. None of them is ever
// shared: all five are personal kinds (see `write-scope-policy.ts`).

/** The bounds every new artifact is validated against. */
export const ITER11_ARTIFACT_BOUNDS = {
  /** How many failure-signature rows one {identity, mission} keeps. */
  max_failure_signatures: 48,
  /** How many trace-ready salience inputs one identity keeps. */
  max_trace_ready_inputs: 100,
  /** How many personality delta proposals one identity keeps. */
  max_delta_proposals: 50,
  /** The note/detail bound shared by the new rows. */
  max_detail_chars: 500,
} as const;

/** Why a candidate's test failed — a slug, never free text. */
export interface IdeaFailureSignature {
  schema_version: '1.0';
  kind: 'failure_signature';
  signature_id: string;
  user_id: string;
  mission_id: string;
  seed_id: string | null;
  operator: string | null;
  signature: string;
  detail: string | null;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}

/** The test-run tally behind a signature. */
export interface IdeaTestVerdict {
  seed_id: string;
  operator: string | null;
  rank: number;
  cheapest_test: string;
  expected_information_gain: number;
  cost: number;
  outcome: 'useful_information' | 'mere_variance' | 'unnecessary_cost';
  recorded_at: string;
}

/** One bounded personality delta PROPOSAL (never applied autonomously). */
export interface PersonalityDeltaProposalRow {
  proposal_id: string;
  user_id: string;
  status: 'proposed' | 'refused';
  dimension: string | null;
  direction: 'increase' | 'decrease' | null;
  applied: false;
  autonomous_application: 'forbidden';
  created_at: string;
}

/** One counted read of the legacy global personality record. */
export interface PersonalityDeprecationEventRow {
  event_key: string;
  user_id: string;
  kind: 'legacy_read' | 'no_user_id_path' | 'legacy_write';
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  expires_at: string;
}

/**
 * A salience computation stamped for one identity and persisted so the trace
 * producer can cite it WITHOUT the fast ingestion gate changing: numbers only,
 * no statement text, no journal or reflection material.
 */
export interface TraceReadySalienceInput {
  schema_version: '1.0';
  kind: 'salience_input';
  input_id: string;
  user_id: string;
  mission_id: string | null;
  meta_state: string;
  signals: Record<string, number>;
  weights: Record<string, number>;
  score: number;
  tier: 'high' | 'medium' | 'low';
  threshold: number;
  created_at: string;
}

/** One bounded novelty-drive adjustment derived from coverage and outcomes. */
export interface NoveltyReplenishment {
  user_id: string;
  mission_id: string | null;
  before: number;
  after: number;
  applied: number;
  coverage_component: number;
  waste_component: number;
  useful_component: number;
  bound: number;
  basis: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkKeys(
  row: Record<string, unknown>,
  required: ReadonlyArray<[string, (value: unknown) => boolean, string]>,
): string[] {
  const errors: string[] = [];
  for (const [key, test, expectation] of required) {
    if (!test(row[key])) errors.push(`${key} ${expectation}`);
  }
  return errors;
}

const isStringOrNull = (value: unknown): boolean => value === null || typeof value === 'string';
const isCount = (value: unknown): boolean => Number.isInteger(value) && Number(value) >= 0;
const isSlug = (value: unknown): boolean => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);
const isIsoish = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Validate one persisted failure signature (bounds included). */
export function validateFailureSignature(row: unknown): ValidationResult {
  if (!row || typeof row !== 'object') return { valid: false, errors: ['row is not an object'] };
  const record = row as Record<string, unknown>;
  const errors = checkKeys(record, [
    ['signature_id', isNonEmptyString, 'must be a non-empty string'],
    ['user_id', isNonEmptyString, 'must be a non-empty string'],
    ['mission_id', isNonEmptyString, 'must be a non-empty string'],
    ['signature', isSlug, 'must be a lowercase slug'],
    ['seed_id', isStringOrNull, 'must be a string or null'],
    ['operator', isStringOrNull, 'must be a string or null'],
    ['count', isCount, 'must be a non-negative integer'],
    ['first_seen_at', isIsoish, 'must be an ISO timestamp'],
    ['last_seen_at', isIsoish, 'must be an ISO timestamp'],
  ]);
  if (Number(record.count) > ITER11_ARTIFACT_BOUNDS.max_failure_signatures * 1000) {
    errors.push(`count ${record.count} exceeds the documented sanity bound`);
  }
  if (record.detail !== null && record.detail !== undefined && String(record.detail).length > ITER11_ARTIFACT_BOUNDS.max_detail_chars) {
    errors.push(`detail exceeds ${ITER11_ARTIFACT_BOUNDS.max_detail_chars} characters`);
  }
  return { valid: errors.length === 0, errors };
}

/** Validate one trace-ready salience input (numbers only, never text). */
export function validateTraceReadySalienceInput(row: unknown): ValidationResult {
  if (!row || typeof row !== 'object') return { valid: false, errors: ['row is not an object'] };
  const record = row as Record<string, unknown>;
  const errors = checkKeys(record, [
    ['input_id', isNonEmptyString, 'must be a non-empty string'],
    ['user_id', isNonEmptyString, 'must be a non-empty string'],
    ['mission_id', isStringOrNull, 'must be a string or null'],
    ['meta_state', isNonEmptyString, 'must be a non-empty string'],
    ['score', (value) => Number.isFinite(Number(value)), 'must be a finite number'],
    ['threshold', (value) => Number.isFinite(Number(value)), 'must be a finite number'],
    ['tier', (value) => value === 'high' || value === 'medium' || value === 'low', 'must be high|medium|low'],
    ['created_at', isIsoish, 'must be an ISO timestamp'],
  ]);
  for (const key of ['signals', 'weights'] as const) {
    const value = record[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${key} must be an object of numbers`);
      continue;
    }
    for (const [name, amount] of Object.entries(value as Record<string, unknown>)) {
      if (!Number.isFinite(Number(amount))) errors.push(`${key}.${name} is not a number`);
    }
  }
  // Numbers only: a statement or narrative field would make this row a carrier
  // for private text, which is exactly what "trace-ready inputs" must not be.
  for (const forbidden of ['statement', 'narrative', 'text', 'reflection', 'journal']) {
    if (forbidden in record) errors.push(`row carries a '${forbidden}' field — trace-ready inputs are numbers only`);
  }
  return { valid: errors.length === 0, errors };
}

/** Validate one novelty-drive adjustment record. */
export function validateNoveltyReplenishment(row: unknown): ValidationResult {
  if (!row || typeof row !== 'object') return { valid: false, errors: ['row is not an object'] };
  const record = row as Record<string, unknown>;
  const errors = checkKeys(record, [
    ['user_id', isNonEmptyString, 'must be a non-empty string'],
    ['mission_id', isStringOrNull, 'must be a string or null'],
    ['before', (value) => Number.isFinite(Number(value)), 'must be a finite number'],
    ['after', (value) => Number.isFinite(Number(value)), 'must be a finite number'],
    ['applied', (value) => Number.isFinite(Number(value)), 'must be a finite number'],
    ['bound', (value) => Number.isFinite(Number(value)) && Number(value) > 0, 'must be a positive number'],
  ]);
  if (Math.abs(Number(record.applied)) > Number(record.bound) + 1e-9) {
    errors.push(`applied ${record.applied} exceeds its own bound ${record.bound}`);
  }
  return { valid: errors.length === 0, errors };
}

/** Validate one personality delta proposal row. */
export function validateDeltaProposalRow(row: unknown): ValidationResult {
  if (!row || typeof row !== 'object') return { valid: false, errors: ['row is not an object'] };
  const record = row as Record<string, unknown>;
  const errors = checkKeys(record, [
    ['proposal_id', isNonEmptyString, 'must be a non-empty string'],
    ['user_id', isNonEmptyString, 'must be a non-empty string'],
    ['status', (value) => value === 'proposed' || value === 'refused', 'must be proposed|refused'],
    ['dimension', isStringOrNull, 'must be a string or null'],
    ['applied', (value) => value === false, 'must be false (a proposal is never applied autonomously)'],
    ['autonomous_application', (value) => value === 'forbidden', "must be 'forbidden'"],
    ['created_at', isIsoish, 'must be an ISO timestamp'],
  ]);
  return { valid: errors.length === 0, errors };
}

/** Validate one counted deprecation-telemetry row. */
export function validateDeprecationEventRow(row: unknown): ValidationResult {
  if (!row || typeof row !== 'object') return { valid: false, errors: ['row is not an object'] };
  const record = row as Record<string, unknown>;
  const errors = checkKeys(record, [
    ['event_key', isNonEmptyString, 'must be a non-empty string'],
    ['user_id', isNonEmptyString, 'must be a non-empty string'],
    ['kind', (value) => value === 'legacy_read' || value === 'no_user_id_path' || value === 'legacy_write', 'must be a known kind'],
    ['count', (value) => Number.isInteger(value) && Number(value) >= 1, 'must be an integer ≥ 1'],
    ['first_seen_at', isIsoish, 'must be an ISO timestamp'],
    ['last_seen_at', isIsoish, 'must be an ISO timestamp'],
    ['expires_at', isIsoish, 'must be an ISO timestamp (the row is TTL-able)'],
  ]);
  if (isIsoish(record.first_seen_at) && isIsoish(record.expires_at) && Date.parse(String(record.expires_at)) <= Date.parse(String(record.first_seen_at))) {
    errors.push('expires_at must be after first_seen_at');
  }
  return { valid: errors.length === 0, errors };
}
