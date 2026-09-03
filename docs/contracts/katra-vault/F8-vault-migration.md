# CONTRACT — F8: Katra Vault migration (AgentMail import + legacy plaintext removal)

Source of truth: `docs/katra-vault-design.md` §10, §13 (open items).

## Goal
A tested, idempotent, DRY-RUN-FIRST migration toolchain that (a) imports the
AgentMail key from `~/.katra/keys/agentmail-lilly.key` into the vault as
`lilly/agentmail-api-key` (service `agentmail`, kind `api_key`, private scope),
(b) hard-deletes legacy plaintext secret docs + any referencing embedding docs,
(c) produces a REDACTED audit report of other plaintext secrets found in
shared memory (WiFi passwords etc.) for John to decide on. Nothing destructive
runs without an explicit `--apply` flag; the report never contains actual
secret values.

## Boundaries — MUST NOT touch
- `server/src/services/vault/{crypto,store,denylist,capability}.ts` + drivers (consume only)
- Routes, MCP, dashboard, processing pipeline, package.json, install.sh, .env.example
- No changes to the esbuild build config (runner uses `npx esbuild` ad-hoc)

## Files this feature may create/modify
- NEW `server/src/services/vault/migration.ts` — pure, testable logic
- NEW `server/src/services/vault/migration-runner.ts` — thin CLI entry
  (imports migration.ts; argv parsing: `--dry-run` (default) | `--apply`;
  `--key-file` optional path; `--report-out` optional path)
- NEW `scripts/vault-migrate.sh` — wrapper: `cd server && npx esbuild
  src/services/vault/migration-runner.ts --bundle --platform=node
  --format=esm --outfile="$TMP" && node "$TMP" "$@"` (esbuild is already a
  devDependency — no new deps)
- NEW `server/tests/unit/vault/migration.test.ts`

## Module interface (migration.ts)
```ts
import type { Db } from 'mongodb';
import type { VaultStore } from './store.js';
import type { CallerIdentity } from '../../../utils/caller-identity.js';

export interface LegacySecretDoc {
  collection: string;
  _id: unknown;                 // printed as String(_id)
  user_id: string | null;
  matched: string;              // the REDACTED matched term, e.g. 'agentmail key (masked)'
  score: number;                // 0..1 confidence it is a real secret doc
}
export interface MigrationReport {
  ran_at: string;
  mode: 'dry-run' | 'apply';
  legacy_agentmail_docs: LegacySecretDoc[];
  deleted: { collection: string; ids: string[]; embeddings_removed: number }[];
  key_import: { file_exists: boolean; imported: boolean; secret_id: string | null; reason: string | null };
  plaintext_audit: { collection: string; _id: string; user_id: string | null; matched_pattern: string; redacted_preview: string }[];
}

export function findLegacyAgentmailDocs(db: Db, opts?: { collections?: string[] }): Promise<LegacySecretDoc[]>;
export function hardDeleteDocsWithEmbeddings(db: Db, docs: LegacySecretDoc[]): Promise<{ collection: string; ids: string[]; embeddings_removed: number }[]>;
export function importAgentmailKey(opts: { store: VaultStore; caller: CallerIdentity; ownerUserId: string; keyFilePath: string }): Promise<{ file_exists: boolean; imported: boolean; secret_id: string | null; reason: string | null }>;
export function scanPlaintextSecrets(db: Db, opts?: { collections?: string[]; maxResults?: number }): Promise<MigrationReport['plaintext_audit']>;
export function runMigration(opts: { db: Db; store: VaultStore; caller: CallerIdentity; ownerUserId: string; keyFilePath: string; mode: 'dry-run' | 'apply' }): Promise<MigrationReport>;
```

## Semantics (hard rules)
1. **findLegacyAgentmailDocs**: searches `semantic_facts` (default; opt-in
   collections) for docs whose content matches agentmail API-key signals:
   case-insensitive `agentmail` AND (`api.key|api_key|apikey|bearer |key=` or a
   20+ char hex/base64-ish token near it). The returned `matched` field is
   ALWAYS the redacted form `'agentmail key (masked)'` — never the content,
   never the token. `score` = 1 when a key-like token is present, 0.5 when
   only the term matches.
2. **hardDeleteDocsWithEmbeddings**: `deleteMany({_id: {$in: ids}})` on the
   source collection(s); THEN if an `embeddings` collection exists and has a
   `doc_id` field, `deleteMany({doc_id: {$in: ids}})`. Idempotent (second run
   deletes 0). Returns counts.
