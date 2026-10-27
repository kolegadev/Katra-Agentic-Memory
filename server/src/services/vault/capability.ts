/**
 * Katra Vault — capability layer (F7)
 *
 * The ONLY way a secret is ever *used*: an approval-gated, server-side HTTP
 * capability (`vaultHttp`) that opens a secret under the caller's RBAC scope
 * (F2 `openSecretValue`), injects it into ONE outbound request as a single
 * named header and/or into the request body via a `{{secret}}` template
 * token, and returns only `{status, body, setCookies?}` (+ a `blocked`
 * reason when the request was refused). The raw secret never appears in
 * results, thrown errors, logs, or audit rows (design docs/katra-vault-
 * design.md §7.3 guard 3, §9; contract F7).
 *
 * Guard order (all hard rules — violation = FAIL):
 *   1. Approval gate FIRST — hasActiveApproval(caller.user_id, service)
 *      (honors the '*' wildcard). No active approval → no network activity.
 *      Meta-first decision (2026-09-28, workplan Objective 1): a secret with
 *      flags.approval_required=false (dashboard "Approval required"
 *      unchecked) is usable with no approvals row (still audited); otherwise
 *      the approval is derived from the SECRET's linked service, the
 *      call-time service must match it ('service mismatch'), and an active
 *      (identity, service) grant is required. RBAC open (step 5) and every
 *      other guard still apply. See decideCapabilityApproval.
 *   2. Method whitelist GET POST PUT PATCH DELETE HEAD.
 *   3. Content rules (before any network activity): extra request headers
 *      are allowlisted names only (SAFE_EXTRA_HEADERS, case-insensitive;
 *      host/connection/content-length/cookie/authorization and friends are
 *      rejected), bounded count/value length, and `body` + `body_template`
 *      are mutually exclusive.
 *   4. SSRF pre-flight (before ANY connection): https scheme only; host
 *      resolved via resolveHost; ANY resolved private/loopback/link-local/
 *      reserved address (incl. IPv4-mapped IPv6) blocks; DNS failure blocks;
 *      port 443 only; absolute https URL with no userinfo.
 *   5. RBAC open — openSecretValue(caller, secretId); a caller can never use
 *      a secret outside their read scope.
 *   6. Limits: response body capped at 5 MB (stream counted, read aborted),
 *      upstream timeout 30 s (AbortSignal driven by injectable now()).
 *   7. No redirect following: fetch redirect 'manual' — a 3xx is returned
 *      as-is and never followed (redirects can smuggle SSRF past the
 *      pre-flight).
 *   8. Injection: the resolved secret is set ONLY (a) as the named request
 *      header (`injectHeader`, optionally `injectScheme`-prefixed) and/or
 *      (b) by replacing every `{{secret}}` token in `body_template` with the
 *      secret value. Extra header values are caller text — the secret is
 *      NEVER substituted into them. Upstream `Set-Cookie` response headers
 *      (session material, value-safe) are returned as `setCookies` when
 *      present, bounded by count and total bytes.
 *   9. Audit: exactly ONE value-free `vault_audit` row per attempt: action
 *      'capability_use', actor, service, secret_id, outcome
 *      'ok'|'denied'|'error', error only on exception. Keys ⊆ the F2
 *      whitelist {at, actor, action, secret_id, service, outcome, error}.
 *  10. Redaction on error: upstream non-2xx statuses are returned as
 *      {status, body}; infrastructure failures return blocked reasons only —
 *      never the secret.
 *
 * Audit writes: F7 adds nothing to the store, and the store's `writeAudit`
 * helper is closure-private, so this module mirrors that helper exactly
 * against the same shared `vault_audit` collection (same doc shape, same
 * error-only-when-not-ok rule) rather than reimplementing a parallel audit
 * system.
 */

import type { CallerIdentity } from '../../utils/caller-identity.js';
import { get_database } from '../../database/connection.js';
import { lookup } from 'node:dns/promises';
import { createVaultStore, type VaultStore, type SecretMeta } from './store.js';

// ── Public types (contract F7 exact interfaces) ──────────────────────────

