# CONTRACT — F6: Katra Vault per-service approvals (grant / revoke / list)

Source of truth: `docs/katra-vault-design.md` §7.3 ("Per-service approval"), §9.

## Goal
The approval ledger that gates secret USE: a `vault_approvals` collection with
operator-only grant/revoke, time-bound expiry (default 30d), caller-scoped
listing, value-free audit events, REST + MCP surfaces, and an additive
dashboard section for the human operator to grant/revoke approvals.

## Boundaries — MUST NOT touch
- `server/src/services/vault/{crypto,denylist}.ts` (consume only)
- `store.ts`: F6 may ADD approval methods but must NOT alter existing method
  semantics; existing F2/F3 tests must pass unchanged.
- Processing pipeline (F5 denylist already covers `vault_approvals` — no new
  denylist work).
- `server/package.json`, `install.sh`, `.env.example`

## Files this feature may create/modify
- MODIFY `server/src/services/vault/store.ts` — ADD approval methods + optional
  `approvalsCollection` factory option (default `'vault_approvals'`).
- MODIFY `server/src/routes/vault-routes.ts` — ADD 3 endpoints.
- MODIFY `server/src/mcp-server.ts` — ADD 3 tools.
- MODIFY `dashboard/index.html` — ADD approvals section (additive only).
- NEW `server/tests/unit/vault/approvals.test.ts`

## Data model (collection `vault_approvals`)
```ts
export interface ServiceApproval {
  _id?: unknown;                    // Mongo id (not exposed)
  identity: string;                 // the user_id granted (e.g. 'lilly')
  service: string;                  // e.g. 'agentmail' | 'gcloud' | '*'
  granted_by: string;
  granted_at: string;               // ISO
  expires_at: string;               // ISO; default now + 30 days
  revoked_at: string | null;        // ISO when revoked
  status: 'active' | 'revoked' | 'expired';  // computed on read
}
```
- `'*'` service = wildcard grant (any service) — accepted and honored.
- `hasActiveApproval(identity, service)` must accept the wildcard.

## Store additions (exact signatures)
```ts
export interface VaultStore {
  // ... existing methods unchanged ...
  grantApproval(op: { caller: CallerIdentity; identity: string; service: string; ttlDays?: number }):
    Promise<{ granted: boolean; approval: ServiceApproval }>;
  revokeApproval(op: { caller: CallerIdentity; identity: string; service: string }):
    Promise<{ revoked: boolean }>;
  listApprovals(caller: CallerIdentity): Promise<ServiceApproval[]>;
  hasActiveApproval(identity: string, service: string): Promise<boolean>;
}
```
Semantics:
- grant/revoke: **trusted (operator) only** — untrusted callers get a
  `{ granted: false }` / `{ revoked: false }` result (no throw, no audit write
  of a grant) and an audit row with outcome 'denied'.
- grant is idempotent per (identity, service): re-granting an active grant
  extends `expires_at` from now (returns granted: true) rather than
  duplicating rows.
- revoked rows: `revoked_at` set, status 'revoked'; a revoked grant may be
  re-granted (new expires_at, revoked_at null).
- `hasActiveApproval`: true only when status active AND expires_at > now
  (wildcard '*' counts).
- Audit: grant/revoke/denied attempts write ONE vault_audit row each
  (action 'approval_grant' | 'approval_revoke', outcome 'ok' | 'denied',
  actor, service, secret_id null). Value-free — no envelope/value fields.

## REST additions (vault-routes.ts)
| Method | Path | Behavior |
|---|---|---|
| POST | `/api/v1/vault/approvals` | operator: body {identity, service, ttlDays?} → 201 {granted, approval}; untrusted → 403 |
| DELETE | `/api/v1/vault/approvals?identity=&service=` | operator → 200 {revoked}; untrusted → 403 |
| GET | `/api/v1/vault/approvals` | caller-scoped: untrusted sees own identity's grants; trusted sees all → 200 [ServiceApproval] |

## MCP additions (3 tools, existing zod → dispatch pattern)
- `vault_approve_service` — operator only ('operator only' error otherwise):
  {identity, service, ttlDays?} → {granted, approval}
- `vault_revoke_approval` — operator only: {identity, service} → {revoked}
- `vault_list_approvals` — caller-scoped list (no args) → [ServiceApproval]

## Dashboard additions (additive)
Approvals panel inside the existing Secrets section (or a sibling card):
- table of approvals (identity, service, granted_by, granted_at, expires_at,
  status) via GET /api/v1/vault/approvals
- grant form: identity, service, ttlDays (default 30) → POST approvals
- revoke button per row → DELETE approvals
- SAME escaping standards as F4: all API-derived strings rendered via
  textContent or an escaping function; no inline onclick with single-quoted
  attribute context (use the F4-safe pattern: escape ' as \u0027 or
  addEventListener); no value storage/logging. Approvals carry NO secret
  values, but the same discipline applies to identity/service strings.

## Success criteria (all must pass)
1. Untrusted grant/revoke → {granted:false}/{revoked:false} + 'denied' audit row; NO approval row created/updated.
2. Operator grant → active row with expires_at = granted_at + 30d (ISO, ±60s); audit 'approval_grant' ok.
3. Idempotent re-grant: same (identity, service) → single row, extended expires_at.
4. hasActiveApproval: true within expiry; false after expiry (inject a past expires_at); false when revoked; wildcard '*' true for any service.
5. Revoke: status revoked + revoked_at set; re-grant after revoke works.
6. listApprovals caller-scoped: untrusted sees only own identity rows (trusted: all).
7. REST 403 for untrusted POST/DELETE; GET scoped; 201/200 shapes per table.
8. MCP: operator-only enforcement ('operator only' before any store work); 3 tools registered with exact names.
9. Dashboard: approval table/grant/revoke wired to the endpoints with F4-grade escaping (Verifier applies the F4 adversarial XSS checks to the new markup).
10. Audit rows for approval actions are value-free and use the F2 whitelist keys.
11. Full suite zero NEW failures (known pre-existing set only); `npx tsc --noEmit` clean; F2/F3 approval-adjacent tests unchanged.

## Acceptance command
```
cd server && npx vitest run tests/unit/vault/approvals.test.ts && npm test && npx tsc --noEmit
```

## Implementation notes
- `vault_approvals` is already in F5's denylist — do not re-add; the security
  suite must still pass.
- Dates: ISO strings, compare with `Date.now()`.
- Keep dashboard diff additive; reuse F4's vaultEsc/vaultJsId (import them —
  they are in the same inline script scope).
