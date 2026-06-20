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
 */

import { randomBytes } from 'node:crypto';
import { get_database } from '../database/connection.js';

interface GeneratedKeys {
  mcp_api_key: string;
  katra_api_key: string;
  generated_at: string;
}

interface ApiKeyResult {
  mcpApiKey: string;
  katraApiKey: string;
  generated: boolean;
}

function generateKey(prefix: string): string {
  return `${prefix}-${randomBytes(32).toString('hex')}`;
}

/**
 * Resolve and optionally generate API keys.
 *
 * @returns The resolved MCP and Katra API keys, plus a flag indicating
 *          whether new keys were generated during this call.
 */
export async function ensureApiKeys(): Promise<ApiKeyResult> {
  // 1. Environment variables always win.
  let mcpApiKey = process.env.MCP_API_KEY || process.env.ADMIN_API_KEY || '';
  let katraApiKey = process.env.KATRA_API_KEY || '';

  if (mcpApiKey && katraApiKey) {
    return { mcpApiKey, katraApiKey, generated: false };
  }

  // 2. Try to load previously generated keys from MongoDB.
  try {
    const db = get_database();
    if (db) {
      const stored = await db.collection('system_settings').findOne<{ value: GeneratedKeys }>({
        key: 'generated_api_keys',
      });
      if (stored?.value) {
        if (!mcpApiKey) mcpApiKey = stored.value.mcp_api_key;
        if (!katraApiKey) katraApiKey = stored.value.katra_api_key;
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

  // 4. Persist newly generated keys so they survive restarts.
  if (generated) {
    try {
      const db = get_database();
      if (db) {
        await db.collection('system_settings').updateOne(
          { key: 'generated_api_keys' },
          {
            $set: {
              key: 'generated_api_keys',
              value: {
                mcp_api_key: mcpApiKey,
                katra_api_key: katraApiKey,
                generated_at: new Date().toISOString(),
              },
              updated_at: new Date(),
            },
          },
          { upsert: true },
        );
      }
    } catch {
      // If the DB is unavailable, we still start with ephemeral keys.
      // The keys are logged below so the user can capture them.
    }
  }

  return { mcpApiKey, katraApiKey, generated };
}

/**
 * Logs freshly generated keys to the console in a noticeable block.
 */
export function logGeneratedKeys(mcpApiKey: string, katraApiKey: string): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  🔐 Auto-generated API keys (persisted in MongoDB)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  MCP_API_KEY:   ${mcpApiKey}`);
  console.log(`  KATRA_API_KEY: ${katraApiKey}`);
  console.log('');
  console.log('  Add these to your agent MCP config and watcher config.');
  console.log('  They will be reused on restart unless you set new ones in .env.');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
}
