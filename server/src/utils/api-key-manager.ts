/**
 * Katra API Key Manager
 *
 * Ensures MCP_API_KEY and KATRA_API_KEY are available on startup.
 *
 * Priority:
 *   1. Environment variables (MCP_API_KEY, KATRA_API_KEY, ADMIN_API_KEY)
 *   2. Previously generated keys persisted in MongoDB system_settings
 *   3. Freshly generated cryptographically random keys (persisted to MongoDB)
 *
 * When keys are auto-generated, they are printed to the console so the user
 * can copy them into agent configs. In multi-tenant mode only KATRA_API_KEY
 * (the admin key) is auto-generated; tenant keys are created via the tenant
 * API and should not be generated here.
 *
 * Security: only SHA-256 hashes of API keys are persisted to MongoDB.
 * Plaintext keys exist only in process.env (from .env or the one-time log
 * output at generation time). Validation hashes the incoming token and
 * compares against the stored digest — the database never holds a value that
 * grants API access directly.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { get_database } from '../database/connection.js';
import type { CallerIdentity } from './caller-identity.js';

interface ApiKeyResult {
  mcpApiKey: string;
  katraApiKey: string;
  generated: boolean;
}

/** In-memory validators populated by ensureApiKeys(). */
interface ApiKeyValidators {
  mcpHash: string;
  katraHash: string;
}

let validators: ApiKeyValidators | null = null;
/** Accumulated list of all valid MCP key hashes (env + DB stored). */
let allMcpHashes: string[] = [];
/** Accumulated list of all valid Katra key hashes (env + DB stored). */
let allKatraHashes: string[] = [];

/** In-memory client-key hash → caller identity map, loaded by ensureClientKeys(). */
const clientKeyIdentities = new Map<string, { user_id: string; trusted: false }>();

