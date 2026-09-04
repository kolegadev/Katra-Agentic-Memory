/**
 * Katra Vault — F8 legacy-secret migration (AgentMail import + plaintext
 * removal). See docs/contracts/katra-vault/F8-vault-migration.md.
 *
 * Pure, testable logic layered on the F2 `VaultStore` (consume-only — the
 * store/crypto/drivers are untouched):
 *
 * 1. `findLegacyAgentmailDocs`   — locate legacy plaintext AgentMail API-key
 *    docs in `semantic_facts` (opt-in collections) whose content mentions
 *    `agentmail` next to an API-key signal. The `matched` field is ALWAYS the
 *    static redacted term 'agentmail key (masked)'; `score` is 1 when a
 *    key-like token (20+ hex/base64-ish chars) sits near the mention, 0.5
 *    when only a keyword signal (api_key / bearer / key= …) matches.
 * 2. `hardDeleteDocsWithEmbeddings` — deleteMany on each source collection,
 *    then delete embedding docs referencing the ids via their `doc_id`
 *    field (only when that collection exists and carries `doc_id` rows).
 *    Idempotent: a second call over the same docs deletes 0 and reports it.
 * 3. `importAgentmailKey` — reads `~/.katra/keys/agentmail-lilly.key` (or an
 *    explicit path), trims it, and stores it via `store.putSecret` as
 *    `lilly/agentmail-api-key` (service agentmail, kind api_key, private).
 *    A missing file is a result, never a throw; reasons are static strings
 *    that can never contain key material.
 * 4. `scanPlaintextSecrets` — audit pass over the same collections for other
 *    plaintext secrets (wpa_passphrase, psk=, password=, api_key= …). Every
 *    row's `redacted_preview` is at most 80 chars of content with each
 *    matched value replaced by '***' — reports never carry raw values.
 * 5. `runMigration` — orchestrates the above: dry-run finds + scans but
 *    deletes/imports NOTHING; apply deletes + imports then re-scans to
 *    confirm the legacy docs are gone. The returned MigrationReport is
 *    JSON-serializable by construction (all ObjectIds stringified).
 *
 * No console output at all in this module, and no secret value ever appears
 * in a report field or an error/static reason.
 *
 * NOTE (superset of the contract signature): the three scanning/deleting
 * functions accept OPTIONAL collection overrides (`collections`,
 * `embeddingsCollection`) so tests exercise them against `test_`-prefixed
 * collections only; callers that omit them get the contract defaults
 * (`semantic_facts`, `embeddings`).
 */

import fs from 'node:fs';
import { ObjectId } from 'mongodb';
import type { Db, Document, Filter } from 'mongodb';
import type { VaultStore } from './store.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';

// ── Types (contract F8) ───────────────────────────────────────────────────

export interface LegacySecretDoc {
  collection: string;
  /** Printed as String(_id) — JSON-serializable by construction. */
  _id: unknown;
  user_id: string | null;
  /** ALWAYS the redacted form, never content, never a token. */
  matched: string;
  /** 0..1 confidence it is a real secret doc. */
  score: number;
}

