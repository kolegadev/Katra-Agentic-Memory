/**
 * Authority — MCP caller rules.
 *
 * Closes review finding 4.1. The design specifies A/B/C authority for the *autonomous
 * loop*, but the new cognitive-control tools are called over MCP by external agents.
 * It never says whether an untrusted caller may create work items, submit deltas, or
 * declare `authority_class: A`. That is a security boundary and it is specified here.
 *
 * This reuses the trust semantics the server ALREADY has — it does not invent a parallel
 * scheme. Per docs/MCP-TOOLS.md:
 *   - trusted callers (loopback 127.0.0.1/::1, and the admin key KATRA_API_KEY) may supply
 *     `user_id` and act on behalf of any identity;
 *   - untrusted callers (a client key mapped in system_settings.client_keys) are pinned to
 *     their own identity for every scoped read and write, and a supplied `user_id` is ignored.
 *
 * The two rules that matter here:
 *   1. An untrusted caller may NEVER declare authority class A. A caller cannot escalate
 *      its own authority by writing a field.
 *   2. Declaration may only ever RESTRICT, never expand, the authority a caller already has.
 *      The effective class is the most restrictive of (declared, permitted).
 */

import type { AuthorityClass, Autonomy, CallerTrust } from './types.js';
import { AUTONOMY_TO_CLASS, CLASS_TO_AUTONOMY } from './types.js';

/** Class A is the only class that acts without a gate. Order is most -> least permissive. */
const PERMISSIVENESS: Record<AuthorityClass, number> = { A: 2, B: 1, C: 0 };

export interface CallerAuthorityContext {
  /** Trust level, established by the auth layer — never from the payload. */
  trust: CallerTrust;
  /** Resolved caller identity, from authenticated context — never from the payload. */
  callerId: string;
  /** The caller's own ceiling, if the server has one configured. Defaults by trust. */
  permittedClass?: AuthorityClass;
}

export interface DeclaredClassCheck {
  /** The class that will actually be enforced. */
  effectiveClass: AuthorityClass;
  autonomy: Autonomy;
  /** True when the caller asked for more than it is allowed and we clamped it. */
  clamped: boolean;
  /** Human-readable reason, suitable for an audit record or a tool error. */
  reason: string;
}

/** The most restrictive of two classes. */
export function moreRestrictive(a: AuthorityClass, b: AuthorityClass): AuthorityClass {
  return PERMISSIVENESS[a] <= PERMISSIVENESS[b] ? a : b;
}

/**
 * What class may this caller ever operate at, before any declaration?
 *
 * Trusted callers may work at A (they are the machine, or the admin key).
 * Untrusted callers are capped at B: they may analyse and propose, but an external
 * key must never be able to drive ungated mutation of Katra's own substrate.
 */
export function permittedClassFor(ctx: CallerAuthorityContext): AuthorityClass {
  if (ctx.permittedClass) return ctx.permittedClass;
  return ctx.trust === 'trusted' ? 'A' : 'B';
}

/**
 * Resolve the class a mission / work item actually runs at.
 *
 * @param declared the `authority_class` the payload asked for, if any
 * @param ctx      the authenticated caller context
 *
 * A missing declaration does NOT mean "trust the payload" — it falls to the caller's
 * permitted class, which for an untrusted caller is B. Deny by default.
 */
export function resolveEffectiveClass(
  declared: AuthorityClass | undefined,
  ctx: CallerAuthorityContext,
): DeclaredClassCheck {
  const permitted = permittedClassFor(ctx);

  if (!declared) {
    return {
      effectiveClass: permitted,
      autonomy: CLASS_TO_AUTONOMY[permitted],
      clamped: false,
      reason: `no authority_class declared; defaulting to caller ceiling ${permitted}`,
    };
  }

  const effective = moreRestrictive(declared, permitted);
  const clamped = effective !== declared;

  return {
    effectiveClass: effective,
    autonomy: CLASS_TO_AUTONOMY[effective],
    clamped,
    reason: clamped
      ? `declared ${declared} exceeds caller ceiling ${permitted}; clamped to ${effective}`
      : `declared ${declared} accepted (within caller ceiling ${permitted})`,
  };
}

/**
 * May this caller take an action with an externally visible effect?
 *
 * Only trusted callers, and only at class A or B where the action itself is ungated.
 * Class C (system config) always requires inspection and, for material change, a gate —
 * regardless of caller trust.
 */
export function mayTakeExternalEffect(
  effective: AuthorityClass,
  ctx: CallerAuthorityContext,
): boolean {
  if (ctx.trust !== 'trusted') return false;
  return effective === 'A';
}

/**
 * Assert a payload is not attempting to act as another identity.
 *
 * The server already ignores a supplied `user_id` for untrusted callers (resolveUserId()).
 * This is the cognitive-control-layer equivalent: an untrusted caller may not author a
 * delta, claim, or decision as somebody else.
 */
export function assertCallerMayAuthorAs(
  ctx: CallerAuthorityContext,
  targetId: string,
): void {
  if (ctx.trust === 'trusted') return;
  if (ctx.callerId !== targetId) {
    throw new Error(
      `authority: caller '${ctx.callerId}' may not author cognitive-control records as '${targetId}'`,
    );
  }
}

/** Convenience: the autonomy word for a class, for logging and tool output. */
export function autonomyOf(cls: AuthorityClass): Autonomy {
  return CLASS_TO_AUTONOMY[cls];
}
