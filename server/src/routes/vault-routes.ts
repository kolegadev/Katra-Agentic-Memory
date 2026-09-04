/**
 * Katra Vault — REST routes (F3)
 *
 * Redacted vault surface under `/api/v1/vault/*` (mounted in index.ts below
 * the app-level caller-auth middleware — these routes REQUIRE auth and are
 * deliberately NOT in AUTH_SKIP_PATHS). Every handler reads the caller from
 * getCaller() (utils/caller-identity.js) — the caller-auth middleware runs
 * the request inside that identity, so handlers never re-derive or trust
 * client-supplied user_id/owner fields for untrusted callers.
 *
 * Hard redaction: no response, error message, or log ever contains a raw
 * secret value, envelope, or plaintext. Store errors are static 'vault: …'
 * strings; unknown failures degrade to a generic message.
 *
 * Error mapping: bad input → 400 · not found → 404 · RBAC denial → 403 ·
 * master key missing on put/rotate → 503 with
 * 'vault: master key not configured' in the body.
 */

import { Hono } from 'hono';
import { getCaller } from '../utils/caller-identity.js';
import {
  createVaultStore,
  type VaultStore,
  type SecretMeta,
} from '../services/vault/store.js';
import {
  createCapability,
  type Capability,
  type CapabilityInput,
} from '../services/vault/capability.js';
import {
  createAuthService,
  type AuthService,
  type AuthServiceOptions,
} from '../services/vault/auth.js';

const MASTER_KEY_MISSING = 'vault: master key not configured';
const ALLOWED_KINDS = new Set(['api_key', 'password', 'token', 'totp_secret', 'env']);
const CAPABILITY_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/** Store injection point (tests use test_-prefixed collections + a key). */
export interface VaultRoutesOptions {
  store?: VaultStore;
  /** Capability core injection point (defaults to the shared store). */
  capability?: Capability;
}

const NOT_FOUND = { success: false, error: 'vault: secret not found' };
const FORBIDDEN = { success: false, error: 'vault: not authorized for this secret' };
const APPROVAL_FORBIDDEN = { success: false, error: 'vault: operator only' };