export interface MigrationReport {
  ran_at: string;
  mode: 'dry-run' | 'apply';
  legacy_agentmail_docs: LegacySecretDoc[];
  deleted: { collection: string; ids: string[]; embeddings_removed: number }[];
  key_import: {
    file_exists: boolean;
    imported: boolean;
    secret_id: string | null;
    reason: string | null;
  };
  plaintext_audit: {
    collection: string;
    _id: string;
    user_id: string | null;
    matched_pattern: string;
    redacted_preview: string;
  }[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_SOURCE_COLLECTIONS = ['semantic_facts'];
const DEFAULT_EMBEDDINGS_COLLECTION = 'embeddings';
const MAX_SCAN_DOCS = 2000; // hard cap per collection for one-off migration scans
const MAX_AUDIT_ROWS = 50;

const LEGACY_MATCHED = 'agentmail key (masked)';
const KEY_IMPORT_NAME = 'agentmail-api-key';
const KEY_IMPORT_SERVICE = 'agentmail';
const KEY_IMPORT_KIND = 'api_key' as const;
const KEY_IMPORT_SCOPE = 'private' as const;

const REASON_FILE_NOT_FOUND = 'key file not found';
const REASON_EMPTY_FILE = 'key file is empty';
const REASON_READ_FAILED = 'key file could not be read';
const REASON_STORE_ERROR = 'vault store rejected the key';
const REASON_DRY_RUN = 'dry-run (no import performed)';

// AgentMail detection: `agentmail` (case-insensitive) plus an API-key signal.
const AGENTMAIL_TERM_RE = /agentmail/i;
/** api.key / api_key / apikey / api-key / 'bearer ' / 'key='-style signal. */
const KEYWORD_SIGNAL_RE = /api[._\-]?key|\bbearer\b|\bkey\s*[:=]/i;
/** 20+ char hex/base64-ish run (letters, digits, +, /, _, -, =). */
const TOKEN_RUN_SRC = '[A-Za-z0-9+/_=-]{20,}';
const TOKEN_NEAR_CHARS = 1500; // how close a token must be to the 'agentmail' mention

// Plaintext-secret audit patterns (contract-documented list). Each pattern
// both detects the trigger AND captures the value that follows it.
const PLAINTEXT_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'wpa_passphrase', re: /wpa_passphrase\s*[:=]\s*"?([^\s,;'")\]},]+)/i },
  { label: 'wpa_key', re: /wpa_key\s*[:=]\s*"?([^\s,;'")\]},]+)/i },
  { label: 'psk=', re: /(?:^|[^A-Za-z0-9])psk\s*[:=]\s*"?([^\s,;'")\]},]+)/i },
  { label: 'password=', re: /password\s*[:=]\s*"?([^\s,;'")\]},]+)/i },
  { label: 'passwd=', re: /passwd\s*[:=]\s*"?([^\s,;'")\]},]+)/i },
  { label: 'api_key=', re: /api[._\-]?key\s*[:=]\s*"?([^\s,;'")\]},]+)/i },
];
const PLAINTEXT_TRIGGER_SRC = 'wpa_passphrase|wpa_key|psk|password|passwd|api[._-]?key';

/** Known placeholder values that must never be reported as secrets. */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  'default_api_key', 'change-me', 'changeme', 'example', 'placeholder',
  'your-api-key', 'your_api_key', 'password', 'admin', 'admin123',
  '12345678', '123456789', '<password>',
]);

// ── Internal helpers ───────────────────────────────────────────────────────

function contentText(content: unknown): string {
  return typeof content === 'string' ? content : '';
}

function userIdOf(doc: Document): string | null {
  return typeof doc.user_id === 'string' && doc.user_id.length > 0 ? doc.user_id : null;
}

/** A 20+ char hex/base64-ish run is "plausible key material": pure hex, or
 *  mixed letters+digits (sk-…-style). Pure-word 20+ runs without digits do
 *  not qualify (avoids flagging prose/JSON field names). */
function plausibleToken(token: string): boolean {
  if (token.length < 20) return false;
  if (/^[0-9a-fA-F]{20,}$/.test(token)) return true;
  return /[0-9]/.test(token) && /[A-Za-z]/.test(token);
}

function tokenRuns(text: string): string[] {
  return [...text.matchAll(new RegExp(TOKEN_RUN_SRC, 'g'))]
    .map((m) => m[0])
    .filter(plausibleToken);
}

/** Any plausible token within ±TOKEN_NEAR_CHARS of the first `agentmail`
 *  mention counts as a key-like token "near it". */
function hasKeyLikeTokenNearAgentmail(text: string): boolean {
  const term = AGENTMAIL_TERM_RE.exec(text);
  if (term === null) return false;
  const start = Math.max(0, term.index - TOKEN_NEAR_CHARS);
  const end = Math.min(text.length, term.index + term[0].length + TOKEN_NEAR_CHARS);
  return tokenRuns(text.slice(start, end)).length > 0;
}

