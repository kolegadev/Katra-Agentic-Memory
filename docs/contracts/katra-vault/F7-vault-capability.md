# CONTRACT — F7: Katra Vault capability layer (vault_http + driver registry)

Source of truth: `docs/katra-vault-design.md` §7.3 (guard 3), §9.

## Goal
The ONLY way a secret is ever *used*: an approval-gated, server-side HTTP
capability (`vault_http`) that injects a resolved secret into an outbound
request and returns only the response body — plus a small per-service driver
registry with a typed AgentMail driver built on it. The raw secret never
appears in any tool result, response, log, or audit row.

## Boundaries — MUST NOT touch
- `server/src/services/vault/{crypto,denylist}.ts` (consume only)
- `store.ts` existing method semantics (F7 may add nothing to the store — it
  USES putSecret/openSecretValue/listAudit + F6 approvals; if a genuinely
  missing read is needed, add it as a new method without touching existing ones)
- Processing pipeline, dashboard, package.json, install.sh, .env.example

## Files this feature may create/modify
- NEW `server/src/services/vault/capability.ts` — the vaultHttp core
- NEW `server/src/services/vault/drivers/index.ts` — registry + Driver type
- NEW `server/src/services/vault/drivers/agentmail.ts` — typed AgentMail driver
- MODIFY `server/src/routes/vault-routes.ts` — ADD POST `/api/v1/vault/capability/http`
- MODIFY `server/src/mcp-server.ts` — ADD tool `vault_http` (+ dispatch/handler)
- NEW `server/tests/unit/vault/capability.test.ts`

## Capability core (exact interface)
```ts
export interface CapabilityInput {
  caller: CallerIdentity;
  secretId: string;            // full secret_id (e.g. 'lilly/agentmail-api-key')
  service: string;             // approval service name (e.g. 'agentmail')
  method: string;              // whitelist: GET POST PUT PATCH DELETE HEAD
  url: string;                 // https:// only
  injectHeader: string;        // header name the secret is injected into
  body?: string;               // optional request body (string)
}
export interface CapabilityResult {
  status: number;              // upstream status or 0 when blocked
  body: string;                // upstream response body (possibly truncated? NO — see limits)
  blocked?: { reason: string } // when the request was refused pre-flight
}
export function createCapability(opts?: {
  store?: VaultStore;          // default: createVaultStore()
  fetchImpl?: typeof fetch;    // injectable for tests (default global fetch)
  resolveHost?: (host: string) => Promise<string[]>;  // hostname -> IPs (default: node:dns.promises.lookup with {all:true})
  now?: () => number;          // default Date.now
}): { vaultHttp(input: CapabilityInput): Promise<CapabilityResult> };
```

## Hard rules (all must hold; violations = FAIL)
1. **Approval gate FIRST**: `hasActiveApproval(caller.user_id, service)` (incl.
   `'*'` wildcard). No active approval → NO network activity (test asserts the
   injected fetch was never called), audit row outcome 'denied', result
   `{status: 0, body: '', blocked: {reason: 'no active approval'}}`.
2. **RBAC**: the secret is opened via `openSecretValue(caller, secretId)` —
   caller cannot use a secret outside their read scope. Open failure → audit
   'denied', `{status:0, body:'', blocked:{reason:'secret not available'}}`,
   no network call.
3. **SSRF pre-flight (before any connection)**:
   - scheme must be `https:` (http → blocked 'scheme not allowed');
   - resolve the host via `resolveHost`; if ANY resolved address is
     private/loopback/link-local/reserved (127.0.0.0/8, 10.0.0.0/8,
     172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 incl. 169.254.169.254,
     0.0.0.0/8, 100.64.0.0/10, ::1/128, fc00::/7, fe80::/10, ::ffff:mapped
     private v4) → blocked 'private address';
   - DNS failure → blocked 'host not resolvable';
   - port must be 443 (explicit :443 or implied; any other port → blocked
     'port not allowed');
   - URL must be absolute http(s) and contain no userinfo (user:pass@ → blocked).
4. **Limits**: response body capped at 5 MB — larger → blocked
   'response too large' (abort the read); upstream timeout 30 s → blocked
   'timeout'. Method not in the whitelist → blocked 'method not allowed'.
5. **No redirect following**: fetch redirect mode 'manual'/'error' — a 3xx
   response is returned as-is (status + body), never followed (redirects can
   smuggle SSRF past pre-flight).
6. **Injection**: the resolved secret is set ONLY as the named request header
   (`injectHeader`) of the outbound request. It never appears in the result,
   in any thrown error, in logs, or in audit rows. (Test: mock fetch captures
   the header value — asserts the header exists with the exact secret AND
   asserts the returned CapabilityResult/audit rows contain no secret
   substring.)
