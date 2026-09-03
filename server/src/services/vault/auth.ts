/**
 * Katra Vault — TOTP enrollment, sessions and per-identity policy (F9)
 *
 * The auth MECHANISM per docs/katra-vault-design.md §8/§9: encrypted
 * per-identity TOTP enrollment (stored via the F2 vault store as private
 * `totp_secret` envelopes — never plaintext at rest), RFC 6238 session
 * issuance with a per-identity replay guard, short-lived bearer sessions
 * stored as SHA-256 hashes only, revocation, caller-scoped listing, and the
 * per-identity auth policy table (defaults + `system_settings.auth_policy`
 * overrides, cached ≤60 s).
 *
 * ENFORCEMENT (requiring sessions on the existing MCP/REST paths) is a
 * separate cutover step — this module only delivers the mechanism and the
 * policy lookup (`require_totp` defaults to false; John flips it when the
 * team is enrolled).
 *
 * Hard rules (violation = FAIL):
 *  - The TOTP secret appears only inside the sealed envelope; the raw token
 *    and the otpauth URI are returned exactly once (at enrollment / issue)
 *    and are NEVER console.logged. `auth_sessions` stores SHA-256 hashes
 *    only — never tokens.
 *  - Replay: every issued session doc carries the verified TOTP
 *    `last_counter`, and a UNIQUE SPARSE index on (identity, last_counter)
 *    makes each code claimable at most once — MongoDB enforces the claim
 *    ATOMICALLY at insert time (duplicate key ⇒ the code was already used;
 *    even two concurrent same-code requests cannot both mint). Reuse within
 *    the same step AND any older counter are refused.
 *  - Every enroll/issue/revoke attempt writes exactly ONE value-free
 *    `vault_audit` row (action 'totp_enroll' | 'session_issue' |
 *    'session_revoke', outcome ok|denied|error, keys ⊆ the F2 whitelist
 *    {at, actor, action, secret_id, service, outcome, error}).
 *  - Static reason strings only — no echoed input, no secret material.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Db } from 'mongodb';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { get_database } from '../../database/connection.js';
import { createVaultStore, type VaultStore } from './store.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

// ── Policy ─────────────────────────────────────────────────────────────────

export interface AuthPolicy {
  class: 'interactive' | 'unattended' | 'trusted';
  require_totp: boolean;
  session_ttl_hours: number;
}

const INTERACTIVE: AuthPolicy = Object.freeze({
  class: 'interactive',
  require_totp: false,
  session_ttl_hours: 12,
});
const UNATTENDED: AuthPolicy = Object.freeze({
  class: 'unattended',
  require_totp: false,
  session_ttl_hours: 720, // device-bound long-lived sessions (design §8)
});
const TRUSTED: AuthPolicy = Object.freeze({
  class: 'trusted',
  require_totp: false,
  session_ttl_hours: 12,
});

/**
 * Per-identity default policy table (design §8): interactive humans
 * (shoshin/zanshin/lilly — plus the interactive fallback identity),
 * unattended agents (satori heartbeat, gas-law-watcher), trusted operators
 * (loopback / admin key). `require_totp` is FALSE for everyone by default —
 * enforcement is the separate cutover step.
 */
export const DEFAULT_AUTH_POLICY: Record<string, AuthPolicy> = {
  // Interactive — laptops/iMac, human present.
  shoshin: INTERACTIVE,
  zanshin: INTERACTIVE,
  lilly: INTERACTIVE,
  'satori-interactive-default': INTERACTIVE,
  // Unattended — device-bound, narrow scope, 720 h sessions.
  satori: UNATTENDED,
  'gas-law-watcher': UNATTENDED,
  // Trusted — loopback / admin key (thebrick).
  loopback: TRUSTED,
  admin: TRUSTED,
};

/** Identity not listed in the table → interactive default (12 h). */
const FALLBACK_POLICY: AuthPolicy = INTERACTIVE;

/** Overrides come from system_settings doc { key: 'auth_policy',
 *  overrides: { [identity]: { class?, require_totp?, session_ttl_hours? } } }. */
const POLICY_SETTINGS_KEY = 'auth_policy';
const POLICY_SETTINGS_COLLECTION = 'system_settings';
/** Cache TTL — contract: ≤60 s. */
const POLICY_CACHE_TTL_MS = 60_000;

export type AuthPolicyOverride = Partial<AuthPolicy>;

