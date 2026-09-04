# CONTRACT — F2: Katra Vault store layer (secrets collection + RBAC + audit)

Source of truth: `docs/katra-vault-design.md` §4 (data model), §6 (RBAC), §7.3 (audit).

## Goal
A store service that persists encrypted secrets in MongoDB with scope RBAC
reusing Katra's identity machinery, and writes a **value-free** audit trail.
Every stored secret is an envelope produced by F1's crypto module — the store
never sees plaintext at rest and never logs it.

## Boundaries — MUST NOT touch
- `server/src/routes/**`, `server/src/mcp-server.ts`, `dashboard/**`, `server/src/index.ts`
- `server/src/services/vault/crypto.ts` (consume it, do not modify it)
- `server/src/services/memory/**`, `server/src/services/processing/**`, `server/src/services/orchestration/**`
- `server/package.json`, `install.sh`, `.env.example`
- Existing tests (only ADD tests)

## Files this feature may create/modify
- NEW `server/src/services/vault/store.ts`
- NEW `server/tests/unit/vault/store.test.ts`

## Data model (collection `secrets`, spec §4)
```ts
export interface SecretRecord {
  secret_id: string;                       // "<owner>/<name>" or "team:<shared_id>/<name>"
  name: string;
  owner: { user_id?: string; shared_id?: string }; // exactly one set
  acl: { readers: string[] };              // extra readers beyond owner (default [])
  service: string | null;                  // service linking, e.g. "agentmail"
  kind: 'api_key' | 'password' | 'token' | 'totp_secret' | 'env';
  envelope: VaultEnvelope;                 // from F1 crypto.ts
  meta: {
    created_by: string; created_at: string; updated_at: string;
    last_used_at: string | null; rotation_due_at: string | null;
  };
  flags: { rotatable: boolean; approval_required: boolean };
}
export type SecretMeta = Omit<SecretRecord, 'envelope'>;   // what list/get may return
```
`vault_audit` collection rows: `{ at, actor, action, secret_id, service, outcome, error? }`
— **never** the value, envelope, or plaintext.

## Interfaces (exact signatures)
```ts
import type { CallerIdentity } from '../../../utils/caller-identity.js';
import type { VaultEnvelope } from './crypto.js';

export interface PutSecretInput {
  caller: CallerIdentity;
  name: string;                 // non-empty, <= 128 chars, no '/'
  value: string;                // non-empty secret value
  scope?: 'private' | 'team';   // default 'private'
  service?: string | null;
  kind?: SecretRecord['kind'];  // default 'api_key'
  aclReaders?: string[];        // extra readers (trusted callers only, spec §6)
  approvalRequired?: boolean;   // default true
  rotatable?: boolean;          // default true
}

export function createVaultStore(opts?: {
  db?: import('mongodb').Db;                    // default get_database()
  secretsCollection?: string;                    // default 'secrets'
  auditCollection?: string;                      // default 'vault_audit'
  masterKeyHex?: string;                         // default process.env.KATRA_VAULT_MASTER_KEY
  defaultSharedId?: string;                      // default 'my-team'
}): VaultStore;

export interface VaultStore {
  putSecret(input: PutSecretInput): Promise<{ secret_id: string; created: boolean }>;
  listSecrets(caller: CallerIdentity): Promise<SecretMeta[]>;
  getSecretMeta(caller: CallerIdentity, secretId: string): Promise<SecretMeta | null>;
  deleteSecret(caller: CallerIdentity, secretId: string): Promise<{ deleted: boolean }>;
  rotateSecret(caller: CallerIdentity, secretId: string): Promise<{ rotated: boolean }>;
  openSecretValue(caller: CallerIdentity, secretId: string): Promise<string>; // F6 hook — RBAC-guarded
}
```

