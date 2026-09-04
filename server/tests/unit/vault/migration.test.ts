/**
 * Unit tests: Katra Vault F8 migration toolchain (contract success criteria
 * 1–7).
 *
 * Real MongoDB via `test_`-prefixed collections only
 * (test_semantic_facts_f8, test_embeddings_f8, test_secrets_f8,
 * test_vault_audit_f8), wiped per test and cleaned up after the suite — the
 * live `semantic_facts`/`embeddings`/`secrets` collections are NEVER touched.
 * Skipped when no MongoDB is reachable (same convention as the other vault
 * suites). The runner's exported helpers (buildReportFileName /
 * parseRunnerArgs) are tested directly; the full CLI is never spawned against
 * a live DB (contract criterion 7).
 *
 * Redaction proof: every test that seeds a known token asserts the token
 * never appears anywhere in the serialized report.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildReportFileName,
  parseRunnerArgs,
} from '../../../src/services/vault/migration-runner.js';
import {
  findLegacyAgentmailDocs,
  hardDeleteDocsWithEmbeddings,
  importAgentmailKey,
  scanPlaintextSecrets,
  runMigration,
} from '../../../src/services/vault/migration.js';
import type { LegacySecretDoc } from '../../../src/services/vault/migration.js';
import { createVaultStore } from '../../../src/services/vault/store.js';
import type { VaultStore } from '../../../src/services/vault/store.js';
import { generateMasterKey, openSecret } from '../../../src/services/vault/crypto.js';
import type { CallerIdentity } from '../../../src/utils/caller-identity.js';

const MONGO_URI =
  process.env.MONGODB_URI ||
  'mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin';

// Probe connectivity (incl. auth) up front; skip the suite when unavailable.
let mongoAvailable = false;
try {
  const probe = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 2000,
    connectTimeoutMS: 2000,
  });
  await probe.connect();
  await probe.close();
  mongoAvailable = true;
} catch {
  mongoAvailable = false;
}

describe.skipIf(!mongoAvailable)('Vault migration (F8) — contract criteria', () => {
  // ── test_-prefixed collections only (contract implementation note) ─────
  const tc = (name: string): string => `test_${name}`;
  const SEM = tc('semantic_facts_f8');
  const EMB = tc('embeddings_f8');
  const SEC = tc('secrets_f8');
  const AUD = tc('vault_audit_f8');

  const LEGACY_MATCHED = 'agentmail key (masked)';
  // Long hex token (40 chars) — used as "the seeded token that must never
  // appear in a report".
  const KEY_TOKEN = 'a9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6';
  const WIFI_TOKEN = 'WiFiTivat2026x9';
  const KEY_FILE_VALUE = 'sk-live-agentmail-9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b5a44';

  let db: Db;
  let client: MongoClient;
  let store: VaultStore;
  const MK = generateMasterKey();
  const TRUSTED: CallerIdentity = { user_id: 'satori', trusted: true };
  const LILLY: CallerIdentity = { user_id: 'lilly', trusted: false };
  const tmpFiles: string[] = [];

  const semCol = (): ReturnType<Db['collection']> => db.collection(SEM);
  const embCol = (): ReturnType<Db['collection']> => db.collection(EMB);
  const secCol = (): ReturnType<Db['collection']> => db.collection(SEC);
  const audCol = (): ReturnType<Db['collection']> => db.collection(AUD);

  /** Unique temp key file (os.tmpdir — never the repo tree). */
  function makeKeyFile(contents: string): string {
    const p = path.join(
      os.tmpdir(),
      `agentmail-lilly-f8-${process.pid}-${tmpFiles.length}.key`,
    );
    fs.writeFileSync(p, contents, 'utf8');
    tmpFiles.push(p);
    return p;
  }

  beforeAll(async () => {
    client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db = client.db('katra');
    store = createVaultStore({
      db,
      secretsCollection: SEC,
      auditCollection: AUD,
      masterKeyHex: MK,
    });
  });

  beforeEach(async () => {
    for (const name of [SEM, EMB, SEC, AUD]) {
      await db.collection(name).deleteMany({});
    }
  });

  afterAll(async () => {
    for (const name of [SEM, EMB, SEC, AUD]) {
      await db.collection(name).deleteMany({});
    }
    for (const p of tmpFiles) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
    if (client) await client.close();
  });

  // ── Criterion 1: findLegacyAgentmailDocs ────────────────────────────────
  describe('1. findLegacyAgentmailDocs', () => {
    it('scores key-token docs 1, term-only docs 0.5, ignores unrelated docs, and never leaks content', async () => {
      const keyTokenDoc = {
        content: `agentmail api_key = ${KEY_TOKEN} — sent by AgentMail support, keep private`,
        user_id: 'lilly',
      };
      const termOnlyDoc = {
        content: 'agentmail api_key: shared with the team in the notes for now',
        user_id: 'shoshin',
      };
      const unrelatedDoc = {
        content: 'the weather in Tivat today is warm and sunny',
        user_id: 'lilly',
      };
      const inserted = await semCol().insertMany([keyTokenDoc, termOnlyDoc, unrelatedDoc]);

      const found = await findLegacyAgentmailDocs(db, { collections: [SEM] });

      expect(found).toHaveLength(2);
      const byId = new Map(found.map((f) => [String(f._id), f]));
      const keyDoc = byId.get(String(inserted.insertedIds[0]));
      const termDoc = byId.get(String(inserted.insertedIds[1]));
      expect(keyDoc).toBeDefined();
      expect(termDoc).toBeDefined();
      expect(keyDoc!.score).toBe(1);
      expect(termDoc!.score).toBe(0.5);
      // unrelated doc absent
      expect(found.map((f) => String(f._id))).not.toContain(String(inserted.insertedIds[2]));

      for (const f of found) {
        // matched is ALWAYS the redacted constant — never content, never token.
        expect(f.matched).toBe(LEGACY_MATCHED);
        expect(f.collection).toBe(SEM);
        expect(typeof f._id).toBe('string'); // ObjectIds stringified
        expect(String(f._id)).toMatch(/^[0-9a-f]{24}$/);
        // redaction proof: seeded token + raw contents never leak
        expect(JSON.stringify(f)).not.toContain(KEY_TOKEN);
        expect(JSON.stringify(f)).not.toContain('agentmail api_key');
      }
    });
  });

  // ── Criterion 2: hardDeleteDocsWithEmbeddings ───────────────────────────
  describe('2. hardDeleteDocsWithEmbeddings', () => {
    it('deletes source docs + referencing embedding docs, leaves unrelated embeddings, and is idempotent', async () => {
      const inserted = await semCol().insertMany([
        { content: 'agentmail api_key = legacy-one', user_id: 'lilly' },
        { content: 'agentmail api_key = legacy-two', user_id: 'lilly' },
      ]);
      const oid1 = inserted.insertedIds[0] as unknown as ObjectId;
      const oid2 = inserted.insertedIds[1] as unknown as ObjectId;
      await embCol().insertMany([
        { doc_id: oid1, text: 'vec one', embedding: [0.1] },
        { doc_id: oid2, text: 'vec two', embedding: [0.2] },
        { doc_id: new ObjectId(), text: 'unrelated', embedding: [0.3] },
      ]);
      const legacyDocs: LegacySecretDoc[] = [oid1, oid2].map((oid) => ({
        collection: SEM,
        _id: String(oid),
        user_id: 'lilly',
        matched: LEGACY_MATCHED,
        score: 1,
      }));

      const first = await hardDeleteDocsWithEmbeddings(db, legacyDocs, {
        embeddingsCollection: EMB,
      });
      expect(first).toHaveLength(1);
      expect(first[0].collection).toBe(SEM);
      expect(first[0].ids.sort()).toEqual([String(oid1), String(oid2)].sort());
      expect(first[0].embeddings_removed).toBe(2);

      // source + referenced embeddings gone; unrelated embedding survives
      expect(await semCol().countDocuments({ _id: { $in: [oid1, oid2] } })).toBe(0);
      expect(await embCol().countDocuments({ doc_id: { $in: [oid1, oid2] } })).toBe(0);
      expect(await embCol().countDocuments({})).toBe(1);

      // idempotent: second run over the same docs deletes 0
      const second = await hardDeleteDocsWithEmbeddings(db, legacyDocs, {
        embeddingsCollection: EMB,
      });
      expect(second).toEqual([]);
      expect(await semCol().countDocuments({})).toBe(0);
    });
  });

  // ── Criterion 3: importAgentmailKey ─────────────────────────────────────
  describe('3. importAgentmailKey', () => {
    it('stores the key as lilly/agentmail-api-key (agentmail, api_key, private), audit row exists, envelope round-trips', async () => {
      const keyFile = makeKeyFile(`${KEY_FILE_VALUE}\n`);
      const result = await importAgentmailKey({
        store,
        caller: TRUSTED,
        ownerUserId: 'lilly',
        keyFilePath: keyFile,
      });

      expect(result).toEqual({
        file_exists: true,
        imported: true,
        secret_id: 'lilly/agentmail-api-key',
        reason: null,
      });

      const doc = await secCol().findOne({ secret_id: 'lilly/agentmail-api-key' });
      expect(doc).not.toBeNull();
      expect(doc!.name).toBe('agentmail-api-key');
      expect(doc!.owner.user_id).toBe('lilly'); // private scope → lilly partition
      expect(doc!.owner.shared_id).toBeUndefined();
      expect(doc!.service).toBe('agentmail');
      expect(doc!.kind).toBe('api_key');

      // F1 openSecret round-trip: envelope decrypts to the trimmed file contents
      const plaintext = openSecret(doc!.envelope, 'user:lilly', MK);
      expect(plaintext).toBe(KEY_FILE_VALUE);
      expect(plaintext).not.toContain('\n'); // trimmed

      // value-free audit row exists
      const auditRow = await audCol().findOne({ action: 'put', secret_id: 'lilly/agentmail-api-key' });
      expect(auditRow).not.toBeNull();
      expect(auditRow!.actor).toBe('satori');
      expect(JSON.stringify(auditRow)).not.toContain(KEY_FILE_VALUE);
    });

    it('returns reason "key file not found" for a missing file — no throw', async () => {
      const missing = path.join(os.tmpdir(), `no-such-agentmail-key-${process.pid}.key`);
      const result = await importAgentmailKey({
        store,
        caller: TRUSTED,
        ownerUserId: 'lilly',
        keyFilePath: missing,
      });
      expect(result).toEqual({
        file_exists: false,
        imported: false,
        secret_id: null,
        reason: 'key file not found',
      });
      expect(await secCol().countDocuments({})).toBe(0);
    });
  });

  // ── Criterion 4: scanPlaintextSecrets ───────────────────────────────────
  describe('4. scanPlaintextSecrets', () => {
    it('reports plaintext-secret rows with matched_pattern and a redacted <=80-char preview — token never leaks', async () => {
      await semCol().insertMany([
        { content: `wifi password = ${WIFI_TOKEN} for the Tivat home network`, user_id: 'lilly' },
        {
          content: `agentmail api_key = ${KEY_TOKEN} used by the mail sync script`,
          user_id: 'shoshin',
        },
        { content: 'remember to buy milk and bread', user_id: 'lilly' },
      ]);

      const rows = await scanPlaintextSecrets(db, { collections: [SEM], maxResults: 10 });

      expect(rows).toHaveLength(2);
      const wifiRow = rows.find((r) => r.matched_pattern === 'password=');
      expect(wifiRow).toBeDefined();
      expect(wifiRow!.user_id).toBe('lilly');
      expect(wifiRow!.redacted_preview).not.toContain(WIFI_TOKEN);
      expect(wifiRow!.redacted_preview).toContain('***');
      expect(wifiRow!.redacted_preview.length).toBeLessThanOrEqual(80);

      const apiRow = rows.find((r) => r.matched_pattern === 'api_key=');
      expect(apiRow).toBeDefined();
      expect(apiRow!.redacted_preview).not.toContain(KEY_TOKEN);
      expect(apiRow!.redacted_preview.length).toBeLessThanOrEqual(80);

      // THE report never contains raw secret values
      expect(JSON.stringify(rows)).not.toContain(WIFI_TOKEN);
      expect(JSON.stringify(rows)).not.toContain(KEY_TOKEN);
    });

    it('ignores redaction markers left by a previous migration run', async () => {
      await semCol().insertMany([
        { content: 'password: [REDACTED→team:my-team/migrated-password-team-abcd1234] for the router', user_id: 'lilly' },
        { content: 'api_key: [REDACTED→team:my-team/migrated-api_key-team-ef567890] for the script', user_id: 'lilly' },
        { content: `wifi password = ${WIFI_TOKEN} still present`, user_id: 'lilly' },
      ]);

      const rows = await scanPlaintextSecrets(db, { collections: [SEM], maxResults: 10 });

      // only the genuinely unredacted doc is a candidate
      expect(rows).toHaveLength(1);
      expect(rows[0].matched_pattern).toBe('password=');
      expect(JSON.stringify(rows)).not.toContain(WIFI_TOKEN);
    });

    it('ignores placeholder, masked, and too-short values after the labels', async () => {
      await semCol().insertMany([
        { content: 'api_key: str = DEFAULT_API_KEY  # must be configured via katra-hook.json', user_id: 'lilly' },
        { content: 'api_key = ""  # no key set yet', user_id: 'lilly' },
        { content: 'password: katr****2026 (already masked)', user_id: 'lilly' },
        { content: 'password: ab', user_id: 'lilly' }, // too short
      ]);

      const rows = await scanPlaintextSecrets(db, { collections: [SEM], maxResults: 10 });
      expect(rows).toHaveLength(0);
    });
  });

  // ── Criterion 5: runMigration dry-run ───────────────────────────────────
  describe('5. runMigration dry-run', () => {
    it('deletes NOTHING, imports NOTHING, reports mode dry-run', async () => {
      const agentmailDoc = {
        content: `agentmail api_key = ${KEY_TOKEN} — legacy plaintext doc`,
        user_id: 'lilly',
      };
      const wifiDoc = { content: `wifi password = ${WIFI_TOKEN} at home`, user_id: 'lilly' };
      const inserted = await semCol().insertMany([agentmailDoc, wifiDoc]);
      const agentmailOid = inserted.insertedIds[0] as unknown as ObjectId;
      await embCol().insertMany([
        { doc_id: agentmailOid, text: 'vec', embedding: [0.1] },
        { doc_id: agentmailOid, text: 'vec2', embedding: [0.2] },
      ]);
      const keyFile = makeKeyFile(`${KEY_FILE_VALUE}\n`);

      const report = await runMigration({
        db,
        store,
        caller: TRUSTED,
        ownerUserId: 'lilly',
        keyFilePath: keyFile,
        mode: 'dry-run',
        collections: [SEM],
        embeddingsCollection: EMB,
      });

      expect(report.mode).toBe('dry-run');
      // would-delete view: the legacy doc is reported (redacted)
      expect(report.legacy_agentmail_docs).toHaveLength(1);
      expect(report.legacy_agentmail_docs[0].matched).toBe(LEGACY_MATCHED);
      expect(String(report.legacy_agentmail_docs[0]._id)).toBe(String(agentmailOid));
      // nothing deleted / nothing imported
      expect(report.deleted).toEqual([]);
      expect(report.key_import).toEqual({
        file_exists: true,
        imported: false,
        secret_id: null,
        reason: 'dry-run (no import performed)',
      });
      // the full report never contains raw secret values
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain(KEY_TOKEN);
      expect(serialized).not.toContain(WIFI_TOKEN);
      expect(serialized).not.toContain(KEY_FILE_VALUE);

      // DB untouched
      expect(await semCol().countDocuments({})).toBe(2);
      expect(await embCol().countDocuments({})).toBe(2);
      expect(await secCol().countDocuments({})).toBe(0);
      expect(await audCol().countDocuments({})).toBe(0);
    });
  });

  // ── Criterion 6: runMigration apply ─────────────────────────────────────
  describe('6. runMigration apply', () => {
    it('deletes seeded legacy docs + embeddings, imports the key file, re-scan confirms gone; second apply is idempotent', async () => {
      const agentmailDoc = {
        content: `agentmail api_key = ${KEY_TOKEN} — legacy plaintext doc`,
        user_id: 'lilly',
      };
      const wifiDoc = { content: `wifi password = ${WIFI_TOKEN} at home`, user_id: 'lilly' };
      const inserted = await semCol().insertMany([agentmailDoc, wifiDoc]);
      const agentmailOid = inserted.insertedIds[0] as unknown as ObjectId;
      await embCol().insertMany([
        { doc_id: agentmailOid, text: 'vec', embedding: [0.1] },
        { doc_id: agentmailOid, text: 'vec2', embedding: [0.2] },
      ]);
      const keyFile = makeKeyFile(`${KEY_FILE_VALUE}\n`);
      const opts = {
        db,
        store,
        caller: TRUSTED,
        ownerUserId: 'lilly',
        keyFilePath: keyFile,
        collections: [SEM],
        embeddingsCollection: EMB,
      } as const;

      const report = await runMigration({ ...opts, mode: 'apply' as const });

      expect(report.mode).toBe('apply');
      // post-scan finds the legacy docs gone
      expect(report.legacy_agentmail_docs).toEqual([]);
      expect(report.deleted).toHaveLength(1);
      expect(report.deleted[0].collection).toBe(SEM);
      expect(report.deleted[0].ids).toEqual([String(agentmailOid)]);
      expect(report.deleted[0].embeddings_removed).toBe(2);
      // key imported
      expect(report.key_import.imported).toBe(true);
      expect(report.key_import.secret_id).toBe('lilly/agentmail-api-key');
      expect(report.key_import.reason).toBeNull();

      // the full report never contains raw secret values
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain(KEY_TOKEN);
      expect(serialized).not.toContain(WIFI_TOKEN);
      expect(serialized).not.toContain(KEY_FILE_VALUE);

      // DB state: legacy + embeddings gone; wifi note (audited, redacted) stays
      expect(await semCol().countDocuments({ _id: { $in: [agentmailOid] } })).toBe(0);
      expect(await semCol().countDocuments({})).toBe(1);
      expect(await embCol().countDocuments({})).toBe(0);
      const wifiRow = report.plaintext_audit.find((r) => r.matched_pattern === 'password=');
      expect(wifiRow).toBeDefined();
      expect(wifiRow!.redacted_preview).not.toContain(WIFI_TOKEN);

      // F1 openSecret round-trip on the imported secret
      const secretDoc = await secCol().findOne({ secret_id: 'lilly/agentmail-api-key' });
      expect(secretDoc).not.toBeNull();
      expect(openSecret(secretDoc!.envelope, 'user:lilly', MK)).toBe(KEY_FILE_VALUE);
      const auditRow = await audCol().findOne({ action: 'put', secret_id: 'lilly/agentmail-api-key' });
      expect(auditRow).not.toBeNull();
      expect(auditRow!.actor).toBe('satori');

      // idempotent second apply: nothing new to delete, no duplicate secret row
      const second = await runMigration({ ...opts, mode: 'apply' as const });
      expect(second.legacy_agentmail_docs).toEqual([]);
      expect(second.deleted).toEqual([]);
      expect(second.key_import.imported).toBe(true);
      expect(second.key_import.secret_id).toBe('lilly/agentmail-api-key');
      expect(JSON.stringify(second)).not.toContain(KEY_TOKEN);
      expect(await secCol().countDocuments({ secret_id: 'lilly/agentmail-api-key' })).toBe(1);
    });
  });

  // ── Criterion 7: runner helpers (never spawn the CLI against a live DB) ─
  describe('7. migration-runner helpers', () => {
    it('buildReportFileName emits vault-migration-report-<YYYY-MM-DD>-<mode>.json', () => {
      expect(buildReportFileName('dry-run')).toMatch(
        /^vault-migration-report-\d{4}-\d{2}-\d{2}-dry-run\.json$/,
      );
      expect(buildReportFileName('apply')).toMatch(
        /^vault-migration-report-\d{4}-\d{2}-\d{2}-apply\.json$/,
      );
      expect(buildReportFileName('apply', new Date(2026, 8, 3))).toBe(
        'vault-migration-report-2026-09-03-apply.json',
      );
    });

    it('parseRunnerArgs: --dry-run is the default; --apply, --key-file, --report-out parsed; bad flags error', () => {
      expect(parseRunnerArgs([]).mode).toBe('dry-run');
      expect(parseRunnerArgs(['--dry-run']).mode).toBe('dry-run');
      expect(parseRunnerArgs(['--apply']).mode).toBe('apply');
      expect(parseRunnerArgs(['--apply', '--dry-run']).mode).toBe('dry-run'); // last wins
      const keyFile = parseRunnerArgs(['--key-file', '/tmp/k.key']);
      expect(keyFile.keyFile).toBe('/tmp/k.key');
      expect(keyFile.error).toBeNull();
      const reportOut = parseRunnerArgs(['--report-out', '/tmp/r.json']);
      expect(reportOut.reportOut).toBe('/tmp/r.json');
      expect(parseRunnerArgs(['--bogus']).error).toContain('unknown option');
      expect(parseRunnerArgs(['--key-file']).error).toContain('requires a path');
      expect(parseRunnerArgs(['--help']).help).toBe(true);
    });
  });

  // ── Criterion 8 (repo-level): exercised by the full suite, tsc, and the
  //    runner bundle smoke check run out-of-band (see F8 verification notes).
  describe('redaction invariants', () => {
    it('findLegacyAgentmailDocs + scanPlaintextSecrets over the same seeded doc never surface the token together', async () => {
      // Combined view mirrors what runMigration reports: legacy list (matched
      // constant), audit previews (values redacted) — token in neither.
      await semCol().insertOne({
        content: `agentmail api_key = ${KEY_TOKEN} wifi password = ${WIFI_TOKEN}`,
        user_id: 'lilly',
      });
      const legacy = await findLegacyAgentmailDocs(db, { collections: [SEM] });
      const audit = await scanPlaintextSecrets(db, { collections: [SEM] });
      const combined = JSON.stringify({ legacy, audit });
      expect(combined).not.toContain(KEY_TOKEN);
      expect(combined).not.toContain(WIFI_TOKEN);
      expect(legacy[0].matched).toBe(LEGACY_MATCHED);
    });

    it('LILLY (untrusted, owner) can open the imported secret; the open never leaks into reports', async () => {
      // Guard: owner-scoped open works via the store RBAC for the real owner
      const keyFile = makeKeyFile(`${KEY_FILE_VALUE}\n`);
      await importAgentmailKey({ store, caller: TRUSTED, ownerUserId: 'lilly', keyFilePath: keyFile });
      await expect(
        store.openSecretValue(LILLY, 'lilly/agentmail-api-key'),
      ).resolves.toBe(KEY_FILE_VALUE);
      const auditRows = await store.listAudit(TRUSTED, { secretId: 'lilly/agentmail-api-key' });
      expect(JSON.stringify(auditRows)).not.toContain(KEY_FILE_VALUE);
    });
  });
});
