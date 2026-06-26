/**
 * Tenant Service — Multi-tenant management for SaaS deployments
 *
 * Stores tenant registry in a dedicated `katra_system` database.
 * Each tenant gets its own database (database-per-tenant pattern).
 * Provides GDPR compliance (easy data deletion), isolation, and
 * per-tenant API keys.
 */

import { MongoClient, Db } from 'mongodb';
import { createHash, randomBytes } from 'crypto';

export interface Tenant {
  tenant_id: string;
  name: string;
  email: string;
  api_key_hash: string;
  api_key_prefix: string;  // First 8 chars for identification
  database_name: string;
  plan: 'free' | 'pro' | 'enterprise';
  active: boolean;
  created_at: Date;
  updated_at: Date;
  settings: {
    max_collections: number;
    max_storage_mb: number;
    max_users: number;
  };
  usage: {
    storage_bytes: number;
    event_count: number;
    last_active: Date | null;
  };
}

export interface TenantCreationResult {
  tenant: Omit<Tenant, 'api_key_hash'>;
  api_key: string;  // Only returned on creation — never stored in plaintext
}

let systemClient: MongoClient | null = null;
let systemDb: Db | null = null;

function getSystemDb(): Db {
  if (!systemDb) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI required for tenant management');
    systemClient = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 5,
    });
    // Note: In production, the main MongoClient is reused.
    // This is a lightweight secondary connection for the system DB.
    systemDb = systemClient.db('katra_system');
  }
  return systemDb;
}

/**
 * Initialize the tenant system — create indexes, ensure system DB exists.
 */
export async function initTenantSystem(): Promise<void> {
  const db = getSystemDb();
  await db.collection('tenants').createIndex({ tenant_id: 1 }, { unique: true });
  await db.collection('tenants').createIndex({ api_key_hash: 1 }, { unique: true });
  await db.collection('tenants').createIndex({ email: 1 }, { unique: true });
  console.log('  ✅ Tenant system initialized (katra_system database)');
}

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function generateTenantId(): string {
  return `tnt_${randomBytes(8).toString('hex')}`;
}

function generateApiKey(): string {
  return `katra_${randomBytes(24).toString('hex')}`;
}

function databaseNameForTenant(tenantId: string): string {
  // Safe database name: katra_tnt_abc123...
  return `katra_${tenantId}`;
}

function defaultSettingsForPlan(plan: string): Tenant['settings'] {
  switch (plan) {
    case 'free': return { max_collections: 10, max_storage_mb: 100, max_users: 1 };
    case 'pro': return { max_collections: 50, max_storage_mb: 1024, max_users: 10 };
    case 'enterprise': return { max_collections: 500, max_storage_mb: 10240, max_users: 100 };
    default: return { max_collections: 10, max_storage_mb: 100, max_users: 1 };
  }
}

/**
 * Create a new tenant. Returns the tenant info + API key (only time the key is shown).
 */
export async function createTenant(params: {
  name: string;
  email: string;
  plan?: 'free' | 'pro' | 'enterprise';
}): Promise<TenantCreationResult> {
  const db = getSystemDb();
  const tenant_id = generateTenantId();
  const api_key = generateApiKey();
  const plan = params.plan || 'free';

  const tenant: Tenant = {
    tenant_id,
    name: params.name,
    email: params.email,
    api_key_hash: hashApiKey(api_key),
    api_key_prefix: api_key.slice(0, 12),
    database_name: databaseNameForTenant(tenant_id),
    plan,
    active: true,
    created_at: new Date(),
    updated_at: new Date(),
    settings: defaultSettingsForPlan(plan),
    usage: {
      storage_bytes: 0,
      event_count: 0,
      last_active: null,
    },
  };

  await db.collection('tenants').insertOne(tenant);

  // Return without the hash, but with the plaintext key
  const { api_key_hash, ...tenantWithoutHash } = tenant;
  return {
    tenant: tenantWithoutHash as Tenant,
    api_key,
  };
}

/**
 * Resolve an API key to a tenant. Returns null if not found or inactive.
 */