/** Classify one content string for the AgentMail legacy scan. Returns null
 *  when the doc is unrelated; score 1 when a key-like token is near the
 *  mention, 0.5 when only a keyword signal matches. */
function classifyAgentmailContent(text: string): { score: number } | null {
  if (!AGENTMAIL_TERM_RE.test(text)) return null;
  const keyLike = hasKeyLikeTokenNearAgentmail(text);
  const keywordOnly = KEYWORD_SIGNAL_RE.test(text);
  if (!keyLike && !keywordOnly) return null;
  return { score: keyLike ? 1 : 0.5 };
}

/** Values to redact in a preview: captured secret values (>= 3 chars so
 *  short prose words like "is" are never clobbered) plus every plausible
 *  20+ char token run. */
function redactionValues(text: string, captured: string[]): string[] {
  const values = new Set<string>();
  for (const v of captured) {
    if (typeof v === 'string' && v.trim().length >= 3) values.add(v.trim());
  }
  for (const t of tokenRuns(text)) values.add(t);
  return [...values].sort((a, b) => b.length - a.length);
}

function redactText(text: string, values: string[]): string {
  if (values.length === 0) return text;
  const pattern = new RegExp(
    values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g',
  );
  return text.replace(pattern, '***');
}

/** Raw `_id` values expanded to match BOTH string ids and ObjectId docs. */
function idMatchValues(ids: Iterable<unknown>): Array<string | ObjectId> {
  const out: Array<string | ObjectId> = [];
  for (const raw of ids) {
    const s = typeof raw === 'string' ? raw : String(raw);
    out.push(s);
    if (ObjectId.isValid(s)) out.push(new ObjectId(s));
  }
  return out;
}

function toFilter(query: Record<string, unknown>): Filter<Document> {
  return query as Filter<Document>;
}

// ── 1. findLegacyAgentmailDocs ─────────────────────────────────────────────

export async function findLegacyAgentmailDocs(
  db: Db,
  opts?: { collections?: string[] },
): Promise<LegacySecretDoc[]> {
  const collections =
    Array.isArray(opts?.collections) && opts!.collections!.length > 0
      ? opts!.collections!
      : DEFAULT_SOURCE_COLLECTIONS;

  const found: LegacySecretDoc[] = [];
  for (const collection of collections) {
    const col = db.collection(collection);
    const rows = await col
      .find(
        { content: { $regex: AGENTMAIL_TERM_RE.source, $options: 'i' } },
        { projection: { content: 1, user_id: 1 } },
      )
      .limit(MAX_SCAN_DOCS)
      .toArray();
    for (const row of rows) {
      const text = contentText(row.content);
      if (text.length === 0) continue;
      const cls = classifyAgentmailContent(text);
      if (cls === null) continue;
      found.push({
        collection,
        _id: String(row._id), // ObjectIds stringified — JSON-safe reports
        user_id: userIdOf(row),
        matched: LEGACY_MATCHED, // always redacted
        score: cls.score,
      });
    }
  }
  found.sort((a, b) => b.score - a.score || String(a._id).localeCompare(String(b._id)));
  return found;
}

// ── 2. hardDeleteDocsWithEmbeddings ────────────────────────────────────────

/** Delete embedding rows that reference `ids` via `doc_id` — only when the
 *  embeddings collection exists AND carries `doc_id` rows. Idempotent. */
async function deleteReferencedEmbeddings(
  db: Db,
  ids: unknown[],
  embeddingsCollection: string,
): Promise<number> {
  const exists = await db
    .listCollections({ name: embeddingsCollection }, { nameOnly: true })
    .hasNext();
  if (!exists) return 0;
  const col = db.collection(embeddingsCollection);
  const sample = await col.findOne(
    { doc_id: { $exists: true } },
    { projection: { doc_id: 1 } },
  );
  if (sample === null) return 0;
  const res = await col.deleteMany(toFilter({ doc_id: { $in: idMatchValues(ids) } }));
  return res.deletedCount;
}