function generateKey(prefix: string): string {
  return `${prefix}-${randomBytes(32).toString('hex')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

async function loadStoredHashes(): Promise<void> {
  // Load backup keys from env var (comma-separated, for migration compatibility)
  const backupMcpKeys = process.env.BACKUP_MCP_KEYS || '';
  if (backupMcpKeys) {
    for (const key of backupMcpKeys.split(',').map(k => k.trim()).filter(Boolean)) {
      const h = hashApiKey(key);
      if (!allMcpHashes.includes(h)) allMcpHashes.push(h);
    }
  }
  const backupKatraKeys = process.env.BACKUP_KATRA_KEYS || '';
  if (backupKatraKeys) {
    for (const key of backupKatraKeys.split(',').map(k => k.trim()).filter(Boolean)) {
      const h = hashApiKey(key);
      if (!allKatraHashes.includes(h)) allKatraHashes.push(h);
    }
  }
  try {
    const db = get_database();
    if (!db) return;
    const stored = await db
      .collection('system_settings')
      .findOne<{ value: Record<string, string> }>({ key: 'generated_api_keys' });
    if (stored?.value) {
      const v = stored.value;
      if (v.mcp_api_key_hash && !allMcpHashes.includes(v.mcp_api_key_hash)) {
        allMcpHashes.push(v.mcp_api_key_hash);
      }
      if (v.katra_api_key_hash && !allKatraHashes.includes(v.katra_api_key_hash)) {
        allKatraHashes.push(v.katra_api_key_hash);
      }
      // Also check legacy plaintext keys that were migrated
      if (v.mcp_api_key) {
        const h = hashApiKey(v.mcp_api_key);
        if (!allMcpHashes.includes(h)) allMcpHashes.push(h);
      }
      if (v.katra_api_key) {
        const h = hashApiKey(v.katra_api_key);
        if (!allKatraHashes.includes(h)) allKatraHashes.push(h);
      }
    }
  } catch { /* DB may not be ready yet */ }
}

async function persistHashes(mcpHash: string, katraHash: string): Promise<void> {
  try {
    const db = get_database();
    if (!db) return;

    const setDoc: Record<string, unknown> = {
      key: 'generated_api_keys',
      'value.mcp_api_key_hash': mcpHash,
      'value.katra_api_key_hash': katraHash,
      'value.generated_at': new Date().toISOString(),
      updated_at: new Date(),
    };

    const unsetDoc: Record<string, unknown> = {
      'value.mcp_api_key': '',
      'value.katra_api_key': '',
    };

    await db.collection('system_settings').updateOne(
      { key: 'generated_api_keys' },
      { $set: setDoc, $unset: unsetDoc },
      { upsert: true },
    );
  } catch {
    // DB unavailable — keys are still usable from in-memory validators.
  }
}

/**
 * Resolve and optionally generate API keys.
 *
 * After this call, incoming tokens should be validated via validateMcpKey()
 * and validateKatraKey() rather than direct process.env comparison.
 *
 * @returns The resolved MCP and Katra API keys (plaintext), plus a flag
 *          indicating whether new keys were generated during this call.
 */
export async function ensureApiKeys(): Promise<ApiKeyResult> {
  // 1. Environment variables always win.
  let mcpApiKey = process.env.MCP_API_KEY || process.env.ADMIN_API_KEY || '';
  let katraApiKey = process.env.KATRA_API_KEY || '';

  if (mcpApiKey && katraApiKey) {
    const mcpHash = hashApiKey(mcpApiKey);
    const katraHash = hashApiKey(katraApiKey);
    validators = { mcpHash, katraHash };
    allMcpHashes = [mcpHash];
    allKatraHashes = [katraHash];
await persistHashes(mcpHash, katraHash);
    // Also load any previously stored hashes so old keys still work
    await loadStoredHashes();
    return { mcpApiKey, katraApiKey, generated: false };
  }

  // 2. Try to load previously generated key hashes from MongoDB.
  //    We store only hashes — plaintext is never written to the database.
  //    On restart without env vars we validate via the stored hashes; the
  //    plaintext is not needed because callers present tokens that we hash
  //    and compare against these stored digests.
  try {
    const db = get_database();
    if (db) {
      const stored = await db
        .collection('system_settings')
        .findOne<{ value: Record<string, string> }>({ key: 'generated_api_keys' });

      if (stored?.value) {
        const v = stored.value;

        // One-shot migration: if legacy plaintext is present, hash it now and
        // remove the plaintext from the database. This upgrades existing installs
        // without rotating keys.
        if ((v.mcp_api_key || v.katra_api_key) && !v.mcp_api_key_hash) {
          const legacyMcp = v.mcp_api_key || '';
          const legacyKatra = v.katra_api_key || '';
          if (legacyMcp && legacyKatra) {
            const mcpHash = hashApiKey(legacyMcp);
            const katraHash = hashApiKey(legacyKatra);
            await persistHashes(mcpHash, katraHash);
            validators = { mcpHash, katraHash };
            // Populate env vars for backward compatibility with any code that
            // still reads process.env directly during this boot cycle.
            if (!mcpApiKey) mcpApiKey = legacyMcp;
            if (!katraApiKey) katraApiKey = legacyKatra;
            return { mcpApiKey, katraApiKey, generated: false };
          }
        }

        // Normal restart path: load stored hashes into the in-memory validator.
        // No plaintext is available or needed — validation uses validateMcpKey()
        // and validateKatraKey() which hash the incoming token before comparing.
        if (v.mcp_api_key_hash && v.katra_api_key_hash) {
          validators = {
            mcpHash: v.mcp_api_key_hash,
            katraHash: v.katra_api_key_hash,
          };
          allMcpHashes = [v.mcp_api_key_hash];
          allKatraHashes = [v.katra_api_key_hash];
          // Return empty strings for the plaintext values to signal that env
          // vars should NOT be set from DB — callers must use the validate*()
          // helpers for auth decisions.
          return { mcpApiKey: '', katraApiKey: '', generated: false };
        }
      }
    }
  } catch {
    // DB may not be connected yet — fall through to generation.
  }

  // 3. Generate any keys that are still missing.
  let generated = false;
  if (!mcpApiKey) {
    mcpApiKey = generateKey('katra-mcp');
    generated = true;
  }
  if (!katraApiKey) {
    katraApiKey = generateKey('katra-admin');
    generated = true;
  }

  // 4. Persist only the hashes of newly generated keys.
  if (generated) {
    const mcpHash = hashApiKey(mcpApiKey);
    const katraHash = hashApiKey(katraApiKey);
    validators = { mcpHash, katraHash };
    allMcpHashes = [mcpHash];
    allKatraHashes = [katraHash];
    await persistHashes(mcpHash, katraHash);
    await loadStoredHashes();
  }

  return { mcpApiKey, katraApiKey, generated };
}

/**
 * Validate an MCP API key token using constant-time hash comparison.
 * Returns false if ensureApiKeys() has not been called or if validators
 * are unavailable — always fails closed.
 */
export function validateMcpKey(token: string): boolean {
  if (!token) return false;
  const tokenHash = hashApiKey(token);
  // Check against all known valid hashes (env + DB stored)
  if (validators && safeEqualHex(tokenHash, validators.mcpHash)) return true;
  for (const h of allMcpHashes) {
    if (safeEqualHex(tokenHash, h)) return true;
  }
  return false;
}

/**
 * Validate a Katra (admin/REST) API key token using constant-time hash comparison.
 * Returns false if ensureApiKeys() has not been called or if validators
 * are unavailable — always fails closed.
 */
export function validateKatraKey(token: string): boolean {
  if (!token) return false;
  const tokenHash = hashApiKey(token);
  if (validators && safeEqualHex(tokenHash, validators.katraHash)) return true;
  for (const h of allKatraHashes) {
    if (safeEqualHex(tokenHash, h)) return true;
  }
  return false;
}

/**
 * Returns true if a Katra API key has been configured (env var or generated).
 * When false, the REST API operates in open-access mode (local dev).
 */
export function isKatraAuthConfigured(): boolean {
  return validators !== null || !!process.env.KATRA_API_KEY;
}

/**
 * Returns true if an MCP API key has been configured (env var or generated).
 */
export function isMcpAuthConfigured(): boolean {
  return validators !== null || !!(process.env.MCP_API_KEY || process.env.ADMIN_API_KEY);
}

/**
 * Logs freshly generated keys to the console in a noticeable block.
 */
export function logGeneratedKeys(mcpApiKey: string, katraApiKey: string): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  🔐 Auto-generated API keys (hashes persisted in MongoDB)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  MCP_API_KEY:   ${mcpApiKey}`);
  console.log(`  KATRA_API_KEY: ${katraApiKey}`);
  console.log('');
  console.log('  Add these to your agent MCP config and watcher config.');
  console.log('  Plaintext keys are NOT stored in the database — save them now.');
  console.log('  They will be reused on restart (via stored hash) as long as');
  console.log('  clients present the same tokens.');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
}