export interface CapabilityInput {
  caller: CallerIdentity;
  /** Full secret_id (e.g. 'agent-a/agentmail-api-key'). */
  secretId: string;
  /** Approval service name (e.g. 'agentmail'). */
  service: string;
  /** Whitelist: GET POST PUT PATCH DELETE HEAD. */
  method: string;
  /** https:// only. */
  url: string;
  /** Header name the secret is injected into. Optional when `bodyTemplate`
   *  or `body` carries the injection target — at least ONE injection target
   *  is required. */
  injectHeader?: string;
  /** Optional auth-scheme prefix for the header value (e.g. 'Bearer' sends
   *  `Authorization: Bearer <secret>`); absent → raw secret is the value. */
  injectScheme?: string;
  /** Optional request body (string) — passed through untouched. Mutually
   *  exclusive with `bodyTemplate`. */
  body?: string;
  /** Optional request-body template (string): every `{{secret}}` token is
   *  replaced with the resolved secret value; nothing else is substituted.
   *  Mutually exclusive with `body`. */
  bodyTemplate?: string;
  /** Optional extra request headers (allowlisted names only, enforced by
   *  the capability core). Values are caller text — the secret is NEVER
   *  substituted into them, and the injected header always wins on a name
   *  collision. */
  headers?: Record<string, string>;
}

export interface CapabilityResult {
  /** Upstream status, or 0 when blocked. */
  status: number;
  /** Upstream response body (never contains the secret). */
  body: string;
  /** Upstream Set-Cookie headers (session material — never the secret),
   *  present only when the upstream returned at least one. */
  setCookies?: string[];
  /** Present when the request was refused (pre-flight or limits). */
  blocked?: { reason: string };
}

/** Typed Instagram-login capability (2026-09-12): the vault opens the IG
 *  password server-side and hands it to an injectable driver that runs
 *  instagrapi's client-encrypted login itself — the plaintext password
 *  never leaves the server process and never appears in results, errors,
 *  logs, or audit rows. Only derived session material is returned. */
export interface InstagramLoginInput {
  caller: CallerIdentity;
  /** Full secret_id holding the IG account password. Required for a fresh
   *  login; optional when `session` is supplied for reuse (fallback). */
  secretId?: string;
  /** Approval service name (e.g. 'Instagram katra account'). */
  service: string;
  /** IG account username (e.g. 'katra5432') — plaintext by design. */
  username: string;
  /** Optional previously-saved instagrapi settings JSON (session reuse).
   *  When present the driver rehydrates the client without the password;
   *  if reuse fails and `secretId` is set, the driver falls back to a
   *  fresh password login. */
  session?: string;
}

export interface InstagramLoginResult {
  ok: boolean;
  /** Present when the login was refused or failed (static reasons only). */
  blocked?: { reason: string };
  /** Session material only — the password is NEVER present. */
  username?: string;
  userIdPk?: string;
  sessionid?: string;
  csrftoken?: string;
  /** Full instagrapi settings JSON (session reuse material). */
  session?: string;
  /** Driver failure taxonomy (value-free w.r.t. the secret): raw exception
   *  class name (e.g. 'CheckpointRequired', 'UnknownError') and the
   *  sanitized IG message (bounded, password-redacted). */
  class?: string;
  message?: string;
}

/** Shape the injectable driver returns (or the default HTTP driver). */
export interface InstagramDriverOutcome {
  ok: boolean;
  userIdPk?: string;
  sessionid?: string;
  csrftoken?: string;
  session?: string;
  error?: string;
  class?: string;
  message?: string;
}

export interface CapabilityOptions {
  /** Default: createVaultStore() (lazily, on first use). */
  store?: VaultStore;
  /** Injectable for tests (default: global fetch). */
  fetchImpl?: typeof fetch;
  /** hostname -> IPs (default: node:dns.promises.lookup with {all:true}). */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Default Date.now. */
  now?: () => number;
  /** Injectable instagrapi login driver (server-side). Default: an HTTP
   *  driver POSTing to the operator-configured IG_DRIVER_URL endpoint. */
  instagramLoginFn?: (args: {
    username: string;
    password?: string;
    session?: string;
  }) => Promise<InstagramDriverOutcome>;
}