export async function hardDeleteDocsWithEmbeddings(
  db: Db,
  docs: LegacySecretDoc[],
  opts?: { embeddingsCollection?: string },
): Promise<{ collection: string; ids: string[]; embeddings_removed: number }[]> {
  const embeddingsCollection =
    typeof opts?.embeddingsCollection === 'string' && opts.embeddingsCollection.length > 0
      ? opts.embeddingsCollection
      : DEFAULT_EMBEDDINGS_COLLECTION;

  // Group ids per source collection, preserving encounter order.
  const groups = new Map<string, string[]>();
  for (const doc of docs) {
    const id = String(doc._id);
    const list = groups.get(doc.collection) ?? [];
    list.push(id);
    groups.set(doc.collection, list);
  }

  const results: { collection: string; ids: string[]; embeddings_removed: number }[] = [];
  for (const [collection, ids] of groups) {
    const col = db.collection(collection);
    const res = await col.deleteMany(toFilter({ _id: { $in: idMatchValues(ids) } }));
    const embeddings_removed = await deleteReferencedEmbeddings(db, ids, embeddingsCollection);
    if (res.deletedCount === 0 && embeddings_removed === 0) continue; // idempotent second run
    results.push({ collection, ids, embeddings_removed });
  }
  return results;
}

// ── 3. importAgentmailKey ──────────────────────────────────────────────────

export async function importAgentmailKey(opts: {
  store: VaultStore;
  caller: CallerIdentity;
  ownerUserId: string;
  keyFilePath: string;
}): Promise<{
  file_exists: boolean;
  imported: boolean;
  secret_id: string | null;
  reason: string | null;
}> {
  if (!fs.existsSync(opts.keyFilePath)) {
    // Missing file is a RESULT, never an error (contract rule 3).
    return { file_exists: false, imported: false, secret_id: null, reason: REASON_FILE_NOT_FOUND };
  }
  let value: string;
  try {
    value = fs.readFileSync(opts.keyFilePath, 'utf8').trim();
  } catch {
    return { file_exists: true, imported: false, secret_id: null, reason: REASON_READ_FAILED };
  }
  if (value.length === 0) {
    return { file_exists: true, imported: false, secret_id: null, reason: REASON_EMPTY_FILE };
  }
  try {
    const { secret_id } = await opts.store.putSecret({
      caller: opts.caller,
      name: KEY_IMPORT_NAME,
      value,
      scope: KEY_IMPORT_SCOPE,
      service: KEY_IMPORT_SERVICE,
      kind: KEY_IMPORT_KIND,
      ownerUserId: opts.ownerUserId,
    });
    return { file_exists: true, imported: true, secret_id, reason: null };
  } catch {
    // Static reason — never the key, never the store error detail.
    return { file_exists: true, imported: false, secret_id: null, reason: REASON_STORE_ERROR };
  }
}

// ── 4. scanPlaintextSecrets ────────────────────────────────────────────────