// ── F1: Caller-bound identities ───────────────────────────────────

/**
 * Minimal request shape needed to resolve a caller identity. Accepts a Node
 * IncomingMessage (or a subset of it) as well as Hono-style normalized parts.
 */
export interface CallerRequestParts {
  socket?: { remoteAddress?: string } | null;
  remoteAddress?: string | null;
  headers?: Record<string, string | string[] | undefined> | null;
  url?: string | null;
}

/** Loopback check — loopback callers are the local machine (trusted satori). */
export function isLoopbackAddress(remoteAddress?: string | null): boolean {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

/**
 * Extract the presented API key from request headers / query string:
 * `x-mcp-auth` header, `Authorization: Bearer ...`, or `?token=...`.
 */
export function extractPresentedKey(
  headers: Record<string, string | string[] | undefined>,
  url?: string,
): string | undefined {
  const xMcpAuth = headers['x-mcp-auth'];
  const x = Array.isArray(xMcpAuth) ? xMcpAuth[0] : xMcpAuth;
  if (typeof x === 'string' && x.trim()) return x.trim();

  const authorization = headers['authorization'];
  const auth = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }

  if (url) {
    try {
      const token = new URL(url, 'http://localhost').searchParams.get('token');
      if (token && token.trim()) return token.trim();
    } catch {
      /* malformed URL — no token */
    }
  }
  return undefined;
}

/** Register a client-key hash → identity mapping in the in-memory map. */
export function registerClientKeyIdentity(hash: string, user_id: string): void {
  clientKeyIdentities.set(hash, { user_id, trusted: false });
}

/** Clear the in-memory client-key identity map (reload + tests). */
export function clearClientKeyIdentities(): void {
  clientKeyIdentities.clear();
}

/** Number of in-memory client-key identity mappings (tests/diagnostics). */
export function getClientKeyIdentityCount(): number {
  return clientKeyIdentities.size;
}

/** system_settings.client_keys record shape. */
export interface ClientKeyRecord {
  key_hash: string;
  user_id: string;
  display_name: string;
  created_at: string;
}

/**
 * The legacy key hash that maps to satori: the current MCP env key hash when
 * plaintext is available, otherwise the persisted validator hash from
 * ensureApiKeys() (both describe the same legacy key).
 */
function resolveLegacyKeyHash(): string | null {
  const legacyPlaintext = process.env.MCP_API_KEY || process.env.ADMIN_API_KEY || '';
  if (legacyPlaintext) return hashApiKey(legacyPlaintext);
  if (validators?.mcpHash) return validators.mcpHash;
  return null;
}

/** Legacy env key hashes (MCP_API_KEY / ADMIN_API_KEY / BACKUP_MCP_KEYS). */
function getLegacyEnvKeyHashes(): Set<string> {
  const hashes = new Set<string>();
  for (const envName of ['MCP_API_KEY', 'ADMIN_API_KEY', 'BACKUP_MCP_KEYS']) {
    const raw = process.env[envName] || '';
    for (const key of raw.split(',').map(k => k.trim()).filter(Boolean)) {
      hashes.add(hashApiKey(key));
    }
  }
  return hashes;
}

/**
 * Provision the system_settings.client_keys entries at boot.
 *
 * - satori: mapped to the legacy env key hash (no new key).
 * - shoshin / zanshin: freshly generated once, plaintext printed once to the
 *   console, sha256 hash only in the database.
 *
 * Idempotent: existing entries are kept untouched; the in-memory identity
 * map is refreshed from the stored records on every call.
 *
 * `options.collection` / `options.settingsKey` exist for tests so unit tests
 * never write into the production system_settings document.
 */
