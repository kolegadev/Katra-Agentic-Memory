/**
 * Katra Vault — secret store layer (F2)
 *
 * Persists F1 envelopes in a MongoDB `secrets` collection with scope RBAC
 * (docs/katra-vault-design.md §4/§6) and writes a **value-free** audit trail
 * (`vault_audit`, §7.3). The store never sees plaintext at rest and never
 * logs it: values are sealed via F1 `sealSecret()` before insert and opened
 * via F1 `openSecret()` only inside `openSecretValue`/`rotateSecret`.
 *
 * Scope rules (mirroring services/memory machinery):
 *
 * - Write (putSecret) — `scope: 'private'` pins the owner to the caller's
 *   identity (`owner.user_id = caller.user_id`); `scope: 'team'` stores
 *   under `owner.shared_id = defaultSharedId` ('my-team'). The store
 *   interface has no owner-override channel, so an untrusted caller can
 *   never write into another identity's partition (IDOR guard). `aclReaders`
 *   is honored only for trusted callers — untrusted callers may only grant
 *   readers equal to their own identity, which is already implicit, so the
 *   grant is ignored (acl.readers stays []).
 * - Read (listSecrets / getSecretMeta) — mirror `buildScopeFilter`: a caller
 *   sees own private rows, team rows (`shared_id === defaultSharedId`) and
 *   rows naming them in `acl.readers`; trusted callers see everything
 *   (operator view).
 * - Delete / rotate — owner (`owner.user_id === caller.user_id`) or trusted.
 * - openSecretValue — owner / trusted / acl.readers member; the F6 hook.
 *   Sets `meta.last_used_at`; plaintext never leaves the function.
 * - Rotate re-seals with a FRESH DEK (new envelope) and sets
 *   `meta.rotation_due_at = now + 30 days`.
 *
 * Master key: `createVaultStore({ masterKeyHex })` or
 * `KATRA_VAULT_MASTER_KEY` (resolved per operation, so a store created
 * without either can still pick the key up from the env later). Without a
 * key, `putSecret` / `openSecretValue` (and `rotateSecret`, which must
 * decrypt to re-seal) throw `Error('vault: master key not configured')`;
 * list / get / delete work without it.
 *
 * Audit rows are exactly `{ at, actor, action, secret_id, service, outcome,
 * error? }` — never the value, plaintext, or envelope.
 *
 * F6 approvals: a `vault_approvals` collection of per-identity, per-service
 * grants (design §7.3 "Per-service approval"). grant/revoke are OPERATOR-only
 * (untrusted callers get `{ granted:false }` / `{ revoked:false }` plus a
 * value-free 'denied' audit row and NO row change); listing is caller-scoped;
 * `hasActiveApproval(identity, service)` honors the `'*'` wildcard and
 * `expires_at` (ISO, compared with Date.now()). Approval rows never carry
 * secret values, envelopes, or plaintext.
 */

import type { Db } from 'mongodb';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { get_database } from '../../database/connection.js';
import { openSecret, sealSecret } from './crypto.js';
import type { VaultEnvelope } from './crypto.js';

// ── Types (contract F2, data model §4) ────────────────────────────────────

export interface SecretRecord {
  /** "<owner>/<name>" (private) or "team:<shared_id>/<name>" (team). */
  secret_id: string;
  name: string;
  /** Exactly one of user_id / shared_id is set. */
  owner: { user_id?: string; shared_id?: string };
  /** Extra readers beyond the owner (default []). */
  acl: { readers: string[] };
  /** Service linking, e.g. "agentmail". */
  service: string | null;
  kind: 'api_key' | 'password' | 'token' | 'totp_secret' | 'env';
  /** Envelope from F1 crypto.ts. */
  envelope: VaultEnvelope;
  meta: {
    created_by: string;
    created_at: string;
    updated_at: string;
    last_used_at: string | null;
    rotation_due_at: string | null;
  };
  flags: { rotatable: boolean; approval_required: boolean };
}

/** What list/get may return — never carries the envelope or a value. */
export type SecretMeta = Omit<SecretRecord, 'envelope'>;