export interface Capability {
  vaultHttp(input: CapabilityInput): Promise<CapabilityResult>;
  instagramLogin(input: InstagramLoginInput): Promise<InstagramLoginResult>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const AUDIT_COLLECTION = 'vault_audit';
const CAPABILITY_ACTION = 'capability_use';
/** 30 s upstream timeout. */
const TIMEOUT_MS = 30_000;
/** Typed instagrapi login timeout (the driver may hit IG rate limits). */
const INSTAGRAM_LOGIN_TIMEOUT_MS = 45_000;
/** 5 MB response body cap (bytes). */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Method whitelist. */
const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
]);
/** How often the timeout poller re-checks the injectable clock. */
const TIMEOUT_POLL_MS = 50;

// ── Typed instagrapi login driver (2026-09-12 feature) ────────────────────

/** Operator-configured internal driver endpoint (host-side Python service
 *  running instagrapi). Unset → the capability blocks with a static
 *  'instagram driver not configured' reason. */
function igDriverUrl(): string {
  return (process.env.IG_DRIVER_URL ?? '').trim();
}

/**
 * Default instagrapi login driver: POSTs {username, password?} (or
 * {username, session} for reuse) to the operator-configured IG_DRIVER_URL
 * (token-gated with IG_DRIVER_TOKEN). The password travels ONLY over this
 * operator-controlled hop, server to server — never through results, logs,
 * or caller contexts.
 */
function defaultInstagramLoginFn(
  fetchImpl: typeof fetch,
): (args: {
  username: string;
  password?: string;
  session?: string;
}) => Promise<InstagramDriverOutcome> {
  return async (args): Promise<InstagramDriverOutcome> => {
    const url = igDriverUrl();
    if (!url) {
      throw new Error('instagram driver not configured');
    }
    const token = process.env.IG_DRIVER_TOKEN ?? '';
    const body: Record<string, string> = { username: args.username };
    if (args.password !== undefined) body.password = args.password;
    if (args.session !== undefined) body.session = args.session;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error('instagram driver rejected the request');
    }
    const payload = (await response.json()) as InstagramDriverOutcome;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof payload.ok !== 'boolean'
    ) {
      throw new Error('instagram driver returned an invalid response');
    }
    return payload;
  };
}

// ── Body-injection + extra-header content rules (2026-09-12 feature) ─────

/** Template token substituted with the resolved secret inside
 *  `body_template`. Any other text passes through untouched. */
const BODY_SECRET_TOKEN = '{{secret}}';
/** Extra request-header names a caller may set (case-insensitive).
 *  Deliberately excludes host, connection, content-length,
 *  transfer-encoding, cookie, authorization, proxy-authorization and the
 *  like — names that could smuggle SSRF past the pre-flight or bypass the
 *  single header-injection path. */
const SAFE_EXTRA_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'accept',
  'accept-language',
  'user-agent',
  'origin',
  'referer',
  'x-ig-app-id',
  'x-ig-www-claim',
  'x-requested-with',
  'x-csrftoken',
]);
/** Maximum number of caller-supplied extra headers. */
const MAX_EXTRA_HEADERS = 8;
/** Maximum length of one caller-supplied extra-header value. */
const MAX_HEADER_VALUE_LENGTH = 1024;
/** Maximum number of upstream Set-Cookie headers surfaced in the result. */
const MAX_SET_COOKIE_HEADERS = 32;
/** Maximum total bytes of surfaced Set-Cookie values. */
const MAX_SET_COOKIE_TOTAL_BYTES = 8 * 1024;

// ── SSRF address guards (plain JS over address strings; no new deps) ──────

/** IPv4 private/loopback/link-local/reserved ranges per the F7 contract:
 *  127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
 *  (incl. 169.254.169.254), 0.0.0.0/8, 100.64.0.0/10. */