/** Static error text — never echoes a submitted value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'vault: operation failed';
}

export const create_vault_routes = (opts: VaultRoutesOptions = {}): Hono => {
  const router = new Hono();
  const store: VaultStore = opts.store ?? createVaultStore();
  const capability: Capability =
    opts.capability ?? createCapability(opts.store ? { store: opts.store } : undefined);

  // ── POST /secrets ──────────────────────────────────────────────
  router.post('/secrets', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'vault: invalid request body' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ success: false, error: 'vault: invalid request body' }, 400);
    }
    const b = body as Record<string, unknown>;

    // Light shape checks first (type-level only — never echo string contents).
    if (b.scope !== undefined && b.scope !== 'private' && b.scope !== 'team') {
      return c.json({ success: false, error: 'vault: invalid scope' }, 400);
    }
    if (b.kind !== undefined && (typeof b.kind !== 'string' || !ALLOWED_KINDS.has(b.kind))) {
      return c.json({ success: false, error: 'vault: invalid secret kind' }, 400);
    }
    if (b.service !== undefined && b.service !== null && typeof b.service !== 'string') {
      return c.json({ success: false, error: 'vault: service must be a string' }, 400);
    }
    if (b.aclReaders !== undefined && !Array.isArray(b.aclReaders)) {
      return c.json({ success: false, error: 'vault: aclReaders must be an array' }, 400);
    }
    if (
      (b.approvalRequired !== undefined && typeof b.approvalRequired !== 'boolean') ||
      (b.rotatable !== undefined && typeof b.rotatable !== 'boolean')
    ) {
      return c.json({ success: false, error: 'vault: approvalRequired/rotatable must be boolean' }, 400);
    }

    try {
      const caller = getCaller();
      const result = await store.putSecret({
        caller,
        // Types are re-validated inside the store (static 'vault:' errors —
        // the submitted value is never echoed in any message or response).
        name: b.name as string,
        value: b.value as string,
        scope: b.scope as 'private' | 'team' | undefined,
        service: b.service as string | null | undefined,
        kind: b.kind as SecretMeta['kind'] | undefined,
        aclReaders: Array.isArray(b.aclReaders)
          ? (b.aclReaders as unknown[]).filter((r): r is string => typeof r === 'string')
          : undefined,
        approvalRequired: b.approvalRequired as boolean | undefined,
        rotatable: b.rotatable as boolean | undefined,
        ownerUserId: b.ownerUserId as string | undefined,
      });
      return c.json({ secret_id: result.secret_id, created: result.created }, 201);
    } catch (error) {
      const message = errorText(error);
      if (message.includes(MASTER_KEY_MISSING)) {
        return c.json({ success: false, error: MASTER_KEY_MISSING }, 503);
      }
      if (message.startsWith('vault:')) {
        return c.json({ success: false, error: message }, 400);
      }
      return c.json({ success: false, error: 'vault: put failed' }, 500);
    }
  });

  // ── GET /secrets ───────────────────────────────────────────────
  router.get('/secrets', async (c) => {
    try {
      const list = await store.listSecrets(getCaller());
      return c.json(list);
    } catch (error) {
      return c.json({ success: false, error: 'vault: list failed' }, 500);
    }
  });

  // ── GET /secrets/:id ───────────────────────────────────────────
  router.get('/secrets/:id', async (c) => {
    const secretId = c.req.param('id') ?? '';
    if (!secretId) return c.json(NOT_FOUND, 404);
    try {
      const meta = await store.getSecretMeta(getCaller(), secretId);
      return meta === null ? c.json(NOT_FOUND, 404) : c.json(meta);
    } catch {
      return c.json({ success: false, error: 'vault: get failed' }, 500);
    }
  });

  // ── DELETE /secrets/:id ────────────────────────────────────────
  router.delete('/secrets/:id', async (c) => {
    const secretId = c.req.param('id') ?? '';
    if (!secretId) return c.json(NOT_FOUND, 404);
    const caller = getCaller();
    try {
      const meta = await store.getSecretMeta(caller, secretId);
      if (meta === null) return c.json(NOT_FOUND, 404);
      const result = await store.deleteSecret(caller, secretId);
      if (!result.deleted) return c.json(FORBIDDEN, 403);
      return c.json({ deleted: true });
    } catch {
      return c.json({ success: false, error: 'vault: delete failed' }, 500);
    }
  });

  // ── POST /secrets/:id/rotate ───────────────────────────────────
  router.post('/secrets/:id/rotate', async (c) => {
    const secretId = c.req.param('id') ?? '';
    if (!secretId) return c.json(NOT_FOUND, 404);
    const caller = getCaller();
    try {
      const meta = await store.getSecretMeta(caller, secretId);
      if (meta === null) return c.json(NOT_FOUND, 404);
      const result = await store.rotateSecret(caller, secretId);
      if (!result.rotated) return c.json(FORBIDDEN, 403);
      return c.json({ rotated: true });
    } catch (error) {
      const message = errorText(error);
      if (message.includes(MASTER_KEY_MISSING)) {
        return c.json({ success: false, error: MASTER_KEY_MISSING }, 503);
      }
      return c.json({ success: false, error: 'vault: rotate failed' }, 500);
    }
  });

  // ── GET /audit?secret_id=&limit= ───────────────────────────────
  router.get('/audit', async (c) => {
    const secretId = c.req.query('secret_id') ?? undefined;
    const rawLimit = c.req.query('limit');
    let limit: number | undefined;
    if (rawLimit !== undefined && rawLimit !== '') {
      limit = Number(rawLimit);
      if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
        return c.json({ success: false, error: 'vault: invalid limit (1-1000)' }, 400);
      }
    }
    try {
      const rows = await store.listAudit(getCaller(), { secretId, limit });
      return c.json(rows);
    } catch (error) {
      const message = errorText(error);
      if (message.startsWith('vault:')) {
        return c.json({ success: false, error: message }, 400);
      }
      return c.json({ success: false, error: 'vault: audit failed' }, 500);
    }
  });

  // ── F6 approvals ──────────────────────────────────────────────
  // POST   /approvals   operator grants (identity, service, ttlDays?) → 201
  //        {granted, approval}; untrusted → 403 (store writes a 'denied'
  //        audit row and touches no approval row).
  // DELETE /approvals?identity=&service=   operator → 200 {revoked};
  //        untrusted (or no active grant) → 403.
  // GET    /approvals   caller-scoped list → 200 [ServiceApproval]
  //        (untrusted: own identity rows only; trusted: all).

  router.post('/approvals', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'vault: invalid request body' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ success: false, error: 'vault: invalid request body' }, 400);
    }
    const b = body as Record<string, unknown>;
    // Light shape checks first (type-level only — never echo string contents);
    // content rules are enforced inside the store with static 'vault:' errors.
    if (b.identity === undefined || b.service === undefined) {
      return c.json({ success: false, error: 'vault: identity and service are required' }, 400);
    }
    if (typeof b.identity !== 'string' || typeof b.service !== 'string') {
      return c.json({ success: false, error: 'vault: identity and service must be strings' }, 400);
    }
    if (
      b.ttlDays !== undefined &&
      (typeof b.ttlDays !== 'number' || !Number.isFinite(b.ttlDays) || b.ttlDays < 1)
    ) {
      return c.json({ success: false, error: 'vault: ttlDays must be a positive number' }, 400);
    }
    try {
      const result = await store.grantApproval({
        caller: getCaller(),
        identity: b.identity,
        service: b.service,
        ttlDays: b.ttlDays as number | undefined,
      });
      if (!result.granted) return c.json(APPROVAL_FORBIDDEN, 403);
      return c.json({ granted: true, approval: result.approval }, 201);
    } catch (error) {
      const message = errorText(error);
      if (message.startsWith('vault:')) {
        return c.json({ success: false, error: message }, 400);
      }
      return c.json({ success: false, error: 'vault: approval grant failed' }, 500);
    }
  });

  router.delete('/approvals', async (c) => {
    const identity = c.req.query('identity') ?? '';
    const service = c.req.query('service') ?? '';
    if (!identity || !service) {
      return c.json(
        { success: false, error: 'vault: identity and service are required' },
        400,
      );
    }
    try {
      const result = await store.revokeApproval({
        caller: getCaller(),
        identity,
        service,
      });
      if (!result.revoked) return c.json(APPROVAL_FORBIDDEN, 403);
      return c.json({ revoked: true });
    } catch (error) {
      const message = errorText(error);
      if (message.startsWith('vault:')) {
        return c.json({ success: false, error: message }, 400);
      }
      return c.json({ success: false, error: 'vault: approval revoke failed' }, 500);
    }
  });

  router.get('/approvals', async (c) => {
    try {
      const list = await store.listApprovals(getCaller());
      return c.json(list);
    } catch {
      return c.json({ success: false, error: 'vault: approvals list failed' }, 500);
    }
  });

  // ── F7 capability ──────────────────────────────────────────────
  // POST /capability/http — approval-gated, server-side secret use
  // ({secret_id, service, method, url, inject_header, body?} →
  // CapabilityResult {status, body, blocked?}). The caller comes from
  // getCaller(); the resolved secret is injected only as the named header
  // and never appears in any response, error, or audit row.

  router.post('/capability/http', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'vault: invalid request body' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ success: false, error: 'vault: invalid request body' }, 400);
    }
    const b = body as Record<string, unknown>;
    // Light shape checks (type-level only — never echo string contents);
    // content rules (approval, RBAC, SSRF, limits) are enforced by the
    // capability core with static blocked reasons.
    if (
      typeof b.secret_id !== 'string' ||
      typeof b.service !== 'string' ||
      typeof b.method !== 'string' ||
      typeof b.url !== 'string' ||
      typeof b.inject_header !== 'string'
    ) {
      return c.json(
        { success: false, error: 'vault: secret_id, service, method, url, inject_header are required strings' },
        400,
      );
    }
    if (
      !CAPABILITY_METHODS.has(b.method) ||
      b.secret_id.length === 0 ||
      b.service.length === 0 ||
      b.url.length === 0 ||
      b.inject_header.length === 0
    ) {
      return c.json(
        { success: false, error: 'vault: invalid capability request' },
        400,
      );
    }
    if (b.body !== undefined && b.body !== null && typeof b.body !== 'string') {
      return c.json({ success: false, error: 'vault: body must be a string' }, 400);
    }
    if (b.inject_scheme !== undefined && b.inject_scheme !== null && typeof b.inject_scheme !== 'string') {
      return c.json({ success: false, error: 'vault: inject_scheme must be a string' }, 400);
    }
    const input: CapabilityInput = {
      caller: getCaller(),
      secretId: b.secret_id,
      service: b.service,
      method: b.method,
      url: b.url,
      injectHeader: b.inject_header,
      injectScheme: typeof b.inject_scheme === 'string' ? b.inject_scheme : undefined,
      body: typeof b.body === 'string' ? b.body : undefined,
    };
    try {
      // vaultHttp never throws for refused/blocked attempts; it returns the
      // result JSON (status 0 + blocked reason) — never a secret.
      const result = await capability.vaultHttp(input);
      return c.json(result);
    } catch {
      return c.json({ success: false, error: 'vault: capability failed' }, 500);
    }
  });

  return router;
};

// ── F9 auth routes ─────────────────────────────────────────────
// Mounted at /api/v1/auth in index.ts (ONE extra app.route line; under the
// app-level caller-auth middleware — NOT in AUTH_SKIP_PATHS). Every handler
// reads the caller from getCaller(). Endpoints:
//   POST   /enroll-totp  operator (or self) enrollment → 201 {enrolled,
//          identity, otpauth_uri}; the URI is returned ONCE — never logged.
//   POST   /session      {identity?, totp_code} → 201 {issued, token,
//          expires_at} — the raw token is returned exactly once.
//   DELETE /session      {token_hash?} → 200 {revoked}
//   GET    /sessions     caller-scoped session list
// Static, value-free errors: no code/token/secret is ever echoed.

export interface AuthRoutesOptions extends AuthServiceOptions {
  /** Auth service injection point (tests use test_-prefixed collections). */
  authService?: AuthService;
}