7. **Audit**: exactly one `vault_audit` row per attempt: action
   'capability_use', actor, service, secret_id, outcome
   'ok' | 'denied' | 'error', error only on exception. Keys ⊆ F2 whitelist.
8. **Redaction on error**: upstream non-2xx statuses are returned as
   {status, body} (that is the point of the capability); infrastructure
   failures return blocked reasons only — never the secret.

## Driver registry (NEW drivers/index.ts)
```ts
export interface DriverContext {
  vaultHttp(input: CapabilityInput): Promise<CapabilityResult>;
  caller: CallerIdentity;
  secretId: string;
}
export type DriverOp<A extends unknown[], R> =
  (ctx: DriverContext, ...args: A) => Promise<R>;
export interface ServiceDriver { service: string; ops: Record<string, DriverOp<any[], any>>; }
export function registerDriver(driver: ServiceDriver): void;
export function getDriver(service: string): ServiceDriver | undefined;
```
AgentMail driver (`drivers/agentmail.ts`, service 'agentmail'): typed ops
`inbox_list`, `thread_list` (per inbox), `thread_reply` (threadId, message),
`inbox_create` (name) — each constructs the AgentMail REST request
(https://api.agentmail.to/v0/...; Authorization header = the secret via
`injectHeader: 'Authorization'`, value passed as the raw key) and returns the
parsed upstream body. If you cannot confirm exact AgentMail endpoint shapes
from the repo/web, implement the documented
`https://api.agentmail.to/v0/inboxes` / `/v0/inboxes/:id/threads` /
`/v0/threads/:id/replies` style and mark the file header "endpoints per
agentmail.to v0 public docs (verify at first real use)".

## MCP + REST surfaces
- MCP tool `vault_http`: {secret_id, service, method, url, inject_header,
  body?} → CapabilityResult (blocked reasons surfaced, never secrets).
- REST `POST /api/v1/vault/capability/http`: same input/output JSON;
  caller from getCaller().

## Success criteria (tests — all must pass; mock fetch + mock resolveHost)
1. No approval → blocked 'no active approval', fetch never called, audit denied.
2. Approval active → fetch called once with https URL, method, body; header
   `injectHeader` === the secret value; result {status, body} matches mock
   upstream; audit ok. (Mock upstream: local test HTTP server is fine for the
   FETCH side — the SSRF guard is tested separately with a fake fetchImpl.)
3. Secret redaction: CapabilityResult stringified + audit row JSON + thrown
   error messages contain no secret substring.
4. SSRF: http scheme blocked; each private range blocked via resolveHost
   override returning that IP; 169.254.169.254 blocked; non-443 port blocked;
   userinfo URL blocked; hostname resolving to private IP blocked WITHOUT the
   fetch being called.
5. Redirect: fetchImpl returns 302 → result.status 302 returned, no second
   fetch call (assert fetch called exactly once).
6. Limits: >5 MB mock body → blocked 'response too large'; slow mock (never
   resolves) with injected now() advancing >30 s → blocked 'timeout'; bad
   method → blocked 'method not allowed'.
7. RBAC: caller using another user's private secret → blocked 'secret not
   available' (no fetch).
8. Wildcard approval '*' allows the call.
9. Drivers: registerDriver/getDriver; agentmail ops construct the right URL
   shape and inject the Authorization header (mock fetch asserts); unknown
   service via getDriver → undefined.
10. MCP tool `vault_http` registered + handler wired; REST endpoint present
    with caller from getCaller().
11. Full suite zero NEW failures (known pre-existing set only); tsc clean;
    F1-F6 vault tests still green.

## Acceptance command
```
cd server && npx vitest run tests/unit/vault/capability.test.ts && npm test && npx tsc --noEmit
```

## Implementation notes
- IP-range checks: implement in plain JS (no new deps) over the resolved
  address strings; handle IPv4 and IPv6 and IPv4-mapped IPv6.
- `node:dns.promises.lookup(host, {all: true})` is the default resolveHost.
- Use global `fetch` (Node >= 18) with `redirect: 'manual'`, `signal` for the
  30 s timeout; enforce the 5 MB cap by reading the stream with a counter and
  aborting.
- Audit via the store's writeAudit path (reuse the same helper the store uses —
  do not reimplement).

## AMENDMENTS (2026-09-04, live team testing with John)
1. `CapabilityInput.injectScheme?: string` — when present, the outbound header
   value is `"<scheme> <secret>"` (e.g. `Bearer <PAT>`); absent → raw secret.
   Discovered when a valid GitHub PAT (stored as a team secret) returned 401
   from api.github.com/user because GitHub requires the Bearer prefix. Wired
   through REST `inject_scheme` and MCP `vault_http`; covered by criterion 2b.
   Live end-to-end proof: lilly + github approval + team PAT + inject_scheme
   Bearer → api.github.com/user 200 (login kolegadev), PAT never in response.