export interface PutSecretInput {
  caller: CallerIdentity;
  /** Non-empty, <= 128 chars, no '/'. */
  name: string;
  /** Non-empty secret value. */
  value: string;
  /** Default 'private'. */
  scope?: 'private' | 'team';
  service?: string | null;
  /** Default 'api_key'. */
  kind?: SecretRecord['kind'];
  /** Extra readers — trusted callers only (spec §6). */
  aclReaders?: string[];
  /** Default true. */
  approvalRequired?: boolean;
  /** Default true. */
  rotatable?: boolean;
  /** Owner override — honored ONLY when caller.trusted (private scope sets
   *  owner.user_id = ownerUserId); ignored for untrusted callers, who stay
   *  pinned to their own identity (F3, IDOR guard). */
  ownerUserId?: string;
}

export interface VaultStore {
  putSecret(input: PutSecretInput): Promise<{ secret_id: string; created: boolean }>;
  listSecrets(caller: CallerIdentity): Promise<SecretMeta[]>;
  getSecretMeta(caller: CallerIdentity, secretId: string): Promise<SecretMeta | null>;
  deleteSecret(caller: CallerIdentity, secretId: string): Promise<{ deleted: boolean }>;
  rotateSecret(caller: CallerIdentity, secretId: string): Promise<{ rotated: boolean }>;
  openSecretValue(caller: CallerIdentity, secretId: string): Promise<string>; // F6 hook — RBAC-guarded
  /** Caller-scoped audit trail: untrusted callers see only their own actor
   *  rows; trusted callers see everything. Newest first, default limit 100
   *  (F3). Rows are value-free by construction (§7.3). */
  listAudit(
    caller: CallerIdentity,
    opts?: { secretId?: string; limit?: number },
  ): Promise<AuditRow[]>;
  // ── F6 per-service approvals (design §7.3) ─────────────────────────────
  /** Operator-only: grant (or extend) an approval for (identity, service).
   *  Untrusted callers get `{ granted:false, approval:null }` — no row
   *  change, one 'denied' audit row. Default ttlDays 30. */
  grantApproval(op: {
    caller: CallerIdentity;
    identity: string;
    service: string;
    ttlDays?: number;
  }): Promise<{ granted: boolean; approval: ServiceApproval | null }>;
  /** Operator-only: revoke an active approval for (identity, service).
   *  Untrusted callers get `{ revoked:false }` — one 'denied' audit row. */
  revokeApproval(op: {
    caller: CallerIdentity;
    identity: string;
    service: string;
  }): Promise<{ revoked: boolean }>;
  /** Caller-scoped: untrusted callers see only their own identity's rows;
   *  trusted callers see all rows. Status is computed on read. */
  listApprovals(caller: CallerIdentity): Promise<ServiceApproval[]>;
  /** True when an ACTIVE (not revoked, not expired) approval exists for the
   *  identity — a `'*'` wildcard grant counts for any service. */
  hasActiveApproval(identity: string, service: string): Promise<boolean>;
}

// ── Internals ──────────────────────────────────────────────────────────────

const SECRETS_COLLECTION = 'secrets';
const AUDIT_COLLECTION = 'vault_audit';
const APPROVALS_COLLECTION = 'vault_approvals';
const DEFAULT_SHARED_ID = 'my-team';
const NAME_MAX_LENGTH = 128;
const ROTATION_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const MASTER_KEY_NOT_CONFIGURED = 'vault: master key not configured';
const ALLOWED_KINDS: ReadonlySet<string> = new Set([
  'api_key',
  'password',
  'token',
  'totp_secret',
  'env',
]);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_DAYS = 30;
const APPROVAL_TTL_MAX_DAYS = 3650;

/** A per-service approval (F6, data model §7.3). `_id` is never exposed;
 *  `status` is computed on read from revoked_at / expires_at vs Date.now(). */
export interface ServiceApproval {
  identity: string;
  service: string;
  granted_by: string;
  granted_at: string; // ISO
  expires_at: string; // ISO
  revoked_at: string | null; // ISO when revoked
  status: 'active' | 'revoked' | 'expired';
}