/** Cached per-identity override map ({} when unset / unavailable). */
let policyOverrides: Record<string, AuthPolicyOverride> | null = null;
let policyLoadedAt = 0;
let policyRefreshInFlight: Promise<void> | null = null;

/** Validate a raw override value: keeps only well-formed fields. */
function sanitizePolicyOverride(raw: unknown): AuthPolicyOverride | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: AuthPolicyOverride = {};
  if (r.class === 'interactive' || r.class === 'unattended' || r.class === 'trusted') {
    out.class = r.class;
  }
  if (typeof r.require_totp === 'boolean') out.require_totp = r.require_totp;
  if (
    typeof r.session_ttl_hours === 'number' &&
    Number.isFinite(r.session_ttl_hours) &&
    r.session_ttl_hours > 0
  ) {
    out.session_ttl_hours = r.session_ttl_hours;
  }
  return out;
}

/** Read the override map from system_settings (never throws). */
async function loadPolicyOverrides(): Promise<Record<string, AuthPolicyOverride>> {
  try {
    const db = get_database();
    const doc = (await db
      .collection(POLICY_SETTINGS_COLLECTION)
      .findOne({ key: POLICY_SETTINGS_KEY })) as Record<string, unknown> | null;
    const raw = doc?.overrides;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, AuthPolicyOverride> = {};
    for (const [identity, value] of Object.entries(raw as Record<string, unknown>)) {
      if (identity.length === 0) continue;
      const clean = sanitizePolicyOverride(value);
      if (clean !== null && Object.keys(clean).length > 0) out[identity] = clean;
    }
    return out;
  } catch {
    return {}; // DB unavailable → defaults only
  }
}

/** Force a fresh read of the override map into the cache (single-flight).
 *  Exported so operators/tests can apply a change immediately instead of
 *  waiting out the ≤60 s TTL. */
export async function refreshAuthPolicyCache(): Promise<void> {
  if (policyRefreshInFlight) return policyRefreshInFlight;
  policyRefreshInFlight = (async () => {
    policyOverrides = await loadPolicyOverrides();
    policyLoadedAt = Date.now();
  })();
  try {
    await policyRefreshInFlight;
  } finally {
    policyRefreshInFlight = null;
  }
}

/**
 * Resolve the effective auth policy for an identity: DEFAULT_AUTH_POLICY
 * entry (or the interactive fallback) merged with any
 * `system_settings.auth_policy` overrides. Synchronous — a stale/empty
 * cache kicks off a background refresh and serves the last known state
 * (≤60 s propagation lag, per contract).
 */
export function getAuthPolicy(identity: string): AuthPolicy {
  const base = DEFAULT_AUTH_POLICY[identity] ?? FALLBACK_POLICY;
  if (policyOverrides === null || Date.now() - policyLoadedAt > POLICY_CACHE_TTL_MS) {
    void refreshAuthPolicyCache();
  }
  const override = policyOverrides?.[identity];
  if (!override) return base;
  return {
    class: override.class ?? base.class,
    require_totp: override.require_totp ?? base.require_totp,
    session_ttl_hours: override.session_ttl_hours ?? base.session_ttl_hours,
  };
}

// ── Auth service ───────────────────────────────────────────────────────────

const SECRET_NAME = 'auth-totp';
const SECRET_SERVICE = 'auth';
const SESSIONS_COLLECTION = 'auth_sessions';
const AUDIT_COLLECTION = 'vault_audit';
const HOUR_MS = 3_600_000;
const TOKEN_BYTES = 32;
const PREFIX_MIN_LENGTH = 8;

/** Static reason strings — never echo submitted input. */
const REASON_OPERATOR_ONLY = 'operator only';
const REASON_INVALID_IDENTITY = 'invalid identity';
const REASON_NOT_ENROLLED = 'not enrolled';
const REASON_INVALID_CODE = 'invalid TOTP code';
const REASON_NOT_FOUND = 'session not found';
const REASON_EXPIRED = 'session expired';
const REASON_REVOKED = 'session revoked';

