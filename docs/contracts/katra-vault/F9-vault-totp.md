# CONTRACT — F9: Katra Vault TOTP agent authentication (RFC 6238 + sessions)

Source of truth: `docs/katra-vault-design.md` §8, §9.

## Goal
The TOTP auth MECHANISM per spec §8: RFC 6238 TOTP (node:crypto only) with
encrypted per-identity enrollment, QR-URI issuance, short-lived session tokens
issued only against a valid TOTP code, replay protection, revocation, and the
per-identity auth policy table. This feature delivers the mechanism and policy
lookup; ENFORCEMENT (requiring sessions on the existing MCP/REST paths) is a
separate cutover step (policy flag `require_totp` default false — John flips
it when the team is enrolled).

## Boundaries — MUST NOT touch
- Existing auth enforcement: caller-auth middleware, api-key-manager,
  mcp-server dispatch auth — NO behavior change to current key auth.
- `server/src/services/vault/{crypto,store,denylist,capability}.ts` + drivers,
  migration — consume only.
- Dashboard, processing pipeline, package.json, install.sh, .env.example

## Files this feature may create/modify
- NEW `server/src/services/vault/totp.ts` — pure RFC 6238 (no deps)
- NEW `server/src/services/vault/auth.ts` — enrollment/sessions/policy service
- MODIFY `server/src/routes/vault-routes.ts` — ADD 4 auth endpoints (mounted
  under the SAME /api/v1/vault router? NO — spec wants `/api/v1/auth/*`:
  create the routes in vault-routes.ts but mount a second router in index.ts:
  `app.route('/api/v1/auth', create_vault_routes({ authOnly: true }))` — the
  Generator may instead export a separate `create_auth_routes()` from
  vault-routes.ts and mount it in index.ts; choose the cleaner of the two and
  keep it to ONE additional mount line in index.ts.)
- MODIFY `server/src/mcp-server.ts` — ADD 4 tools (below)
- NEW `server/tests/unit/vault/totp.test.ts`, NEW `server/tests/unit/vault/auth.test.ts`

## totp.ts (pure, exact interface)
```ts
export function generateTotpSecret(bytes?: number): string;        // base32 (RFC 4648, no padding), default 20 bytes
export function totpCode(secretBase32: string, opts?: { time?: number; step?: number; digits?: number }): string;
// RFC 6238 HMAC-SHA1; step default 30 s; digits default 6; time default Date.now()/1000
export function verifyTotp(secretBase32: string, code: string, opts?: {
  time?: number; window?: number; step?: number; digits?: number;
  lastCounter?: number;   // replay guard: reject if counter <= lastCounter
}): { ok: boolean; counter: number };
// window default 1 (±1 step); returns counter = floor(time/step)
export function otpauthUri(identity: string, secretBase32: string, issuer?: string): string;
// otpauth://totp/Katra:<identity>?secret=<secret>&issuer=<issuer|'Katra'>&algorithm=SHA1&digits=6&period=30
```
Must match RFC 6238 SHA1 test vectors (secret ASCII "12345678901234567890" →
base32 "GEZDGNBVGEZDGNBVGEZDGNBVGEZDGNBV"; expected codes at T=59/1111111111:
94287082 … T=2000000000: 69279037 — implement the full vector table).

## auth.ts (service)
```ts
export interface AuthPolicy { class: 'interactive' | 'unattended' | 'trusted';
  require_totp: boolean; session_ttl_hours: number; }
export const DEFAULT_AUTH_POLICY: Record<string, AuthPolicy>;
// interactive: shoshin, zanshin, lilly, satori-interactive-default
// unattended: satori (heartbeat), gas-law-watcher
// trusted: loopback + admin key (class trusted, require_totp false)
// session_ttl_hours default 12; unattended 720 (device-bound, not session-based)
export function getAuthPolicy(identity: string): AuthPolicy;       // defaults + system_settings['auth_policy'] overrides (cached ≤60s)
export function createAuthService(opts?: {
  store?: VaultStore; sessionsCollection?: string;               // default 'auth_sessions'
  now?: () => number;
}): AuthService;
export interface AuthService {
  enrollTotp(op: { caller: CallerIdentity; identity?: string; issuer?: string }):
    Promise<{ enrolled: boolean; identity: string; otpauth_uri: string | null; secret_id: string | null; reason?: string }>;
    // operator-only when identity !== caller.user_id; generates fresh secret,
    // stores via store.putSecret(name 'auth-totp', kind 'totp_secret', scope
    // 'private', ownerUserId identity, service 'auth', approvalRequired false,
    // rotatable false); returns the otpauth URI ONCE at enrollment; re-enroll
    // overwrites (putSecret upsert) and returns a NEW uri.
  issueSession(op: { caller: CallerIdentity; identity?: string; totpCode: string }):
    Promise<{ issued: boolean; token: string | null; expires_at: string | null; reason?: string }>;
    // identity defaults to caller.user_id; opens the identity's stored totp
    // secret (openSecretValue) — caller must have RBAC (own or operator);
    // verifyTotp with replay guard persisted in auth_sessions (last counter
    // per identity); on success mints a 32-byte random token (base64url),
    // stores ONLY its SHA-256 hash in auth_sessions
    // {token_hash, identity, created_at, expires_at (ttl from policy),
    //  revoked_at: null, last_counter}; returns the raw token exactly once.
  validateSession(token: string): Promise<{ valid: boolean; identity: string | null; reason?: string }>;
    // hash lookup; rejects revoked/expired (now()) sessions.
  revokeSession(op: { caller: CallerIdentity; tokenHashOrPrefix?: string }):
    Promise<{ revoked: number }>;   // caller may revoke own sessions; operator any; by exact hash or ≥8-char hash prefix
  listSessions(caller: CallerIdentity): Promise<Array<{ created_at: string; expires_at: string; revoked_at: string | null }>>;
    // caller sees own sessions only; operator sees all (identity included)
}
```
Hard rules:
- The TOTP secret NEVER appears in tool results after enrollment (only the
  otpauth URI at enrollment time); auth_sessions stores hashes only; no
  console.log of secrets/tokens/URIs.