/** Audit row keys — never the value, plaintext, or envelope fields. F6
 *  approval rows carry action 'approval_grant' | 'approval_revoke' with
 *  secret_id null (value-free, whitelist keys only). */
export interface AuditRow {
  at: string;
  actor: string;
  action:
    | 'put'
    | 'delete'
    | 'rotate'
    | 'open'
    | 'approval_grant'
    | 'approval_revoke';
  secret_id: string | null;
  service: string | null;
  outcome: 'ok' | 'denied' | 'error';
  error?: string;
}

function vaultError(reason: string): Error {
  return new Error(`vault: ${reason}`);
}

function requireCaller(caller: CallerIdentity): CallerIdentity {
  if (
    !caller ||
    typeof caller.user_id !== 'string' ||
    caller.user_id.length === 0 ||
    typeof caller.trusted !== 'boolean'
  ) {
    throw vaultError('invalid caller identity');
  }
  return caller;
}

/** name: non-empty, <= 128 chars, no '/'. */
function requireName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw vaultError('secret name must be a non-empty string');
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw vaultError(`secret name exceeds ${NAME_MAX_LENGTH} characters`);
  }
  if (name.includes('/')) {
    throw vaultError('secret name must not contain "/"');
  }
  return name;
}

function requireValue(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw vaultError('secret value must be a non-empty string');
  }
}

/** Defensive owner pinning: an (untrusted) caller can never name another
 *  identity's partition — owner.user_id is always the caller's own identity,
 *  exactly as `resolveWriteScope` pins untrusted writers. The `ownerUserId`
 *  override exists ONLY for trusted callers (F3) and is resolved to the
 *  caller's own id before this function runs when untrusted. */
function pinOwner(
  scope: 'private' | 'team',
  sharedId: string,
  effectiveOwnerUserId: string,
): {
  owner: { user_id?: string; shared_id?: string };
  cryptoScope: string;
  secretIdPrefix: string;
} {
  if (scope === 'team') {
    return {
      owner: { shared_id: sharedId },
      cryptoScope: `shared:${sharedId}`,
      secretIdPrefix: `team:${sharedId}`,
    };
  }
  return {
    owner: { user_id: effectiveOwnerUserId },
    cryptoScope: `user:${effectiveOwnerUserId}`,
    secretIdPrefix: effectiveOwnerUserId,
  };
}

/** Untrusted callers may only grant readers equal to their own identity
 *  (already implicit as owner) — such grants are ignored. */
function resolveReaders(caller: CallerIdentity, requested: string[] | undefined): string[] {
  if (!caller.trusted || !Array.isArray(requested)) return [];
  return [...new Set(requested.filter((r) => typeof r === 'string' && r.length > 0))];
}

/** Resolve the effective owner for a private put (F3): untrusted callers are
 *  ALWAYS pinned to their own identity (any submitted ownerUserId is
 *  ignored — the IDOR guard); trusted callers may name another owner. */
function ownerUserIdForCaller(caller: CallerIdentity, requested: unknown): string {
  if (
    caller.trusted &&
    typeof requested === 'string' &&
    requested.length > 0
  ) {
    if (requested.includes('/')) {
      throw vaultError('ownerUserId must not contain "/"');
    }
    return requested;
  }
  return caller.user_id;
}

/** Read filter mirroring `buildScopeFilter`; trusted = operator view. */
function visibilityFilter(caller: CallerIdentity, sharedId: string): Record<string, unknown> {
  if (caller.trusted) return {};
  return {
    $or: [
      { 'owner.user_id': caller.user_id },
      { 'owner.shared_id': sharedId },
      { 'acl.readers': caller.user_id },
    ],
  };
}

type SecretDoc = SecretRecord; // rows are always read/written without _id

/** Map a raw DB row to SecretMeta with exactly the SecretMeta key set. */
function toSecretMeta(raw: Record<string, unknown>): SecretMeta {
  const { secret_id, name, owner, acl, service, kind, meta, flags } = raw;
  return {
    secret_id: secret_id as string,
    name: name as string,
    owner: owner as SecretRecord['owner'],
    acl: acl as SecretRecord['acl'],
    service: (service === undefined ? null : service) as string | null,
    kind: kind as SecretRecord['kind'],
    meta: meta as SecretRecord['meta'],
    flags: flags as SecretRecord['flags'],
  };
}