export interface AuthService {
  enrollTotp(op: {
    caller: CallerIdentity;
    identity?: string;
    issuer?: string;
  }): Promise<{
    enrolled: boolean;
    identity: string;
    otpauth_uri: string | null;
    secret_id: string | null;
    reason?: string;
  }>;
  issueSession(op: {
    caller: CallerIdentity;
    identity?: string;
    totpCode: string;
  }): Promise<{
    issued: boolean;
    token: string | null;
    expires_at: string | null;
    reason?: string;
  }>;
  validateSession(token: string): Promise<{
    valid: boolean;
    identity: string | null;
    reason?: string;
  }>;
  revokeSession(op: {
    caller: CallerIdentity;
    tokenHashOrPrefix?: string;
  }): Promise<{ revoked: number }>;
  listSessions(
    caller: CallerIdentity,
  ): Promise<
    Array<{
      created_at: string;
      expires_at: string;
      revoked_at: string | null;
      identity?: string;
    }>
  >;
}

export interface AuthServiceOptions {
  /** Vault store the enrollment envelopes go through (default: shared). */
  store?: VaultStore;
  /** Sessions collection (default 'auth_sessions'; test injection). */
  sessionsCollection?: string;
  /** Audit collection — MUST match the injected store's audit collection
   *  (default 'vault_audit'). */
  auditCollection?: string;
  /** Injectable clock in ms (default Date.now). */
  now?: () => number;
  /** DB for the sessions/audit collections (default get_database()). */
  db?: Db;
}

/** Mirror of the store's internal writeAudit helper (F7 pattern): one
 *  value-free row, error key only when outcome !== 'ok', keys ⊆ the F2
 *  whitelist. Audit failures never leak and never change the result. */
function auditWriter(db: Db, collection: string) {
  return async function writeAudit(row: {
    at: string;
    actor: string;
    action: 'totp_enroll' | 'session_issue' | 'session_revoke';
    secret_id: string | null;
    outcome: 'ok' | 'denied' | 'error';
    error?: string;
  }): Promise<void> {
    try {
      const { error, ...rest } = row;
      const doc: Record<string, unknown> = { service: SECRET_SERVICE, ...rest };
      if (row.outcome !== 'ok') doc.error = error ?? row.outcome;
      await db.collection(collection).insertOne(doc);
    } catch {
      /* never leak; never throw */
    }
  };
}

function requireCaller(caller: CallerIdentity): CallerIdentity {
  if (
    !caller ||
    typeof caller.user_id !== 'string' ||
    caller.user_id.length === 0 ||
    typeof caller.trusted !== 'boolean'
  ) {
    throw new Error('vault: invalid caller identity');
  }
  return caller;
}

/** Identity: non-empty, ≤128 chars, no '/'. */
function requireIdentity(identity: unknown): string | null {
  if (typeof identity !== 'string' || identity.length === 0) return null;
  if (identity.length > 128 || identity.includes('/')) return null;
  return identity;
}

