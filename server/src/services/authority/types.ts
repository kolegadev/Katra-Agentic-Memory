/**
 * Authority model — types.
 *
 * Single source of truth for action authority in the Katra server.
 *
 * Prior to this module the authority model existed ONLY as a Python helper
 * (scripts/python/authority_matrix.py) that the TypeScript server had no concept of
 * (`grep -i authority server/src` returned 0 hits). Mission State, work items, batons
 * and capabilities all carry authority classes server-side, so the server needs its own
 * authoritative implementation. Keeping two independent matrices would be a safety
 * hazard: they would diverge, and whichever was consulted last would become the real gate.
 *
 * Review ref: REVIEW-long-horizon-cognitive-control.md sections 3.4 and 4.1.
 */

/** The three authority classes, matching the schema enum used on missions et al. */
export type AuthorityClass = 'A' | 'B' | 'C';

/** The same three classes as the word used on capability `approval` fields. */
export type Autonomy = 'autonomous' | 'gated' | 'cautious';

/**
 * Class -> word mapping. The design's schemas use `A|B|C` on missions/work-items/batons
 * and `autonomous|gated|cautious` on capabilities. They are the same three things.
 */
export const CLASS_TO_AUTONOMY: Record<AuthorityClass, Autonomy> = {
  A: 'autonomous',
  B: 'gated',
  C: 'cautious',
};

export const AUTONOMY_TO_CLASS: Record<Autonomy, AuthorityClass> = {
  autonomous: 'A',
  gated: 'B',
  cautious: 'C',
};

/** A scope rule: a named region of activity with a default authority treatment. */
export interface ScopeRule {
  name: string;
  /** Substring patterns matched against the entity + thread text, lowercased. */
  patterns: string[];
  autonomy: Autonomy;
  /** What the agent MUST do when operating in this scope. */
  mandatoryAction: string;
  /** What constitutes a failure in this scope. */
  failureCondition: string;
}

/** How a piece of work was classified, and by what means. */
export type ClassificationSource = 'declared' | 'inferred' | 'default';

export interface AuthorityDecision {
  /** The subject being classified (entity name, or a mission description). */
  subject: string;
  /** Matched scope name, or 'Unknown' when nothing matched. */
  scope: string;
  authorityClass: AuthorityClass;
  autonomy: Autonomy;
  /** True only for class A. */
  canExecute: boolean;
  /** True for class B (and, for material changes, class C). */
  requiresApproval: boolean;
  /** True for B and C — inspect existing state before changing anything. */
  shouldInspectFirst: boolean;
  instruction: string;
  failureCondition: string;
  /** Whether this came from an explicit declaration, pattern inference, or the default. */
  source: ClassificationSource;
}

/** The trust level of an MCP caller, as established by the existing auth layer. */
export type CallerTrust = 'trusted' | 'untrusted';