function isPrivateIPv4(address: string): boolean {
  const octets = address.split('.');
  if (octets.length !== 4) return false;
  const o = octets.map((p) => Number(p));
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [b0, b1] = o;
  if (b0 === 0) return true; // 0.0.0.0/8
  if (b0 === 10) return true; // 10.0.0.0/8
  if (b0 === 127) return true; // 127.0.0.0/8
  if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16 incl. metadata IP
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12
  if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true; // 100.64.0.0/10
  return false;
}

/** Decode the IPv4 tail of an IPv4-mapped IPv6 address ('::ffff:a.b.c.d' or
 *  '::ffff:xxxx:xxxx') to dotted-quad, else null. */
function mappedIpv4Tail(address: string): string | null {
  const tail = address.slice('::ffff:'.length);
  if (tail.length === 0) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  const hex = tail.split(':');
  if (hex.length === 2 && hex.every((h) => /^[0-9a-f]{1,4}$/i.test(h))) {
    const dec = (hex[0] + hex[1]).padStart(8, '0').match(/.{2}/g)!.map((b) => parseInt(b, 16));
    return dec.join('.');
  }
  return null;
}

/** IPv6 private/loopback/link-local/reserved ranges per the F7 contract:
 *  ::1/128, fc00::/7, fe80::/10, and ::ffff:IPv4-mapped private v4. */
function isPrivateIPv6(address: string): boolean {
  const a = address.toLowerCase();
  if (a === '::1') return true; // loopback
  if (a.startsWith('::ffff:')) {
    const v4 = mappedIpv4Tail(a);
    return v4 !== null && isPrivateIPv4(v4);
  }
  const firstHextet = parseInt(a.split(':')[0], 16);
  if (!Number.isNaN(firstHextet)) {
    if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true; // fc00::/7
    if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true; // fe80::/10
  }
  return false;
}

function isPrivateAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  if (a.length === 0) return false;
  if (a.includes(':')) return isPrivateIPv6(a);
  return isPrivateIPv4(a);
}

// ── Body reader (5 MB cap via stream counter + abort) ─────────────────────

/** Sentinel thrown when the response stream exceeds the 5 MB cap. */
class ResponseTooLargeError extends Error {}

async function readBodyCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ResponseTooLargeError('response too large');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          // Abort the read — cap exceeded.
          throw new ResponseTooLargeError('response too large');
        }
        chunks.push(value);
      }
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      /* non-critical */
    }
    throw error;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Outcome of the capability approval decision (decideCapabilityApproval). */
interface ApprovalDecision {
  ok: boolean;
  /** Static blocked reason when !ok. */
  reason?: string;
}

/**
 * Capability approval decision — Objective 1 of the 2026-09-08 vault
 * workplan (F1 flag binding + F2 service derivation), applied on the owner
 * decision of 2026-09-28 after the class's second occurrence (JEV/FRED;
 * first was ATP, 2026-09-08):
 *
 *  1. The secret's meta is loaded FIRST (caller-scoped, metadata only).
 *     `flags.approval_required` false → ALLOW with no `vault_approvals` row
 *     (the caller of this helper still audits the attempt). The flag is the
 *     dashboard "Approval required" box (default on) and previously had no
 *     reader anywhere in the use path.
 *  2. `approval_required` true (the default) → the approval is checked
 *     against the SECRET's linked service, not the caller's call-time
 *     argument: the call-time service must match it exactly (blocked
 *     'service mismatch' otherwise), then an active (identity,
 *     secret.service) approval is required. This closes the hole where a
 *     caller could satisfy the gate with an approval for a service of their
 *     choosing.
 *  3. A secret with NO linked service falls back to the call-time check
 *     (a '*' grant covers it). Rejecting these outright would break live
 *     flows whose records cannot be corrected yet — workplan Objective 2
 *     (updateSecret) comes first for that.
 *  4. Invisible/absent secrets keep the plain ledger check on the call-time
 *     service — no new existence signal, same blocked reasons as before.
 */
