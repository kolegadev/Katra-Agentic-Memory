/**
 * Database Migration Runner
 *
 * Ensures indexes and schema constraints are applied consistently
 * after every successful connection.
 */

import { Db } from 'mongodb';
import { initializeMemorySystemIndexes } from './index-management.js';

export async function runDatabaseMigrations(db: Db): Promise<void> {
  console.log('🗄️ Running database migrations...');

  try {
    // ITER-4: beliefs are identity-scoped, so `agent_beliefs` carries the unique
    // key {user_id, entity_name, proposition}. A unique index cannot be built
    // over pre-existing duplicate keys, so the duplicate rows are collapsed —
    // deterministically, with the counts logged and returned — BEFORE index
    // initialisation, which drops and recreates every declared index and would
    // otherwise fail on that unique key. Running it again is a no-op.
    // Imported here (not at module load) to keep the connection→migrations
    // import graph acyclic, as the service imports the connection module.
    try {
      const { dedupeAgentBeliefs } = await import('../services/processing/self-model-service.js');
      await dedupeAgentBeliefs(db);
    } catch (error) {
      console.error('  ⚠️ agent_beliefs dedupe migration failed:', error);
    }

    await initializeMemorySystemIndexes(db);
    await migrateMemoryScopeDefaults(db);
    console.log('✅ Database migrations completed successfully');
  } catch (error) {
    console.error('❌ Database migration failed:', error);
    // Don't throw — allow the app to start even if index setup fails
  }
}

/**
 * Seed default memory_scope setting if it doesn't exist.
 * Default mode is "personal" (backward-compatible — no behaviour change).
 */
async function migrateMemoryScopeDefaults(db: Db): Promise<void> {
  try {
    const existing = await db.collection('system_settings').findOne({ key: 'memory_scope' });
    if (!existing) {
      await db.collection('system_settings').insertOne({
        key: 'memory_scope',
        mode: 'personal',
        shared_id: null,
        hybrid_visible_user_ids: [],
        updated_at: new Date(),
      });
      console.log('  ✅ Seeded default memory_scope setting (mode: personal)');
    }
  } catch (error) {
    console.error('  ⚠️ Failed to seed memory_scope default:', error);
  }
}