// ── F6 approval helpers ────────────────────────────────────────────────────

/** Approval identity: non-empty, <= 128 chars, no '/' (mirrors the F3
 *  ownerUserId rule — identities never compose a path). Static errors only. */
function requireApprovalIdentity(identity: unknown): string {
  if (typeof identity !== 'string' || identity.length === 0) {
    throw vaultError('approval identity must be a non-empty string');
  }
  if (identity.length > NAME_MAX_LENGTH) {
    throw vaultError(`approval identity exceeds ${NAME_MAX_LENGTH} characters`);
  }
  if (identity.includes('/')) {
    throw vaultError('approval identity must not contain "/"');
  }
  return identity;
}

/** Approval service: non-empty, <= 128 chars; '*' is the wildcard grant. */
function requireApprovalService(service: unknown): string {
  if (typeof service !== 'string' || service.length === 0) {
    throw vaultError('approval service must be a non-empty string');
  }
  if (service.length > NAME_MAX_LENGTH) {
    throw vaultError(`approval service exceeds ${NAME_MAX_LENGTH} characters`);
  }
  return service;
}

/** ttlDays: default 30; must be a positive finite number when provided. */
function resolveTtlDays(ttlDays: unknown): number {
  if (ttlDays === undefined || ttlDays === null) return DEFAULT_TTL_DAYS;
  if (typeof ttlDays !== 'number' || !Number.isFinite(ttlDays) || ttlDays < 1) {
    throw vaultError('ttlDays must be a positive number');
  }
  return Math.min(ttlDays, APPROVAL_TTL_MAX_DAYS);
}

/** Map a raw approval DB row to ServiceApproval — status computed on read
 *  (revoked_at set → 'revoked'; else expires_at <= now → 'expired'). */
