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
    await initializeMemorySystemIndexes(db);
    console.log('✅ Database migrations completed successfully');
  } catch (error) {
    console.error('❌ Database migration failed:', error);
    // Don't throw — allow the app to start even if index setup fails
  }
}