export const create_auth_routes = (opts: AuthRoutesOptions = {}): Hono => {
  const router = new Hono();
  const service: AuthService = opts.authService ?? createAuthService(opts);

  // ── POST /enroll-totp ─────────────────────────────────────────
  router.post('/enroll-totp', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'auth: invalid request body' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ success: false, error: 'auth: invalid request body' }, 400);
    }
    const b = body as Record<string, unknown>;
    if (typeof b.identity !== 'string' || b.identity.length === 0) {
      return c.json({ success: false, error: 'auth: identity is required' }, 400);
    }
    if (b.issuer !== undefined && b.issuer !== null && typeof b.issuer !== 'string') {
      return c.json({ success: false, error: 'auth: issuer must be a string' }, 400);
    }
    try {
      const result = await service.enrollTotp({
        caller: getCaller(),
        identity: b.identity,
        issuer: typeof b.issuer === 'string' ? b.issuer : undefined,
      });
      if (!result.enrolled) {
        return c.json(
          { success: false, error: result.reason ?? 'auth: enrollment refused' },
          403,
        );
      }
      return c.json(
        { enrolled: true, identity: result.identity, otpauth_uri: result.otpauth_uri },
        201,
      );
    } catch (error) {
      const message = errorText(error);
      if (message.includes(MASTER_KEY_MISSING)) {
        return c.json({ success: false, error: MASTER_KEY_MISSING }, 503);
      }
      if (message.startsWith('vault:')) {
        return c.json({ success: false, error: message }, 400);
      }
      return c.json({ success: false, error: 'auth: enrollment failed' }, 500);
    }
  });

  // ── POST /session ─────────────────────────────────────────────
  router.post('/session', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'auth: invalid request body' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ success: false, error: 'auth: invalid request body' }, 400);
    }
    const b = body as Record<string, unknown>;
    if (b.identity !== undefined && typeof b.identity !== 'string') {
      return c.json({ success: false, error: 'auth: identity must be a string' }, 400);
    }
    if (typeof b.totp_code !== 'string' || b.totp_code.length === 0) {
      return c.json({ success: false, error: 'auth: totp_code is required' }, 400);
    }
    try {
      const result = await service.issueSession({
        caller: getCaller(),
        identity: typeof b.identity === 'string' ? b.identity : undefined,
        totpCode: b.totp_code,
      });
      if (!result.issued) {
        return c.json(
          { success: false, error: result.reason ?? 'auth: session refused' },
          403,
        );
      }
      return c.json(
        { issued: true, token: result.token, expires_at: result.expires_at },
        201,
      );
    } catch (error) {
      const message = errorText(error);
      if (message.includes(MASTER_KEY_MISSING)) {
        return c.json({ success: false, error: MASTER_KEY_MISSING }, 503);
      }
      return c.json({ success: false, error: 'auth: session issue failed' }, 500);
    }
  });

  // ── DELETE /session ───────────────────────────────────────────
  // An EMPTY (no JSON) body is fine → revokes nothing → 200 {revoked: 0};
  // a present body must still be valid JSON with shape checks below.
  router.delete('/session', async (c) => {
    let body: unknown = {};
    const raw = await c.req.text().catch(() => '');
    if (raw.trim().length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        return c.json({ success: false, error: 'auth: invalid request body' }, 400);
      }
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ success: false, error: 'auth: invalid request body' }, 400);
    }
    const b = body as Record<string, unknown>;
    if (b.token_hash !== undefined && typeof b.token_hash !== 'string') {
      return c.json({ success: false, error: 'auth: token_hash must be a string' }, 400);
    }
    try {
      const result = await service.revokeSession({
        caller: getCaller(),
        tokenHashOrPrefix:
          typeof b.token_hash === 'string' ? b.token_hash : undefined,
      });
      return c.json({ revoked: result.revoked });
    } catch {
      return c.json({ success: false, error: 'auth: revoke failed' }, 500);
    }
  });

  // ── GET /sessions ─────────────────────────────────────────────
  router.get('/sessions', async (c) => {
    try {
      const list = await service.listSessions(getCaller());
      return c.json(list);
    } catch {
      return c.json({ success: false, error: 'auth: sessions list failed' }, 500);
    }
  });

  return router;
};