function approvalView(raw: Record<string, unknown>, now: Date): ServiceApproval {
  const revokedAt =
    typeof raw.revoked_at === 'string' && raw.revoked_at.length > 0
      ? raw.revoked_at
      : null;
  const expiresAt = raw.expires_at as string;
  let status: ServiceApproval['status'];
  if (revokedAt !== null) status = 'revoked';
  else if (typeof expiresAt !== 'string' || Date.parse(expiresAt) <= now.getTime()) {
    status = 'expired';
  } else status = 'active';
  return {
    identity: raw.identity as string,
    service: raw.service as string,
    granted_by: raw.granted_by as string,
    granted_at: raw.granted_at as string,
    expires_at: expiresAt,
    revoked_at: revokedAt,
    status,
  };
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createVaultStore(opts?: {
  db?: Db; // default get_database()
  secretsCollection?: string; // default 'secrets'
  auditCollection?: string; // default 'vault_audit'
  approvalsCollection?: string; // default 'vault_approvals' (F6)
  masterKeyHex?: string; // default process.env.KATRA_VAULT_MASTER_KEY
  defaultSharedId?: string; // default 'my-team'
}): VaultStore {
  const db: Db = opts?.db ?? get_database();
  const secretsCol = db.collection(opts?.secretsCollection ?? SECRETS_COLLECTION);
  const auditCol = db.collection(opts?.auditCollection ?? AUDIT_COLLECTION);
  const approvalsCol = db.collection(opts?.approvalsCollection ?? APPROVALS_COLLECTION);
  const sharedId: string =
    typeof opts?.defaultSharedId === 'string' && opts.defaultSharedId.length > 0
      ? opts.defaultSharedId
      : DEFAULT_SHARED_ID;

  /** Explicitly-provided key wins; otherwise read the env per operation. */
  const explicitKey: string | undefined =
    typeof opts?.masterKeyHex === 'string' && opts.masterKeyHex.length > 0
      ? opts.masterKeyHex
      : undefined;

  function resolveMasterKey(): string | undefined {
    if (explicitKey !== undefined) return explicitKey;
    const envKey = process.env.KATRA_VAULT_MASTER_KEY;
    return typeof envKey === 'string' && envKey.length > 0 ? envKey : undefined;
  }

  async function writeAudit(row: AuditRow): Promise<void> {
    const { error, ...rest } = row;
    const doc: Record<string, unknown> = { ...rest };
    if (row.outcome !== 'ok') doc.error = error ?? row.outcome;
    await auditCol.insertOne(doc);
  }

  return {
    async putSecret(input: PutSecretInput): Promise<{ secret_id: string; created: boolean }> {
      const caller = requireCaller(input.caller);
      const name = requireName(input.name);
      requireValue(input.value);
      const scope: 'private' | 'team' = input.scope ?? 'private';
      if (scope !== 'private' && scope !== 'team') {
        throw vaultError(`invalid scope: ${String(input.scope)}`);
      }
      const kind = input.kind ?? 'api_key';
      if (!ALLOWED_KINDS.has(kind)) {
        throw vaultError(`invalid secret kind: ${String(input.kind)}`);
      }

      const { owner, cryptoScope, secretIdPrefix } = pinOwner(
        scope,
        sharedId,
        ownerUserIdForCaller(caller, input.ownerUserId),
      );
      const secretId = `${secretIdPrefix}/${name}`;
      const service = input.service === undefined ? null : input.service;
      const readers = resolveReaders(caller, input.aclReaders);

      const masterKey = resolveMasterKey();
      if (!masterKey) throw new Error(MASTER_KEY_NOT_CONFIGURED);

      const envelope = sealSecret(input.value, cryptoScope, masterKey);
      const now = new Date().toISOString();

      const existing = await secretsCol.findOne(
        { secret_id: secretId },
        { projection: { 'meta.created_by': 1, 'meta.created_at': 1 } },
      );
      const created = existing === null;
      const priorMeta = existing as
        | { meta?: { created_by?: unknown; created_at?: unknown } }
        | null;
      const meta: SecretRecord['meta'] = {
        created_by:
          typeof priorMeta?.meta?.created_by === 'string'
            ? priorMeta.meta.created_by
            : caller.user_id,
        created_at:
          typeof priorMeta?.meta?.created_at === 'string' ? priorMeta.meta.created_at : now,
        updated_at: now,
        last_used_at: null,
        rotation_due_at: null,
      };

      const record: Omit<SecretRecord, 'secret_id'> = {
        name,
        owner,
        acl: { readers },
        service,
        kind,
        envelope,
        meta,
        flags: {
          rotatable: input.rotatable ?? true,
          approval_required: input.approvalRequired ?? true,
        },
      };

      if (created) {
        await secretsCol.insertOne({ secret_id: secretId, ...record });
      } else {
        // Overwrite keeps meta.created_* (handled above) and re-seals with a
        // fresh DEK — the old ciphertext can never equal the new one.
        await secretsCol.updateOne({ secret_id: secretId }, { $set: record });
      }

      await writeAudit({
        at: now,
        actor: caller.user_id,
        action: 'put',
        secret_id: secretId,
        service,
        outcome: 'ok',
      });
      return { secret_id: secretId, created };
    },

    async listSecrets(caller: CallerIdentity): Promise<SecretMeta[]> {
      const c = requireCaller(caller);
      const filter = visibilityFilter(c, sharedId);
      const rows = await secretsCol
        .find(filter, { projection: { _id: 0 } })
        .sort({ secret_id: 1 })
        .toArray();
      return rows.map((r) => toSecretMeta(r as unknown as Record<string, unknown>));
    },

    async getSecretMeta(
      caller: CallerIdentity,
      secretId: string,
    ): Promise<SecretMeta | null> {
      const c = requireCaller(caller);
      const filter = visibilityFilter(c, sharedId);
      const row = await secretsCol.findOne(
        { secret_id: secretId, ...filter },
        { projection: { _id: 0 } },
      );
      return row === null ? null : toSecretMeta(row as unknown as Record<string, unknown>);
    },

    async deleteSecret(
      caller: CallerIdentity,
      secretId: string,
    ): Promise<{ deleted: boolean }> {
      const c = requireCaller(caller);
      const now = new Date().toISOString();
      const doc = (await secretsCol.findOne({ secret_id: secretId })) as SecretDoc | null;

      if (!doc) {
        await writeAudit({
          at: now,
          actor: c.user_id,
          action: 'delete',
          secret_id: secretId,
          service: null,
          outcome: 'denied',
          error: 'secret not found',
        });
        return { deleted: false };
      }
      const ownerMayDelete = doc.owner.user_id !== undefined && doc.owner.user_id === c.user_id;
      if (!c.trusted && !ownerMayDelete) {
        await writeAudit({
          at: now,
          actor: c.user_id,
          action: 'delete',
          secret_id: secretId,
          service: doc.service,
          outcome: 'denied',
          error: 'not authorized',
        });
        return { deleted: false };
      }

      await secretsCol.deleteOne({ secret_id: secretId });
      await writeAudit({
        at: now,
        actor: c.user_id,
        action: 'delete',
        secret_id: secretId,
        service: doc.service,
        outcome: 'ok',
      });
      return { deleted: true };
    },

    async rotateSecret(
      caller: CallerIdentity,
      secretId: string,
    ): Promise<{ rotated: boolean }> {
      const c = requireCaller(caller);
      const doc = (await secretsCol.findOne({ secret_id: secretId })) as SecretDoc | null;

      if (!doc) {
        await writeAudit({
          at: new Date().toISOString(),
          actor: c.user_id,
          action: 'rotate',
          secret_id: secretId,
          service: null,
          outcome: 'denied',
          error: 'secret not found',
        });
        return { rotated: false };
      }
      const ownerMayRotate = doc.owner.user_id !== undefined && doc.owner.user_id === c.user_id;
      if (!c.trusted && !ownerMayRotate) {
        await writeAudit({
          at: new Date().toISOString(),
          actor: c.user_id,
          action: 'rotate',
          secret_id: secretId,
          service: doc.service,
          outcome: 'denied',
          error: 'not authorized',
        });
        return { rotated: false };
      }

      const masterKey = resolveMasterKey();
      if (!masterKey) {
        await writeAudit({
          at: new Date().toISOString(),
          actor: c.user_id,
          action: 'rotate',
          secret_id: secretId,
          service: doc.service,
          outcome: 'error',
          error: MASTER_KEY_NOT_CONFIGURED,
        });
        throw new Error(MASTER_KEY_NOT_CONFIGURED);
      }

      const cryptoScope =
        doc.owner.user_id !== undefined
          ? `user:${doc.owner.user_id}`
          : `shared:${doc.owner.shared_id ?? sharedId}`;

      let plaintext: string;
      try {
        plaintext = openSecret(doc.envelope, cryptoScope, masterKey);
      } catch (error) {
        await writeAudit({
          at: new Date().toISOString(),
          actor: c.user_id,
          action: 'rotate',
          secret_id: secretId,
          service: doc.service,
          outcome: 'error',
          error: error instanceof Error ? error.message : 'vault: rotation failed',
        });
        throw error;
      }

      // Re-seal with a FRESH DEK — new ciphertext + new wrapped DEK by
      // construction; plaintext never leaves this function.
      const freshEnvelope = sealSecret(plaintext, cryptoScope, masterKey);
      const now = new Date();
      await secretsCol.updateOne(
        { secret_id: secretId },
        {
          $set: {
            envelope: freshEnvelope,
            'meta.updated_at': now.toISOString(),
            'meta.rotation_due_at': new Date(now.getTime() + ROTATION_PERIOD_MS).toISOString(),
          },
        },
      );

      await writeAudit({
        at: now.toISOString(),
        actor: c.user_id,
        action: 'rotate',
        secret_id: secretId,
        service: doc.service,
        outcome: 'ok',
      });
      return { rotated: true };
    },

    async openSecretValue(caller: CallerIdentity, secretId: string): Promise<string> {
      const c = requireCaller(caller);
      const now = new Date().toISOString();
      const doc = (await secretsCol.findOne({ secret_id: secretId })) as SecretDoc | null;

      const isReader = (doc?.acl.readers ?? []).includes(c.user_id);
      const ownerMayOpen = doc?.owner.user_id !== undefined && doc.owner.user_id === c.user_id;
      if (!doc || (!c.trusted && !ownerMayOpen && !isReader)) {
        await writeAudit({
          at: now,
          actor: c.user_id,
          action: 'open',
          secret_id: secretId,
          service: doc?.service ?? null,
          outcome: 'denied',
          error: doc ? 'not authorized' : 'secret not found',
        });
        throw vaultError(doc ? 'not authorized for this secret' : 'secret not found');
      }

      const masterKey = resolveMasterKey();
      if (!masterKey) {
        await writeAudit({
          at: now,
          actor: c.user_id,
          action: 'open',
          secret_id: secretId,
          service: doc.service,
          outcome: 'error',
          error: MASTER_KEY_NOT_CONFIGURED,
        });
        throw new Error(MASTER_KEY_NOT_CONFIGURED);
      }

      const cryptoScope =
        doc.owner.user_id !== undefined
          ? `user:${doc.owner.user_id}`
          : `shared:${doc.owner.shared_id ?? sharedId}`;

      let plaintext: string;
      try {
        plaintext = openSecret(doc.envelope, cryptoScope, masterKey);
      } catch (error) {
        await writeAudit({
          at: now,
          actor: c.user_id,
          action: 'open',
          secret_id: secretId,
          service: doc.service,
          outcome: 'error',
          error: error instanceof Error ? error.message : 'vault: open failed',
        });
        throw error;
      }

      await secretsCol.updateOne(
        { secret_id: secretId },
        { $set: { 'meta.last_used_at': now } },
      );
      await writeAudit({
        at: now,
        actor: c.user_id,
        action: 'open',
        secret_id: secretId,
        service: doc.service,
        outcome: 'ok',
      });
      return plaintext;
    },

    async listAudit(
      caller: CallerIdentity,
      opts?: { secretId?: string; limit?: number },
    ): Promise<AuditRow[]> {
      const c = requireCaller(caller);
      const filter: Record<string, unknown> = {};
      // Untrusted callers only see rows they themselves produced.
      if (!c.trusted) filter.actor = c.user_id;
      if (typeof opts?.secretId === 'string' && opts.secretId.length > 0) {
        filter.secret_id = opts.secretId;
      }
      const requestedLimit = opts?.limit;
      const limit: number =
        typeof requestedLimit === 'number' && Number.isFinite(requestedLimit)
          ? Math.min(Math.max(Math.floor(requestedLimit), 1), 1000)
          : 100;
      const rows = await auditCol
        .find(filter, { projection: { _id: 0 } })
        .sort({ at: -1, _id: -1 })
        .limit(limit)
        .toArray();
      return rows.map((r) => ({
        at: r.at as string,
        actor: r.actor as string,
        action: r.action as AuditRow['action'],
        secret_id: (r.secret_id === null || r.secret_id === undefined
          ? null
          : r.secret_id) as string | null,
        service: (r.service === undefined ? null : r.service) as string | null,
        outcome: r.outcome as AuditRow['outcome'],
        ...(typeof r.error === 'string' ? { error: r.error } : {}),
      }));
    },

    // ── F6 per-service approvals ─────────────────────────────────────────

    async grantApproval(op: {
      caller: CallerIdentity;
      identity: string;
      service: string;
      ttlDays?: number;
    }): Promise<{ granted: boolean; approval: ServiceApproval | null }> {
      const caller = requireCaller(op.caller);
      const identity = requireApprovalIdentity(op.identity);
      const service = requireApprovalService(op.service);
      const ttlDays = resolveTtlDays(op.ttlDays);
      const now = new Date();
      const nowIso = now.toISOString();

      // Operator-only: untrusted callers get a denied result + ONE 'denied'
      // audit row; no approval row is created or updated.
      if (!caller.trusted) {
        await writeAudit({
          at: nowIso,
          actor: caller.user_id,
          action: 'approval_grant',
          secret_id: null,
          service,
          outcome: 'denied',
        });
        return { granted: false, approval: null };
      }

      const expiresAt = new Date(now.getTime() + ttlDays * DAY_MS).toISOString();
      const existing = (await approvalsCol.findOne({ identity, service })) as Record<
        string,
        unknown
      > | null;

      if (existing === null) {
        const doc = {
          identity,
          service,
          granted_by: caller.user_id,
          granted_at: nowIso,
          expires_at: expiresAt,
          revoked_at: null,
        };
        await approvalsCol.insertOne(doc);
        await writeAudit({
          at: nowIso,
          actor: caller.user_id,
          action: 'approval_grant',
          secret_id: null,
          service,
          outcome: 'ok',
        });
        return { granted: true, approval: approvalView(doc, now) };
      }

      // Idempotent re-grant of an ACTIVE grant: extend expires_at from now,
      // never duplicate the row; granted_by/granted_at are preserved.
      const active =
        existing.revoked_at === null &&
        typeof existing.expires_at === 'string' &&
        Date.parse(existing.expires_at) > now.getTime();
      const patch = active
        ? { expires_at: expiresAt }
        : {
            // revoked (or expired) rows are re-granted fresh: new expiry,
            // cleared revoked_at, grantor/grant date reset.
            granted_by: caller.user_id,
            granted_at: nowIso,
            expires_at: expiresAt,
            revoked_at: null,
          };
      await approvalsCol.updateOne({ identity, service }, { $set: patch });
      await writeAudit({
        at: nowIso,
        actor: caller.user_id,
        action: 'approval_grant',
        secret_id: null,
        service,
        outcome: 'ok',
      });
      const fresh = (await approvalsCol.findOne({ identity, service })) as Record<
        string,
        unknown
      >;
      return { granted: true, approval: approvalView(fresh, now) };
    },

    async revokeApproval(op: {
      caller: CallerIdentity;
      identity: string;
      service: string;
    }): Promise<{ revoked: boolean }> {
      const caller = requireCaller(op.caller);
      const identity = requireApprovalIdentity(op.identity);
      const service = requireApprovalService(op.service);
      const nowIso = new Date().toISOString();

      // Operator-only: untrusted callers get a denied result + ONE 'denied'
      // audit row; no approval row is created or updated.
      if (!caller.trusted) {
        await writeAudit({
          at: nowIso,
          actor: caller.user_id,
          action: 'approval_revoke',
          secret_id: null,
          service,
          outcome: 'denied',
        });
        return { revoked: false };
      }

      const existing = (await approvalsCol.findOne({ identity, service })) as Record<
        string,
        unknown
      > | null;
      if (existing === null || existing.revoked_at !== null) {
        await writeAudit({
          at: nowIso,
          actor: caller.user_id,
          action: 'approval_revoke',
          secret_id: null,
          service,
          outcome: 'denied',
          error: 'no active approval',
        });
        return { revoked: false };
      }

      await approvalsCol.updateOne(
        { identity, service },
        { $set: { revoked_at: nowIso } },
      );
      await writeAudit({
        at: nowIso,
        actor: caller.user_id,
        action: 'approval_revoke',
        secret_id: null,
        service,
        outcome: 'ok',
      });
      return { revoked: true };
    },

    async listApprovals(caller: CallerIdentity): Promise<ServiceApproval[]> {
      const c = requireCaller(caller);
      // Caller-scoped: untrusted callers see only their own identity's rows;
      // trusted callers (operator view) see all rows.
      const filter: Record<string, unknown> = c.trusted
        ? {}
        : { identity: c.user_id };
      const rows = await approvalsCol
        .find(filter, { projection: { _id: 0 } })
        .sort({ identity: 1, service: 1 })
        .toArray();
      const now = new Date();
      return rows.map((r) => approvalView(r as unknown as Record<string, unknown>, now));
    },

    async hasActiveApproval(identity: string, service: string): Promise<boolean> {
      const id = requireApprovalIdentity(identity);
      const svc = requireApprovalService(service);
      const nowIso = new Date().toISOString();
      // Active only: not revoked, expires_at strictly in the future, and the
      // `'*'` wildcard grant counts for any requested service.
      const row = await approvalsCol.findOne({
        identity: id,
        service: { $in: [svc, '*'] },
        revoked_at: null,
        expires_at: { $gt: nowIso },
      });
      return row !== null;
    },
  };
}