## RBAC semantics (must hold — spec §6, reuse Katra machinery)
- **Write** mirrors `resolveWriteScope` (services/memory/write-scope-policy.ts):
  - `scope: 'private'` → `owner.user_id = caller.user_id` (untrusted callers are
    ALWAYS pinned to their own identity; a requested user_id is honored only for
    `caller.trusted`).
  - `scope: 'team'` → `owner.shared_id = defaultSharedId` (default 'my-team'),
    user_id absent.
  - `secret_id` = `${owner.user_id}/${name}` (private) or `team:${shared_id}/${name}` (team).
  - Putting an existing `secret_id` returns `{ secret_id, created: false }` and
    **overwrites** the secret value (re-seal with fresh DEK), keeping meta.created_*.
  - `aclReaders` is honored only when `caller.trusted` (untrusted callers may
    only grant readers equal to their own identity — i.e., ignored).
- **Read** mirrors `buildScopeFilter` (memory-scope-service.ts): a caller sees
  1. own private secrets (`owner.user_id === caller.user_id`),
  2. team secrets (`owner.shared_id === defaultSharedId`),
  3. secrets where `caller.user_id ∈ acl.readers`.
  Trusted callers additionally see everything (operator view).
  Never another identity's private partition (untrusted).
- **Delete** — owner (`owner.user_id === caller.user_id`) or `caller.trusted` only.
- **Rotate** — owner or trusted; re-seals with a FRESH DEK (new envelope);
  bumps `meta.updated_at` and sets `meta.rotation_due_at = now + 30 days`
  (ISO string). Plaintext never leaves the function.
- **openSecretValue** — owner / trusted / acl.readers member only; sets
  `meta.last_used_at`; returns the decrypted string (for F6 capability layer).
- **Master key** — if `KATRA_VAULT_MASTER_KEY` is missing from env, `putSecret`
  and `openSecretValue` throw `Error('vault: master key not configured')`;
  list/get/delete work without it (no decryption needed).

## Success criteria (all must pass)
1. Private put → list shows meta for owner; a different untrusted caller sees `[]`.
2. Team put → owner and another user both see the meta; owner.user_id absent, shared_id present.
3. IDOR guard: untrusted caller passing a requested user_id gets pinned to own identity (assert owner.user_id === caller.user_id in DB).
4. `getSecretMeta` returns NO envelope and NO value fields (assert exact key set).
5. Stored envelope round-trips: decrypt via F1 `openSecret(env, scope, masterKey)` equals the original value (use test master key).
6. Duplicate put: same name → `created: false`, value replaced (old ciphertext differs, new decrypts to new value).
7. RBAC delete: non-owner untrusted delete returns `{ deleted: false }` and row still exists; owner delete removes it.
8. Rotate: envelope changes (ciphertext + dek_wrapped differ) but `openSecret` still yields the same plaintext; `rotation_due_at` set; non-owner untrusted rotate → `{ rotated: false }`.
9. Audit: put/delete/rotate (and openSecretValue) each produce exactly one `vault_audit` row; no audit row contains the value, plaintext, or envelope fields (assert keys ⊆ {at, actor, action, secret_id, service, outcome, error}).
10. acl.readers: trusted caller grants reader `other`; `other` sees it in list; reader may `openSecretValue`; reader may NOT delete.
11. Master key missing → put throws 'vault: master key not configured'; list still works.
12. Test collections are `test_`-prefixed and cleaned up in afterAll (see tests/helpers/db.ts conventions — real Mongo).

## Acceptance command
```
cd server && npx vitest run tests/unit/vault/store.test.ts && npm test
```
Full suite: **zero NEW failures**. The 5 known pre-existing failures
(ensure-client-keys, executive-allocation — `lilly` identity drift) are the
only allowed failures; everything else must pass identically to main.

## Implementation notes
- Follow existing service style (services/memory/*.ts): JSDoc headers, explicit
  return types, `.js` import suffixes.
- Use F1 exports only via their public names; never re-implement crypto.
- Never console.log value/envelope/plaintext.
- Dates as ISO strings via `new Date().toISOString()`.

## AMENDMENT (2026-09-04, discovered during live team testing)
`openSecretValue` additionally allows ANY identity in the default shared scope
to open TEAM secrets (`owner.shared_id === defaultSharedId`): team members can
already see the meta, and USE remains gated upstream by F7's per-service
approval. Before this amendment only private-owners / acl.readers / trusted
callers could open team secrets, which made team secrets unusable by agents.
Covered by `criterion 10b` in tests/unit/vault/store.test.ts.