export async function resolveTenant(apiKey: string): Promise<Tenant | null> {
  const db = getSystemDb();
  const hash = hashApiKey(apiKey);
  const tenant = await db.collection('tenants').findOne({
    api_key_hash: hash,
    active: true,
  });
  return tenant as Tenant | null;
}

/**
 * Get a tenant by ID.
 */
export async function getTenant(tenantId: string): Promise<Tenant | null> {
  const db = getSystemDb();
  return await db.collection('tenants').findOne({ tenant_id: tenantId }) as Tenant | null;
}

/**
 * List all tenants (with pagination).
 */
export async function listTenants(opts: {
  limit?: number;
  offset?: number;
  active?: boolean;
  plan?: string;
} = {}): Promise<{ tenants: Tenant[]; total: number }> {
  const db = getSystemDb();
  const filter: Record<string, unknown> = {};
  if (opts.active !== undefined) filter.active = opts.active;
  if (opts.plan) filter.plan = opts.plan;

  const [tenants, total] = await Promise.all([
    db.collection('tenants')
      .find(filter)
      .sort({ created_at: -1 })
      .skip(opts.offset || 0)
      .limit(opts.limit || 50)
      .toArray(),
    db.collection('tenants').countDocuments(filter),
  ]);

  return { tenants: tenants as Tenant[], total };
}

/**
 * Update a tenant (name, plan, settings, active status).
 */
export async function updateTenant(tenantId: string, updates: Partial<Pick<Tenant, 'name' | 'plan' | 'active' | 'settings'>>): Promise<Tenant | null> {
  const db = getSystemDb();
  const setUpdates: Record<string, unknown> = { updated_at: new Date() };
  if (updates.name !== undefined) setUpdates.name = updates.name;
  if (updates.plan !== undefined) {
    setUpdates.plan = updates.plan;
    setUpdates.settings = defaultSettingsForPlan(updates.plan);
  }
  if (updates.active !== undefined) setUpdates.active = updates.active;
  if (updates.settings !== undefined) setUpdates.settings = { ...updates.settings };

  await db.collection('tenants').updateOne(
    { tenant_id: tenantId },
    { $set: setUpdates }
  );
  return getTenant(tenantId);
}

/**
 * Regenerate API key for a tenant.
 */
export async function regenerateApiKey(tenantId: string): Promise<{ api_key: string } | null> {
  const db = getSystemDb();
  const tenant = await getTenant(tenantId);
  if (!tenant) return null;

  const newKey = generateApiKey();
  await db.collection('tenants').updateOne(
    { tenant_id: tenantId },
    {
      $set: {
        api_key_hash: hashApiKey(newKey),
        api_key_prefix: newKey.slice(0, 12),
        updated_at: new Date(),
      },
    }
  );
  return { api_key: newKey };
}

/**
 * Delete a tenant and its database.
 * Uses the shared MongoClient to drop the tenant's database.
 */
export async function deleteTenant(tenantId: string, sharedClient?: MongoClient): Promise<boolean> {
  const db = getSystemDb();
  const tenant = await getTenant(tenantId);
  if (!tenant) return false;

  // Drop the tenant's database if we have a client
  if (sharedClient) {
    try {
      await sharedClient.db(tenant.database_name).dropDatabase();
      console.log(`  🗑️  Dropped database: ${tenant.database_name}`);
    } catch (e) {
      console.warn(`  ⚠️  Failed to drop database ${tenant.database_name}:`, (e as Error).message);
    }
  }

  await db.collection('tenants').deleteOne({ tenant_id: tenantId });
  return true;
}

/**
 * Update tenant usage stats (called periodically or on writes).
 */
export async function updateTenantUsage(tenantId: string, opts: {
  storageDelta?: number;
  eventDelta?: number;
}): Promise<void> {
  const db = getSystemDb();
  const inc: Record<string, number> = {};
  if (opts.storageDelta) inc['usage.storage_bytes'] = opts.storageDelta;
  if (opts.eventDelta) inc['usage.event_count'] = opts.eventDelta;

  await db.collection('tenants').updateOne(
    { tenant_id: tenantId },
    {
      $inc: Object.keys(inc).length > 0 ? inc : {},
      $set: { 'usage.last_active': new Date(), updated_at: new Date() },
    }
  );
}