export function createAuthService(opts: AuthServiceOptions = {}): AuthService {
  const db: Db = opts.db ?? get_database();
  const sessionsCol = db.collection(opts.sessionsCollection ?? SESSIONS_COLLECTION);
  const auditCollectionName = opts.auditCollection ?? AUDIT_COLLECTION;
  const store: VaultStore = opts.store ?? createVaultStore();
  const now: () => number = opts.now ?? Date.now;
  const writeAudit = auditWriter(db, auditCollectionName);

  function sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  return {
    async enrollTotp(op) {
      const caller = requireCaller(op.caller);
      const at = new Date(now()).toISOString();
      const identity = requireIdentity(op.identity ?? caller.user_id);
      const actor = caller.user_id;
      // Operator-only for OTHER identities; self-enrollment is the caller's
      // own private partition (untrusted callers stay IDOR-pinned by the store).
      if (identity === null) {
        await writeAudit({
          at,
          actor,
          action: 'totp_enroll',
          secret_id: null,
          outcome: 'denied',
          error: REASON_INVALID_IDENTITY,
        });
        return {
          enrolled: false,
          identity: String(op.identity ?? caller.user_id),
          otpauth_uri: null,
          secret_id: null,
          reason: REASON_INVALID_IDENTITY,
        };
      }
      if (identity !== caller.user_id && !caller.trusted) {
        await writeAudit({
          at,
          actor,
          action: 'totp_enroll',
          secret_id: null,
          outcome: 'denied',
          error: REASON_OPERATOR_ONLY,
        });
        return {
          enrolled: false,
          identity,
          otpauth_uri: null,
          secret_id: null,
          reason: REASON_OPERATOR_ONLY,
        };
      }

      // Fresh secret, sealed via the F2 store (scope private → the identity's
      // own partition; upsert overwrite = re-enrollment with a NEW secret).
      const secret = generateTotpSecret();
      const secretId = `${identity}/${SECRET_NAME}`;
      try {
        await store.putSecret({
          caller,
          name: SECRET_NAME,
          value: secret,
          scope: 'private',
          service: SECRET_SERVICE,
          kind: 'totp_secret',
          approvalRequired: false,
          rotatable: false,
          ownerUserId: identity,
        });
      } catch (error) {
        await writeAudit({
          at,
          actor,
          action: 'totp_enroll',
          secret_id: secretId,
          outcome: 'error',
          error: error instanceof Error ? error.message : 'enrollment failed',
        });
        throw error;
      }
      await writeAudit({
        at,
        actor,
        action: 'totp_enroll',
        secret_id: secretId,
        outcome: 'ok',
      });
      return {
        enrolled: true,
        identity,
        otpauth_uri: otpauthUri(identity, secret, op.issuer),
        secret_id: secretId,
      };
    },

    async issueSession(op) {
      const caller = requireCaller(op.caller);
      const at = new Date(now()).toISOString();
      const identity = requireIdentity(op.identity ?? caller.user_id);
      const actor = caller.user_id;
      if (identity === null) {
        await writeAudit({
          at,
          actor,
          action: 'session_issue',
          secret_id: null,
          outcome: 'denied',
          error: REASON_INVALID_IDENTITY,
        });
        return {
          issued: false,
          token: null,
          expires_at: null,
          reason: REASON_INVALID_IDENTITY,
        };
      }
      // Open the identity's TOTP envelope: RBAC (own partition or operator)
      // is enforced by the store's openSecretValue.
      const secretId = `${identity}/${SECRET_NAME}`;
      if (identity !== caller.user_id && !caller.trusted) {
        await writeAudit({
          at,
          actor,
          action: 'session_issue',
          secret_id: null,
          outcome: 'denied',
          error: REASON_OPERATOR_ONLY,
        });
        return {
          issued: false,
          token: null,
          expires_at: null,
          reason: REASON_OPERATOR_ONLY,
        };
      }
      const code = typeof op.totpCode === 'string' ? op.totpCode.trim() : '';
      let secret: string;
      try {
        secret = await store.openSecretValue(caller, secretId);
      } catch (error) {
        // Not found → the identity has no enrollment yet.
        if (error instanceof Error && error.message.includes('not found')) {
          await writeAudit({
            at,
            actor,
            action: 'session_issue',
            secret_id: secretId,
            outcome: 'denied',
            error: REASON_NOT_ENROLLED,
          });
          return {
            issued: false,
            token: null,
            expires_at: null,
            reason: REASON_NOT_ENROLLED,
          };
        }
        await writeAudit({
          at,
          actor,
          action: 'session_issue',
          secret_id: secretId,
          outcome: 'error',
          error: error instanceof Error ? error.message : 'issue failed',
        });
        throw error;
      }
      if (code.length === 0) {
        await writeAudit({
          at,
          actor,
          action: 'session_issue',
          secret_id: secretId,
          outcome: 'denied',
          error: REASON_INVALID_CODE,
        });
        return { issued: false, token: null, expires_at: null, reason: REASON_INVALID_CODE };
      }

      // Replay guard: the session doc ITSELF is the replay claim. verifyTotp
      // runs over the ±1 window with NO lastCounter — the first claim of a
      // given counter mints a session carrying `last_counter`; the unique
      // sparse index on (identity, last_counter) makes any SECOND claim of
      // the same counter (sequential or concurrent) fail atomically at
      // insertOne with a duplicate-key error. There is no separate counter
      // doc and no check-then-act race.
      const verified = verifyTotp(secret, code, { time: now() / 1000 });
      if (!verified.ok) {
        await writeAudit({
          at,
          actor,
          action: 'session_issue',
          secret_id: secretId,
          outcome: 'denied',
          error: REASON_INVALID_CODE,
        });
        return { issued: false, token: null, expires_at: null, reason: REASON_INVALID_CODE };
      }

      const policy = getAuthPolicy(identity);
      const ttlMs = policy.session_ttl_hours * HOUR_MS;
      const createdMs = now();
      const expiresAt = new Date(createdMs + ttlMs).toISOString();
      // 32 random bytes → base64url; ONLY the SHA-256 hash is persisted.
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const tokenHash = sha256Hex(token);
      try {
        await sessionsCol.insertOne({
          kind: 'session',
          token_hash: tokenHash,
          identity,
          created_at: new Date(createdMs).toISOString(),
          expires_at: expiresAt,
          revoked_at: null,
          last_counter: verified.counter,
        });
      } catch (error) {
        // Duplicate key (code 11000) on (identity, last_counter) → this TOTP
        // counter was already claimed by an earlier session: replay. Mongo
        // enforced the claim at insert time, so nothing was minted — one
        // denied audit row, static reason, no session.
        const isDuplicate =
          (typeof error === 'object' &&
            error !== null &&
            (error as { code?: unknown }).code === 11000) ||
          (error instanceof Error && error.message.includes('E11000'));
        if (isDuplicate) {
          await writeAudit({
            at,
            actor,
            action: 'session_issue',
            secret_id: secretId,
            outcome: 'denied',
            error: REASON_INVALID_CODE,
          });
          return { issued: false, token: null, expires_at: null, reason: REASON_INVALID_CODE };
        }
        await writeAudit({
          at,
          actor,
          action: 'session_issue',
          secret_id: secretId,
          outcome: 'error',
          error: error instanceof Error ? error.message : 'issue failed',
        });
        throw error;
      }
      await writeAudit({
        at,
        actor,
        action: 'session_issue',
        secret_id: secretId,
        outcome: 'ok',
      });
      return { issued: true, token, expires_at: expiresAt };
    },

    async validateSession(token) {
      if (typeof token !== 'string' || token.length === 0) {
        return { valid: false, identity: null, reason: REASON_NOT_FOUND };
      }
      const doc = (await sessionsCol.findOne({
        kind: 'session',
        token_hash: sha256Hex(token),
      })) as Record<string, unknown> | null;
      if (doc === null) return { valid: false, identity: null, reason: REASON_NOT_FOUND };
      if (typeof doc.revoked_at === 'string' && doc.revoked_at.length > 0) {
        return { valid: false, identity: null, reason: REASON_REVOKED };
      }
      if (typeof doc.expires_at !== 'string' || Date.parse(doc.expires_at) <= now()) {
        return { valid: false, identity: null, reason: REASON_EXPIRED };
      }
      return { valid: true, identity: (doc.identity as string) ?? null };
    },

    async revokeSession(op) {
      const caller = requireCaller(op.caller);
      const at = new Date(now()).toISOString();
      const raw = typeof op.tokenHashOrPrefix === 'string' ? op.tokenHashOrPrefix.trim() : '';
      // Exact hash (64 hex) or a hash PREFIX of ≥8 characters.
      const prefix = raw.length >= PREFIX_MIN_LENGTH ? raw : null;
      const filter: Record<string, unknown> = {
        kind: 'session',
        ...(prefix !== null
          ? { token_hash: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } }
          : { token_hash: raw }),
      };
      // Untrusted callers may revoke their OWN sessions only; operators any.
      if (!caller.trusted) filter.identity = caller.user_id;

      const result = await sessionsCol.updateMany(filter, {
        $set: { revoked_at: at },
      });
      const revoked = result.modifiedCount;
      await writeAudit({
        at,
        actor: caller.user_id,
        action: 'session_revoke',
        secret_id: null,
        outcome: revoked > 0 ? 'ok' : 'denied',
        ...(revoked === 0 ? { error: REASON_NOT_FOUND } : {}),
      });
      return { revoked };
    },

    async listSessions(caller) {
      const c = requireCaller(caller);
      const filter: Record<string, unknown> = { kind: 'session' };
      if (!c.trusted) filter.identity = c.user_id;
      const rows = await sessionsCol
        .find(filter, {
          projection: { _id: 0, identity: 1, created_at: 1, expires_at: 1, revoked_at: 1 },
        })
        .sort({ created_at: -1, _id: -1 })
        .toArray();
      // Caller sees own sessions only (identity implied); operators see all
      // rows with the identity included.
      return rows.map((r) => {
        const row = r as unknown as Record<string, unknown>;
        const base = {
          created_at: row.created_at as string,
          expires_at: row.expires_at as string,
          revoked_at: (typeof row.revoked_at === 'string' ? row.revoked_at : null) as
            | string
            | null,
        };
        return c.trusted ? { identity: row.identity as string, ...base } : base;
      });
    },
  };
}
