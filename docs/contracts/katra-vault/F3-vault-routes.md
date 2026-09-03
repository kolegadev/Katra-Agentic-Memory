# CONTRACT — F3: Katra Vault REST routes + MCP tools (redacted surface)

Source of truth: `docs/katra-vault-design.md` §7.2, §9.

## Goal
Expose the vault through (a) REST routes at `/api/v1/vault/*` and (b) six MCP
tools, all backed by F2's store, with **hard redaction**: no tool result or
REST response ever contains a raw value, envelope, or plaintext.

## Boundaries — MUST NOT touch
- `dashboard/**`, `server/src/services/processing/**`,
  `server/src/services/orchestration/**`, `server/src/services/memory/**`
- `server/src/services/vault/crypto.ts` (F1 — consume only)
- `install.sh`, `.env.example`, `server/package.json`
- Any existing test file, and any route file other than the new one

## Files this feature may create/modify
- MODIFY `server/src/services/vault/store.ts` (narrow, two additions only):
  1. `PutSecretInput` gains optional `ownerUserId?: string` — honored **only**
     when `caller.trusted` (sets `owner.user_id = ownerUserId`, private scope);
     when the caller is untrusted the field is **ignored** (still pinned to own
     identity). All existing F2 semantics stay untouched.
  2. New store method `listAudit(caller: CallerIdentity, opts?: { secretId?: string; limit?: number }): Promise<AuditRow[]>` —
     untrusted callers see only rows where `actor === caller.user_id`; trusted
     callers see all rows; newest first; default limit 100.
- NEW `server/src/routes/vault-routes.ts` (Hono router, style of memory-routes.ts)
- MODIFY `server/src/index.ts` — mount ONE line: `app.route('/api/v1/vault', create_vault_routes());`
- MODIFY `server/src/mcp-server.ts` — register 6 tools + dispatch (see below)
- NEW `server/tests/unit/vault/routes.test.ts`, NEW `server/tests/unit/vault/mcp-tools.test.ts`

## REST surface (all under existing caller-auth middleware — NOT in AUTH_SKIP_PATHS)
| Method | Path | Behavior |
|---|---|---|
| POST | `/api/v1/vault/secrets` | body {name, value, scope?, service?, kind?, aclReaders?, approvalRequired?, rotatable?, ownerUserId?}; calls store.putSecret; 201 {secret_id, created} |
| GET | `/api/v1/vault/secrets` | store.listSecrets → 200 [SecretMeta...] (no envelopes) |
| GET | `/api/v1/vault/secrets/:id` | store.getSecretMeta → 200 meta or 404 |
| DELETE | `/api/v1/vault/secrets/:id` | store.deleteSecret → 200 {deleted} |
| POST | `/api/v1/vault/secrets/:id/rotate` | store.rotateSecret → 200 {rotated} |
| GET | `/api/v1/vault/audit?secret_id=&limit=` | store.listAudit → 200 [audit rows] |

Errors: unknown route param shapes → 400; not-found → 404; RBAC denial →
403; master key missing on put → 503 with body containing
`vault: master key not configured`. Never include the value anywhere.

## MCP tools (6 — register in mcp-server.ts following the existing zod →
zodToJsonSchema → handler pattern used by tools like get_heartbeat_status)
1. `vault_put_secret` — **operator only**: if `!caller.trusted` return error
   'operator only'. Args: {name, value, scope?, service?, kind?, aclReaders?,
   ownerUserId?}. Returns {secret_id, created}.
2. `vault_list_secrets` — caller-scoped list, returns [SecretMeta].
3. `vault_get_secret` — returns **redacted**: {secret_id, name, scope
   ('private'|'team'), service, length (value string length), last_used_at,
   status: 'active', value: '<redacted>'} — NEVER the real value. 404-equivalent
   error when not visible.
4. `vault_delete_secret` — {secret_id} → {deleted}.
5. `vault_rotate_secret` — {secret_id} → {rotated}.
6. `vault_audit` — {secret_id?, limit?} → caller-scoped audit rows.

All tools attribute work to the current caller (getCaller() from
utils/caller-identity.js) — the existing MCP request flow already resolves
caller identity; follow the exact pattern of existing caller-aware tools.

## Success criteria (all must pass)
1. REST: untrusted caller POSTs private secret → 201; stored `owner.user_id` == caller.
2. REST: untrusted caller POSTs with `ownerUserId: 'lilly'` → **ignored**; stored owner is caller (IDOR guard restored at route layer).
3. REST: trusted caller POSTs with `ownerUserId: 'lilly'` → stored under lilly.
4. REST list: caller B cannot see caller A's private secret; both see team secrets.
5. REST GET secret: response key set ⊆ SecretMeta keys; no envelope/value/ciphertext anywhere in body (assert substring absence).
6. REST DELETE/rotate: non-owner untrusted → 403 and row unchanged; owner → 200.
7. REST audit: untrusted sees only own actor rows; trusted sees all.
8. MCP: the 6 tools are registered with exact names and work end-to-end against the store; vault_get_secret result contains value '<redacted>' and length but NOT the plaintext.
9. MCP: vault_put_secret rejects untrusted callers with 'operator only'.
10. Master key missing: POST secret → 503 with 'vault: master key not configured'; GET list still 200.
11. index.ts mounts exactly one new route; AUTH_SKIP_PATHS unchanged (vault routes REQUIRE auth).
12. Full suite: zero NEW failures (only the 5 known pre-existing).

## Acceptance command
```
cd server && npx vitest run tests/unit/vault/routes.test.ts tests/unit/vault/mcp-tools.test.ts && npm test
```

## Implementation notes
- Route tests: follow `tests/unit/reflection-routes-caller.test.ts` and
  `tests/helpers/{auth,db,mcp}.ts` patterns — simulate callers via
  `runWithCaller(...)` around handler invocation (no real HTTP needed), test_
  prefixed collections, cleanup in afterAll.
- MCP tests: follow the pattern of existing MCP tool tests (see how other tools
  are invoked with a caller context — read-tools-caller-pinning.test.ts).
- Keep store.ts changes to exactly the two additions above; F2 tests must
  still pass unchanged.
- No console.log of values; redaction applies to errors too (error messages
  must not echo the submitted value).
