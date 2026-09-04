/**
 * Katra Vault — capability layer (F7)
 *
 * The ONLY way a secret is ever *used*: an approval-gated, server-side HTTP
 * capability (`vaultHttp`) that opens a secret under the caller's RBAC scope
 * (F2 `openSecretValue`), injects it into ONE outbound request as a single
 * named header, and returns only `{status, body}` (+ a `blocked` reason when
 * the request was refused). The raw secret never appears in results, thrown
 * errors, logs, or audit rows (design docs/katra-vault-design.md §7.3 guard
 * 3, §9; contract F7).
 *
 * Guard order (all hard rules — violation = FAIL):
 *   1. Approval gate FIRST — hasActiveApproval(caller.user_id, service)
 *      (honors the '*' wildcard). No active approval → no network activity.
 *   2. RBAC open — openSecretValue(caller, secretId); a caller can never use
 *      a secret outside their read scope.
 *   3. SSRF pre-flight (before ANY connection): https scheme only; host
 *      resolved via resolveHost; ANY resolved private/loopback/link-local/
 *      reserved address (incl. IPv4-mapped IPv6) blocks; DNS failure blocks;
 *      port 443 only; absolute https URL with no userinfo.
 *   4. Limits: response body capped at 5 MB (stream counted, read aborted),
 *      upstream timeout 30 s (AbortSignal driven by injectable now());
 *      method whitelist GET POST PUT PATCH DELETE HEAD.
 *   5. No redirect following: fetch redirect 'manual' — a 3xx is returned
 *      as-is and never followed (redirects can smuggle SSRF past the
 *      pre-flight).
 *   6. Injection: the resolved secret is set ONLY as the named request
 *      header (`injectHeader`) of the outbound request.
 *   7. Audit: exactly ONE value-free `vault_audit` row per attempt: action
 *      'capability_use', actor, service, secret_id, outcome
 *      'ok'|'denied'|'error', error only on exception. Keys ⊆ the F2
 *      whitelist {at, actor, action, secret_id, service, outcome, error}.
 *   8. Redaction on error: upstream non-2xx statuses are returned as
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
import { createVaultStore, type VaultStore } from './store.js';

// ── Public types (contract F7 exact interfaces) ──────────────────────────

export interface CapabilityInput {
  caller: CallerIdentity;
  /** Full secret_id (e.g. 'lilly/agentmail-api-key'). */
  secretId: string;
  /** Approval service name (e.g. 'agentmail'). */
  service: string;
  /** Whitelist: GET POST PUT PATCH DELETE HEAD. */
  method: string;
  /** https:// only. */
  url: string;
  /** Header name the secret is injected into. */
  injectHeader: string;
  /** Optional auth-scheme prefix for the header value (e.g. 'Bearer' sends
   *  `Authorization: Bearer <secret>`); absent → raw secret is the value. */
  injectScheme?: string;
  /** Optional request body (string). */
  body?: string;
}

export interface CapabilityResult {
  /** Upstream status, or 0 when blocked. */
  status: number;
  /** Upstream response body (never contains the secret). */
  body: string;
  /** Present when the request was refused (pre-flight or limits). */
  blocked?: { reason: string };
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
}

export interface Capability {
  vaultHttp(input: CapabilityInput): Promise<CapabilityResult>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const AUDIT_COLLECTION = 'vault_audit';
const CAPABILITY_ACTION = 'capability_use';
/** 30 s upstream timeout. */
const TIMEOUT_MS = 30_000;
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

        // 1 ── Approval gate FIRST (incl. '*' wildcard). No approval → no
        // network activity, audit 'denied', blocked 'no active approval'.
        let approved = false;
        try {
          approved = await store.hasActiveApproval(input.caller.user_id, input.service);
        } catch {
          approved = false;
        }
        if (!approved) {
          return finish('denied', blocked('no active approval'));
        }

        // 2 ── Method whitelist.
        if (!ALLOWED_METHODS.has(input.method)) {
          return finish('denied', blocked('method not allowed'));
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

        // 5 ── Outbound request: secret ONLY as the named header; manual
        // redirects; 30 s deadline enforced via AbortSignal + injectable
        // now(); 5 MB body cap on the read.
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
        const headerValue = input.injectScheme
          ? `${input.injectScheme} ${secret}`
          : secret;
        const init: RequestInit = {
          method: input.method,
          headers: { [input.injectHeader]: headerValue },
          redirect: 'manual',
          signal: controller.signal,
        };
        // Node forbids request bodies on GET/HEAD — the whitelist still
        // admits them, so a submitted body is simply not attached there.
        if (input.body !== undefined && input.method !== 'GET' && input.method !== 'HEAD') {
          init.body = input.body;
        }
        try {
          const response = await Promise.race([
            (async (): Promise<Response> => fetchImpl(input.url, init))(),
            deadlineReached,
          ]);
          const status = response.status;
          let body: string;
          try {
            body = await readBodyCapped(response);
          } catch (error) {
            if (error instanceof ResponseTooLargeError) {
              return finish('error', blocked('response too large'), 'response too large');
            }
            throw error;
          }
          return finish('ok', { status, body });
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
  };
}
