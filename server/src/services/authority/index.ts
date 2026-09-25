/**
 * Authority service — facade.
 *
 * Public surface for action authority in the Katra server. Everything else in the
 * codebase should import from here rather than reaching into the individual modules.
 *
 * Usage:
 *
 *   // Advisory classification of a free-text subject
 *   import { gateAction, inferAuthority } from '../authority/index.js';
 *   const decision = gateAction('github.com/kolegadev/blasted');
 *   if (!decision.canExecute) reportOnly(decision.instruction);
 *
 *   // Authoritative resolution for cognitive-control records
 *   import { resolveEffectiveClass } from '../authority/index.js';
 *   const { effectiveClass } = resolveEffectiveClass(declaredClass, callerCtx);
 *
 * Review ref: REVIEW-long-horizon-cognitive-control.md sections 3.4 and 4.1.
 */

import { SCOPE_MATRIX, UNKNOWN_SCOPE, isAutonomous, matchScope } from './matrix.js';
import { AUTONOMY_TO_CLASS, CLASS_TO_AUTONOMY } from './types.js';
import type {
  AuthorityClass,
  AuthorityDecision,
  Autonomy,
  ClassificationSource,
  ScopeRule,
} from './types.js';

export * from './types.js';
export * from './matrix.js';
export * from './caller.js';

/** Canonical matrix row per autonomy level, so instruction text is reused verbatim. */
const ROW_BY_AUTONOMY: Record<Autonomy, ScopeRule> = {
  autonomous: SCOPE_MATRIX.find(r => r.autonomy === 'autonomous') ?? UNKNOWN_SCOPE,
  gated: SCOPE_MATRIX.find(r => r.autonomy === 'gated') ?? UNKNOWN_SCOPE,
  cautious: SCOPE_MATRIX.find(r => r.autonomy === 'cautious') ?? UNKNOWN_SCOPE,
};

function buildDecision(
  subject: string,
  scope: string,
  autonomy: Autonomy,
  source: ClassificationSource,
  instruction: string,
  failureCondition: string,
): AuthorityDecision {
  return {
    subject,
    scope,
    authorityClass: AUTONOMY_TO_CLASS[autonomy],
    autonomy,
    canExecute: isAutonomous(autonomy),
    requiresApproval: autonomy === 'gated',
    shouldInspectFirst: autonomy === 'cautious' || autonomy === 'gated',
    instruction,
    failureCondition,
    source,
  };
}

/**
 * Classify a subject by pattern inference alone.
 *
 * ADVISORY. Use for a default suggestion, logging, or a first-pass gate on low-stakes
 * work. Do NOT use this as the authority of record for anything with an external effect —
 * it matches substrings and can be talked around by phrasing.
 */
export function inferAuthority(subject: string, thread = ''): AuthorityDecision {
  const scope = matchScope(subject, thread);
  const source: ClassificationSource = scope === UNKNOWN_SCOPE ? 'default' : 'inferred';
  return buildDecision(
    subject,
    scope.name,
    scope.autonomy,
    source,
    scope.mandatoryAction,
    scope.failureCondition,
  );
}

/**
 * Full action gate — the ported `gate_action()` from the Python original.
 * Returns the authority decision plus the mandatory instruction.
 */
export function gateAction(subject: string, thread = ''): AuthorityDecision {
  return inferAuthority(subject, thread);
}

/**
 * Build an authoritative decision from an EXPLICITLY DECLARED class.
 *
 * Declaration wins over inference, because the point of a declared class is that a human
 * stated the intent for this piece of work. Whether the *caller* was permitted to declare
 * it is a separate question, answered by resolveEffectiveClass() in caller.ts.
 */
export function declaredAuthority(
  subject: string,
  declared: AuthorityClass,
): AuthorityDecision {
  const autonomy = CLASS_TO_AUTONOMY[declared];
  const row = ROW_BY_AUTONOMY[autonomy];
  return buildDecision(
    subject,
    row.name,
    autonomy,
    'declared',
    row.mandatoryAction,
    row.failureCondition,
  );
}

/**
 * Resolve the authority of record for a piece of work.
 *
 * Order of precedence, most authoritative first:
 *   1. an explicit declaration (clamped to the caller's ceiling — see caller.ts)
 *   2. pattern inference from the subject text
 *   3. deny-by-default (class B)
 *
 * Returns the decision plus how it was arrived at (`source`), so it can be written to an
 * audit record.
 */
export function resolveAuthority(
  subject: string,
  declared: AuthorityClass | undefined,
): AuthorityDecision {
  if (declared) return declaredAuthority(subject, declared);
  return inferAuthority(subject);
}