async function decideCapabilityApproval(
  store: VaultStore,
  caller: CallerIdentity,
  secretId: string | undefined,
  callTimeService: string,
): Promise<ApprovalDecision> {
  let meta: SecretMeta | null = null;
  if (secretId !== undefined) {
    try {
      meta = await store.getSecretMeta(caller, secretId);
    } catch {
      meta = null;
    }
  }
  if (meta !== null && meta.flags.approval_required === false) {
    return { ok: true };
  }
  const derivedService = meta !== null ? meta.service : null;
  let serviceToCheck = callTimeService;
  if (derivedService !== null) {
    if (callTimeService !== derivedService) {
      return { ok: false, reason: 'service mismatch' };
    }
    serviceToCheck = derivedService;
  }
  try {
    const approved = await store.hasActiveApproval(caller.user_id, serviceToCheck);
    return approved ? { ok: true } : { ok: false, reason: 'no active approval' };
  } catch {
    return { ok: false, reason: 'no active approval' };
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createCapability(opts: CapabilityOptions = {}): Capability {
  // Lazily resolved defaults so constructing a capability never connects to
  // MongoDB or touches the network (production handlers gate on the DB
  // connection before the first vaultHttp call).
  let lazyStore: VaultStore | undefined;
  const fetchImpl: typeof fetch = opts.fetchImpl ?? globalThis.fetch;
  const resolveHost: (host: string) => Promise<string[]> =
    opts.resolveHost ??
    (async (host: string): Promise<string[]> => {
      const found = await lookup(host, { all: true });
      return found.map((entry) => entry.address);
    });
  const now: () => number = opts.now ?? Date.now;

  /** Mirror of the store's internal writeAudit against the shared
   *  vault_audit collection: {at, actor, action, secret_id, service,
   *  outcome} — and, per the F7 hard rule 7 ('error only on exception'),
   *  the error key ONLY on outcome 'error' rows (static reason text).
   *  Value-free by construction — never called with secret material. Audit
   *  failures are swallowed: a broken audit trail must never leak a secret
   *  through an exception, and must never change the caller-visible result. */
  async function writeCapabilityAudit(row: {
    at: string;
    actor: string;
    action: string;
    secret_id: string;
    service: string;
    outcome: 'ok' | 'denied' | 'error';
    error?: string;
  }): Promise<void> {
    try {
      const { error, ...rest } = row;
      const doc: Record<string, unknown> = { ...rest };
      if (row.outcome === 'error') doc.error = error ?? row.outcome;
      await get_database().collection(AUDIT_COLLECTION).insertOne(doc);
    } catch {
      /* never leak; never throw */
    }
  }

  return {
    async vaultHttp(input: CapabilityInput): Promise<CapabilityResult> {
      const startAt = now();
      const auditAt = new Date(startAt).toISOString();
      // Exactly one audit row per attempt — every terminal path funnels
      // through `finish`.
      let audited = false;
      const actor: string =
        input && typeof input.caller === 'object' && input.caller !== null &&
        typeof input.caller.user_id === 'string'
          ? input.caller.user_id
          : 'unknown';
      async function finish(
        outcome: 'ok' | 'denied' | 'error',
        result: CapabilityResult,
        errorText?: string,
      ): Promise<CapabilityResult> {
        if (!audited) {
          audited = true;
          await writeCapabilityAudit({
            at: auditAt,
            actor,
            action: CAPABILITY_ACTION,
            secret_id: input.secretId,
            service: input.service,
            outcome,
            ...(errorText !== undefined ? { error: errorText } : {}),
          });
        }
        return result;
      }
      const blocked = (reason: string): CapabilityResult => ({
        status: 0,
        body: '',
        blocked: { reason },
      });

      try {
        const store: VaultStore = opts.store ?? (lazyStore ??= createVaultStore());

        // 1 ── Approval gate FIRST — meta-first (no approval → no network
        // activity, audit 'denied'). 2026-09-28 Objective 1: a secret with
        // flags.approval_required=false is allowed with no grant; otherwise
        // the approval is derived from the SECRET's service and the
        // call-time service must match it (blocked 'service mismatch').
        const approval = await decideCapabilityApproval(
          store,
          input.caller,
          input.secretId,
          input.service,
        );
        if (!approval.ok) {
          return finish('denied', blocked(approval.reason ?? 'no active approval'));
        }

        // 2 ── Method whitelist.
        if (!ALLOWED_METHODS.has(input.method)) {
          return finish('denied', blocked('method not allowed'));
        }

        // 3 ── Content rules (before ANY network activity): extra headers
        // are allowlisted names only, bounded; body and body_template are
        // mutually exclusive.
        if (input.headers !== undefined) {
          const entries = Object.entries(input.headers as Record<string, unknown>);
          const headerShapeInvalid =
            entries.length > MAX_EXTRA_HEADERS ||
            entries.some(
              ([name, value]) =>
                typeof name !== 'string' ||
                name.trim().length === 0 ||
                !SAFE_EXTRA_HEADERS.has(name.trim().toLowerCase()) ||
                typeof value !== 'string' ||
                value.length > MAX_HEADER_VALUE_LENGTH,
            );
          if (headerShapeInvalid) {
            return finish('denied', blocked('header not allowed'));
          }
        }
        if (input.bodyTemplate !== undefined && input.body !== undefined) {
          return finish(
            'denied',
            blocked('body and body_template are mutually exclusive'),
          );
        }
        // At least one injection target is required: a named header, a
        // body template, or a raw body. Body-only flows (e.g. form-encoded
        // logins) must not be forced to leak the secret into a header.
        if (
          (!input.injectHeader || input.injectHeader.length === 0) &&
          input.bodyTemplate === undefined &&
          input.body === undefined
        ) {
          return finish(
            'denied',
            blocked('no injection target (inject_header, body_template or body)'),
          );
        }

        // 3 ── SSRF pre-flight (before any connection).
        let parsed: URL;
        try {
          parsed = new URL(input.url);
        } catch {
          return finish('denied', blocked('invalid url'));
        }
        if (parsed.protocol !== 'https:') {
          return finish('denied', blocked('scheme not allowed'));
        }
        if (parsed.username !== '' || parsed.password !== '') {
          return finish('denied', blocked('userinfo not allowed'));
        }
        const port = parsed.port === '' ? '443' : parsed.port;
        if (port !== '443') {
          return finish('denied', blocked('port not allowed'));
        }
        let addresses: string[];
        try {
          addresses = await resolveHost(parsed.hostname);
        } catch {
          return finish('denied', blocked('host not resolvable'));
        }
        if (!Array.isArray(addresses) || addresses.length === 0) {
          return finish('denied', blocked('host not resolvable'));
        }
        if (addresses.some((address) => isPrivateAddress(address))) {
          return finish('denied', blocked('private address'));
        }

        // 4 ── RBAC: open the secret under the caller's read scope.
        let secret: string;
        try {
          secret = await store.openSecretValue(input.caller, input.secretId);
        } catch {
          return finish('denied', blocked('secret not available'));
        }

        // 5 ── Body assembly: body_template substitutes every {{secret}}
        // token with the resolved secret; body passes through untouched.
        let requestBody: string | undefined;
        if (input.bodyTemplate !== undefined) {
          requestBody = input.bodyTemplate.split(BODY_SECRET_TOKEN).join(secret);
        } else {
          requestBody = input.body;
        }

        // 6 ── Outbound request: secret ONLY as the named header and/or
        // the substituted body template; manual redirects; 30 s deadline
        // enforced via AbortSignal + injectable now(); 5 MB body cap on
        // the read. The injected header is set LAST so it always wins a
        // name collision with a caller-supplied extra header.
        const controller = new AbortController();
        const deadline = startAt + TIMEOUT_MS;
        let timedOut = false;
        let pollerHandle: NodeJS.Timeout | undefined;
        const deadlineReached = new Promise<never>((_, reject) => {
          const tick = (): void => {
            if (now() >= deadline) {
              timedOut = true;
              controller.abort();
              reject(new Error('timeout'));
              return;
            }
            pollerHandle = setTimeout(tick, TIMEOUT_POLL_MS);
          };
          pollerHandle = setTimeout(tick, TIMEOUT_POLL_MS);
        });
        const outHeaders: Record<string, string> = {};
        if (input.headers !== undefined) {
          for (const [name, value] of Object.entries(input.headers)) {
            outHeaders[name] = value;
          }
        }
        if (input.injectHeader && input.injectHeader.length > 0) {
          const headerValue = input.injectScheme
            ? `${input.injectScheme} ${secret}`
            : secret;
          outHeaders[input.injectHeader] = headerValue;
        }
        const init: RequestInit = {
          method: input.method,
          headers: outHeaders,
          redirect: 'manual',
          signal: controller.signal,
        };
        // Node forbids request bodies on GET/HEAD — the whitelist still
        // admits them, so a submitted body is simply not attached there.
        if (requestBody !== undefined && input.method !== 'GET' && input.method !== 'HEAD') {
          init.body = requestBody;
        }
        try {
          const response = await Promise.race([
            (async (): Promise<Response> => fetchImpl(input.url, init))(),
            deadlineReached,
          ]);
          const status = response.status;
          // Set-Cookie response headers are session material (value-safe)
          // and are surfaced bounded by count and total bytes.
          let setCookies: string[] | undefined;
          try {
            const rawCookies =
              typeof (response.headers as Headers).getSetCookie === 'function'
                ? (response.headers as Headers).getSetCookie()
                : [];
            const collected: string[] = [];
            let totalBytes = 0;
            for (const cookie of rawCookies) {
              if (typeof cookie !== 'string' || cookie.length > 1024) continue;
              if (collected.length >= MAX_SET_COOKIE_HEADERS) break;
              totalBytes += cookie.length;
              if (totalBytes > MAX_SET_COOKIE_TOTAL_BYTES) break;
              collected.push(cookie);
            }
            setCookies = collected.length > 0 ? collected : undefined;
          } catch {
            setCookies = undefined;
          }
          let body: string;
          try {
            body = await readBodyCapped(response);
          } catch (error) {
            if (error instanceof ResponseTooLargeError) {
              return finish('error', blocked('response too large'), 'response too large');
            }
            throw error;
          }
          return finish(
            'ok',
            setCookies !== undefined ? { status, body, setCookies } : { status, body },
          );
        } catch (error) {
          if (timedOut) {
            return finish('error', blocked('timeout'), 'timeout');
          }
          return finish('error', blocked('request failed'), 'request failed');
        } finally {
          if (pollerHandle !== undefined) clearTimeout(pollerHandle);
        }
      } catch {
        // Unexpected infrastructure failure — blocked reason only, never
        // the secret, exactly one audit row.
        return finish('error', blocked('request failed'), 'request failed');
      }
    },

    /** Typed Instagram login: approval-gated + RBAC-opened server-side.
     *  The plaintext password is passed ONLY to the injected driver (never
     *  into results/errors/logs/audit). Returns derived session material. */
    async instagramLogin(input: InstagramLoginInput): Promise<InstagramLoginResult> {
      const startAt = now();
      const auditAt = new Date(startAt).toISOString();
      const actor: string =
        input && typeof input.caller === 'object' && input.caller !== null &&
        typeof input.caller.user_id === 'string'
          ? input.caller.user_id
          : 'unknown';
      let audited = false;
      const blocked = (reason: string): InstagramLoginResult => ({
        ok: false,
        blocked: { reason },
      });
      async function finish(
        outcome: 'ok' | 'denied' | 'error',
        result: InstagramLoginResult,
        errorText?: string,
      ): Promise<InstagramLoginResult> {
        if (!audited) {
          audited = true;
          await writeCapabilityAudit({
            at: auditAt,
            actor,
            action: 'instagram_login',
            secret_id: input.secretId ?? '',
            service: input.service,
            outcome,
            ...(errorText !== undefined ? { error: errorText } : {}),
          });
        }
        return result;
      }

      try {
        // Shape gate: username is caller text, bounded, single line.
        if (
          typeof input.username !== 'string' ||
          input.username.length === 0 ||
          input.username.length > 128 ||
          /[\r\n]/.test(input.username)
        ) {
          return finish('denied', blocked('invalid username'));
        }
        const hasSession =
          typeof input.session === 'string' && input.session.length > 0;
        const hasSecretId =
          typeof input.secretId === 'string' && input.secretId.length > 0;
        if (!input.service || input.service.length === 0) {
          return finish('denied', blocked('invalid capability request'));
        }
        if (!hasSession && !hasSecretId) {
          return finish(
            'denied',
            blocked('session or secret_id required'),
          );
        }

        // Approval gate FIRST — identical to vaultHttp (2026-09-28
        // Objective 1 flag binding + service derivation; a session-only
        // login has no secret to inspect and keeps the call-time check).
        const store: VaultStore = opts.store ?? (lazyStore ??= createVaultStore());
        const approval = await decideCapabilityApproval(
          store,
          input.caller,
          hasSecretId ? (input.secretId as string) : undefined,
          input.service,
        );
        if (!approval.ok) {
          return finish('denied', blocked(approval.reason ?? 'no active approval'));
        }

        const driver = opts.instagramLoginFn ?? defaultInstagramLoginFn(fetchImpl);
        const callDriver = (args: {
          username: string;
          password?: string;
          session?: string;
        }): Promise<InstagramDriverOutcome> =>
          Promise.race([
            driver(args),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('ig-login-timeout')),
                INSTAGRAM_LOGIN_TIMEOUT_MS,
              ),
            ),
          ]);

        const buildResult = (outcome: InstagramDriverOutcome): InstagramLoginResult => ({
          ok: true,
          username: input.username,
          userIdPk: outcome.userIdPk,
          sessionid: outcome.sessionid,
          csrftoken: outcome.csrftoken,
          session: outcome.session,
        });

        // Value-free failure taxonomy passthrough (the loop director 2026-09-13): the
        // driver's exception class + sanitized IG message let the caller
        // tell checkpoint / challenge / rate-limit apart. Bounded defensively
        // here too; never secret material.
        const failureInfo = (outcome?: InstagramDriverOutcome | null): Pick<InstagramLoginResult, 'class' | 'message'> => {
          const klass =
            typeof outcome?.class === 'string' ? outcome.class.slice(0, 80) : undefined;
          const message =
            typeof outcome?.message === 'string' ? outcome.message.slice(0, 240) : undefined;
          return {
            ...(klass ? { class: klass } : {}),
            ...(message ? { message } : {}),
          };
        };

        // 1 ── Session reuse first: rehydrate without touching the password.
        if (hasSession) {
          let reuseOutcome: InstagramDriverOutcome | undefined;
          try {
            const reused = await callDriver({
              username: input.username,
              session: input.session,
            });
            if (reused && reused.ok === true) {
              return finish('ok', buildResult(reused));
            }
            reuseOutcome = reused ?? undefined;
          } catch {
            /* fall through to the password path when a secret is available */
          }
          if (!hasSecretId) {
            return finish(
              'error',
              {
                ok: false,
                blocked: { reason: 'session expired and no secret available' },
                ...failureInfo(reuseOutcome),
              },
              'session expired and no secret available',
            );
          }
        }

        // 2 ── Fresh password login: RBAC-open the secret server-side; it
        // never leaves this scope except into the driver call.
        let secret: string;
        try {
          secret = await store.openSecretValue(input.caller, input.secretId!);
        } catch {
          return finish('denied', blocked('secret not available'));
        }

        try {
          const outcome = await callDriver({
            username: input.username,
            password: secret,
          });
          if (!outcome || outcome.ok !== true) {
            return finish(
              'error',
              {
                ok: false,
                blocked: { reason: 'instagram login failed' },
                ...failureInfo(outcome),
              },
              'instagram login failed',
            );
          }
          return finish('ok', buildResult(outcome));
        } catch {
          // Static failure text only — driver errors may echo secret-adjacent
          // context and must never surface.
          return finish('error', blocked('instagram login failed'), 'instagram login failed');
        }
      } catch {
        return finish('error', blocked('instagram login failed'), 'instagram login failed');
      }
    },
  };
}