export async function scanPlaintextSecrets(
  db: Db,
  opts?: { collections?: string[]; maxResults?: number },
): Promise<MigrationReport['plaintext_audit']> {
  const collections =
    Array.isArray(opts?.collections) && opts!.collections!.length > 0
      ? opts!.collections!
      : DEFAULT_SOURCE_COLLECTIONS;
  const maxResults =
    typeof opts?.maxResults === 'number' && Number.isFinite(opts.maxResults)
      ? Math.max(1, Math.floor(opts.maxResults))
      : MAX_AUDIT_ROWS;

  const rows: MigrationReport['plaintext_audit'] = [];
  for (const collection of collections) {
    if (rows.length >= maxResults) break;
    const col = db.collection(collection);
    const cursor = col
      .find(
        { content: { $regex: PLAINTEXT_TRIGGER_SRC, $options: 'i' } },
        { projection: { content: 1, user_id: 1 } },
      )
      .sort({ _id: 1 })
      .limit(MAX_SCAN_DOCS);
    for await (const row of cursor) {
      if (rows.length >= maxResults) break;
      const text = contentText(row.content);
      if (text.length === 0) continue;

      let matchedPattern: string | null = null;
      const captured: string[] = [];
      let realMatch = false;
      for (const { label, re } of PLAINTEXT_PATTERNS) {
        const m = re.exec(text);
        if (m === null) continue;
        if (m[1] === undefined) continue;
        const v = m[1];
        // Skip redaction markers: after a migration run, the doc may contain
        // '[REDACTED→<secret_id>]' right after a surviving 'password:' label —
        // the marker is not a secret and must not re-flag the doc.
        if (v.startsWith('[REDACTED')) continue;
        // Skip placeholders / masked / trivially-short values: config docs
        // containing 'api_key: str = DEFAULT_API_KEY' or already-masked
        // 'katr****2026' text are not plaintext secrets.
        if (v.length < 6) continue;
        if (v.includes('*')) continue;
        const low = v.toLowerCase();
        if (PLACEHOLDER_VALUES.has(low)) continue;
        if (matchedPattern === null) matchedPattern = label;
        realMatch = true;
        captured.push(v);
      }
      if (matchedPattern === null || !realMatch) continue; // trigger word without '='/':' etc.

      const redacted = redactText(text, redactionValues(text, captured));
      rows.push({
        collection,
        _id: String(row._id), // ObjectIds stringified
        user_id: userIdOf(row),
        matched_pattern: matchedPattern,
        redacted_preview: redacted.slice(0, 80), // at most 80 chars, values removed
      });
    }
  }
  return rows;
}

// ── 5. runMigration ────────────────────────────────────────────────────────

export async function runMigration(opts: {
  db: Db;
  store: VaultStore;
  caller: CallerIdentity;
  ownerUserId: string;
  keyFilePath: string;
  mode: 'dry-run' | 'apply';
  /** Optional test/operator override — defaults to ['semantic_facts']. */
  collections?: string[];
  /** Optional test/operator override — defaults to 'embeddings'. */
  embeddingsCollection?: string;
}): Promise<MigrationReport> {
  const mode: MigrationReport['mode'] = opts.mode === 'apply' ? 'apply' : 'dry-run';
  const collections = Array.isArray(opts.collections) && opts.collections.length > 0
    ? opts.collections
    : undefined;
  const embeddingsCollection =
    typeof opts.embeddingsCollection === 'string' && opts.embeddingsCollection.length > 0
      ? opts.embeddingsCollection
      : undefined;

  const found = await findLegacyAgentmailDocs(opts.db, collections ? { collections } : undefined);

  let deleted: MigrationReport['deleted'] = [];
  let key_import: MigrationReport['key_import'];
  if (mode === 'apply') {
    deleted = await hardDeleteDocsWithEmbeddings(
      opts.db,
      found,
      embeddingsCollection ? { embeddingsCollection } : undefined,
    );
    key_import = await importAgentmailKey({
      store: opts.store,
      caller: opts.caller,
      ownerUserId: opts.ownerUserId,
      keyFilePath: opts.keyFilePath,
    });
  } else {
    // dry-run: deletes NOTHING, imports NOTHING — only report what WOULD happen.
    const file_exists = fs.existsSync(opts.keyFilePath);
    key_import = {
      file_exists,
      imported: false,
      secret_id: null,
      reason: file_exists ? REASON_DRY_RUN : REASON_FILE_NOT_FOUND,
    };
  }

  // Apply re-scans to CONFIRM the legacy docs are gone; the report's
  // legacy_agentmail_docs then proves it. dry-run keeps the "would delete" view.
  const legacy_agentmail_docs =
    mode === 'apply'
      ? await findLegacyAgentmailDocs(opts.db, collections ? { collections } : undefined)
      : found;
  const plaintext_audit = await scanPlaintextSecrets(
    opts.db,
    collections ? { collections } : undefined,
  );

  return {
    ran_at: new Date().toISOString(),
    mode,
    legacy_agentmail_docs,
    deleted,
    key_import,
    plaintext_audit,
  };
}