- Replay: verifyTotp with lastCounter rejects reuse within the same step AND
  any counter ≤ last stored counter.
- Every issue/revoke/enroll writes ONE value-free vault_audit row
  (action 'totp_enroll' | 'session_issue' | 'session_revoke', outcome ok|denied|error).
- `auth_totp` / `auth_sessions` names must appear in the F5 denylist — they
  ALREADY DO ('auth_sessions', 'auth_totp' are in VAULT_DENYLISTED_COLLECTIONS;
  the TOTP secret is stored via the vault store under the 'secrets' collection
  which is also denylisted — NO denylist changes needed; verify by test that
  the collections used are covered).

## MCP tools (4)
- `auth_enroll_totp` — operator only ('operator only' error); {identity, issuer?}
  → {enrolled, identity, otpauth_uri} (URI only when enrolled).
- `auth_issue_session` — {identity?, totp_code} → {issued, token, expires_at};
  token returned once; errors static ('invalid TOTP code', 'not enrolled').
- `auth_revoke_session` — {token_hash?} → {revoked}.
- `auth_session_status` — {} → caller's session list.

## REST (mounted at /api/v1/auth)
| Method | Path | Behavior |
|---|---|---|
| POST | `/api/v1/auth/enroll-totp` | operator; {identity, issuer?} → 201 {enrolled, identity, otpauth_uri} |
| POST | `/api/v1/auth/session` | {identity?, totp_code} → 201 {issued, token, expires_at} |
| DELETE | `/api/v1/auth/session` | {token_hash?} → 200 {revoked} |
| GET | `/api/v1/auth/sessions` | caller-scoped list |

## Success criteria (tests — all must pass)
1. RFC 6238 vectors: totpCode/verifyTotp reproduce the published SHA1 test
   vector table exactly.
2. verifyTotp window ±1 accepted, ±2 rejected; wrong digits rejected.
3. Replay guard: same code twice → second {ok:false}; older counter rejected.
4. otpauthUri format exact (`otpauth://totp/Katra:<identity>?secret=<b32>&issuer=Katra&algorithm=SHA1&digits=6&period=30`).
5. enrollTotp: operator enrolls for 'lilly' → enrolled, otpauth_uri present;
   stored secret is encrypted (raw doc has envelope, no base32 plaintext);
   openSecretValue by lilly recovers the base32; re-enroll returns a NEW uri
   and the old code stops verifying.
6. issueSession: correct code (computed from the enrolled secret via totpCode
   at fixed injected time) → token + expires_at = now + policy ttl; wrong code
   → {issued:false, reason 'invalid TOTP code'} + denied audit; token never
   logged/stored raw (DB stores only SHA-256 hash).
7. validateSession: valid token → {valid:true, identity}; expired (inject now
   beyond ttl) → invalid; revoked → invalid.
8. Replay on issue: same TOTP code twice → second issue denied.
9. Policy: getAuthPolicy defaults per table; override in system_settings
   honored; unattended 'satori' → require_totp false.
10. revoke/list: caller revokes own session; operator revokes any (hash
    prefix ≥8 chars); list scoped.
11. Audit: enroll/issue/revoke rows value-free (whitelist keys).
12. MCP 4 tools registered + operator gate on enroll; REST 4 endpoints
    mounted at /api/v1/auth with getCaller().
13. Full suite zero NEW failures (known pre-existing set only); tsc clean;
    all prior vault tests green.

## Acceptance command
```
cd server && npx vitest run tests/unit/vault/totp.test.ts tests/unit/vault/auth.test.ts && npm test && npx tsc --noEmit
```

## Implementation notes
- HMAC-SHA1 via `node:crypto` createHmac; base32 encode/decode helpers in
  totp.ts (no deps; handle case + optional padding + '=' padding on decode).
- Sessions token: `randomBytes(32).toString('base64url')`; hash sha256 hex.
- Reuse store.writeAudit's collection via the store's listAudit-visible
  collection? — audit writes must go to the same 'vault_audit' collection the
  store uses (inject via createAuthService opts or reuse createVaultStore's
  audit collection name from the injected store).
- Keep routes/mcp additions additive and small.