3. **importAgentmailKey**: file missing → `{file_exists:false, imported:false,
   secret_id:null, reason:'key file not found'}` (NOT an error). File present →
   `store.putSecret({caller, name:'agentmail-api-key', value:<file contents
   trimmed>, scope:'private', ownerUserId, service:'agentmail',
   kind:'api_key'})` → `{imported:true, secret_id}`; on store error → imported
   false + reason (static text, never the key).
4. **scanPlaintextSecrets**: scans the same collections for plaintext-secret
   patterns (documented pattern list: `wpa_passphrase|wpa_key|psk=|password=
   |passwd=|api[_-]?key\s*[:=]\s*[A-Za-z0-9+/_-]{12,}` etc.). Report rows
   contain collection/_id/user_id/matched_pattern + a `redacted_preview` that
   is at most 80 chars of the content with every match replaced by `***`.
   THE REPORT MUST NOT CONTAIN RAW SECRET VALUES — the test proves it by
   seeding a doc with a known token and asserting the token never appears in
   the report.
5. **runMigration**: dry-run = finds + scans + builds the report, deletes
   NOTHING, imports NOTHING. apply = performs the deletes + the import, then
   re-scans to confirm the legacy docs are gone, and returns the full report.
   Report is JSON-serializable (ObjectIds stringified).
6. Runner: writes the report to
   `exports/vault-migration-report-<YYYY-MM-DD>-<mode>.json` (dir
   `~/Katra-Agentic-Memory/exports` — created if missing? NO — the repo has
   exports/ only in other projects; use
   `server/vault-migration-report-<date>-<mode>.json` in the repo root
   instead, .gitignore'd if needed — choose the repo root to avoid new dirs)
   and prints a 15-line summary to stdout. Exit 0 on success, 1 on failure,
   never prints secrets.
7. The runner reads `KATRA_VAULT_MASTER_KEY` and Mongo config from the server
   `.env` via the same mechanism the server uses (dotenv), and KATRA_HOME keys
   default path `~/.katra/keys/agentmail-lilly.key`.

## Success criteria (tests — all must pass)
1. findLegacyAgentmailDocs: seeded fake docs — key-token doc (score 1), term-only
   doc (score 0.5), unrelated doc (absent); `matched` output contains no
   content substring; ObjectIds stringified.
2. hardDeleteDocsWithEmbeddings: seeded source docs + seeded `embeddings`
   docs with doc_id refs → both deleted; second call deletes 0; returns counts.
3. importAgentmailKey: temp key file → putSecret called with service
   'agentmail', kind 'api_key', owner lilly, private scope; the stored
   envelope decrypts (F1 openSecret) to the file contents; audit row exists;
   missing file → reason 'key file not found', no throw.
4. scanPlaintextSecrets: seeded doc with `wifi password = MySecret12345` →
   report row has matched_pattern + redacted_preview WITHOUT 'MySecret12345'.
5. runMigration dry-run: nothing deleted (counts 0), no import performed,
   report mode 'dry-run'.
6. runMigration apply: deletes the seeded docs, imports the temp key file,
   post-scan finds the legacy docs gone; idempotent second apply finds
   nothing new to delete.
7. Runner bundle builds: `npx esbuild ... --bundle` exits 0 (test asserts the
   command exists/works via a fixture import — or the unit tests import
   migration-runner's exported `buildReportFileName`/arg-parsing helpers
   instead of spawning the full runner; the shell wrapper is smoke-checked by
   the Verifier).
8. Full suite zero NEW failures (known pre-existing set only); tsc clean; all
   prior vault tests green.

## Acceptance command
```
cd server && npx vitest run tests/unit/vault/migration.test.ts && npm test && npx tsc --noEmit
```

## Implementation notes
- Test against test_-prefixed collections (`test_semantic_facts_f8`,
  `test_embeddings_f8`, `test_secrets_f8`, `test_vault_audit_f8`) with cleanup.
- `import.meta.dirname`-style path handling is NOT needed — the runner takes
  explicit paths; defaults resolved from `os.homedir()`.
- The key file path default: `path.join(os.homedir(), '.katra', 'keys',
  'agentmail-lilly.key')`.
- No console.log of key material anywhere; redaction helpers centralized
  (`redactToken()` internal).