export async function ensureClientKeys(options: {
  collection?: string;
  settingsKey?: string;
} = {}): Promise<void> {
  const collection = options.collection ?? 'system_settings';
  const settingsKey = options.settingsKey ?? 'client_keys';
  try {
    // Throws when the database is not connected — caught below.
    const db = get_database();

    const coll = db.collection(collection);
    const stored = await coll.findOne<{ value?: ClientKeyRecord[] }>({ key: settingsKey });
    const records: ClientKeyRecord[] = Array.isArray(stored?.value)
      ? stored.value.filter(r => r && typeof r.key_hash === 'string' && typeof r.user_id === 'string')
      : [];
    const byUser = new Map<string, ClientKeyRecord>(records.map(r => [r.user_id, r]));

    let changed = false;
    const now = new Date().toISOString();

    // satori → legacy env key hash (no plaintext key generated).
    const legacyHash = resolveLegacyKeyHash();
    if (legacyHash && !byUser.has('satori')) {
      records.push({ key_hash: legacyHash, user_id: 'satori', display_name: 'Satori', created_at: now });
      changed = true;
    }

    // shoshin / zanshin → freshly generated keys (printed once below).
    const freshPlaintext: Array<{ user_id: string; key: string }> = [];
    const agents: Array<{ user_id: string; display_name: string }> = [
      { user_id: 'shoshin', display_name: 'Shoshin' },
      { user_id: 'zanshin', display_name: 'Zanshin' },
    ];
    for (const agent of agents) {
      if (byUser.has(agent.user_id)) continue;
      const key = generateKey(`katra-${agent.user_id}`);
      records.push({
        key_hash: hashApiKey(key),
        user_id: agent.user_id,
        display_name: agent.display_name,
        created_at: now,
      });
      freshPlaintext.push({ user_id: agent.user_id, key });
      changed = true;
    }

    if (changed) {
      await coll.updateOne(
        { key: settingsKey },
        { $set: { key: settingsKey, value: records, updated_at: new Date() } },
        { upsert: true },
      );
    }

    // Plaintext is printed exactly once — when the keys were generated.
    if (freshPlaintext.length > 0) {
      console.log('');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('  🗝️  Client keys (identity separation) — generated once, save now');
      console.log('═══════════════════════════════════════════════════════════');
      for (const entry of freshPlaintext) {
        console.log(`  ${entry.user_id.padEnd(9)} ${entry.key}`);
      }
      console.log('');
      console.log('  Hand these keys to the named machines (iMac trading → shoshin,');
      console.log('  iMac OpenCode → zanshin). Only sha256 hashes are stored in the');
      console.log('  database (system_settings.client_keys) — plaintext is not.');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('');
    }

    // Refresh the in-memory identity map from the stored records.
    clientKeyIdentities.clear();
    for (const r of records) {
      clientKeyIdentities.set(r.key_hash, { user_id: r.user_id, trusted: false });
    }
  } catch (error) {
    console.warn('⚠️ ensureClientKeys failed:', (error as Error)?.message);
  }
}

/**
 * Resolve WHO is calling from the request's source address and presented key.
 *
 * - loopback IP → { user_id: 'satori', trusted: true }
 * - admin key (KATRA_API_KEY / stored admin hashes) → { user_id: 'satori', trusted: true }
 * - key mapped in system_settings.client_keys → { user_id, trusted: false }
 * - NO legacy env-key fallback: the pre-cutover shared keys (MCP_API_KEY /
 *   BACKUP_MCP_KEYS) are deliberately unmapped so machines that still hold
 *   them are rejected loudly instead of writing memories under Satori's
 *   identity (Shoshin cutover report 2026-08-21). Non-loopback consumers get
 *   their own mapped client key.
 * - valid but unmapped → null (the caller must be rejected with 401 + reason)
 * - no key, non-loopback → null
 */
export async function resolveCallerIdentity(
  req: CallerRequestParts,
): Promise<CallerIdentity | null> {
  const remoteAddress = req.remoteAddress || req.socket?.remoteAddress;
  if (isLoopbackAddress(remoteAddress)) {
    return { user_id: 'satori', trusted: true };
  }

  const token = extractPresentedKey(req.headers ?? {}, req.url ?? undefined);
  if (!token) return null;

  const tokenHash = hashApiKey(token);

  // Admin key = trusted satori.
  if (validateKatraKey(token)) {
    return { user_id: 'satori', trusted: true };
  }

  // Key mapped in client_keys (satori / shoshin / zanshin / tool actors).
  const mapped = clientKeyIdentities.get(tokenHash);
  if (mapped) {
    return { ...mapped };
  }

  // Valid but unmapped (or invalid) → null: reject with 401 + reason.
  return null;
}
