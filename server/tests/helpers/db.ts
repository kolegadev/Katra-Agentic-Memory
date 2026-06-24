/**
 * Test database helpers.
 * 
 * Connects to the real MongoDB but uses a `test_` prefix on collection names
 * to avoid polluting production data. Each test file should use unique collection
 * names and clean up in afterAll().
 */
import { MongoClient, Db, Collection } from 'mongodb';

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin';
const DB_NAME = 'katra_test';

// Use the production DB for integration tests since we don't have a separate test DB
const USE_PROD_DB = process.env.KATRA_TEST_USE_PROD_DB === 'true' || true;
const PROD_URI = process.env.MONGODB_URI || 'mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin';

let _client: MongoClient | null = null;
let _db: Db | null = null;

export async function getTestDB(): Promise<Db> {
  if (_db) return _db;
  const uri = USE_PROD_DB ? PROD_URI : MONGO_URI;
  _client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
  await _client.connect();
  _db = _client.db(USE_PROD_DB ? 'katra' : 'katra_test');
  return _db;
}

export function testCollection(name: string): string {
  return `test_${name}`;
}

export async function getTestCollection(name: string): Promise<Collection> {
  const db = await getTestDB();
  return db.collection(testCollection(name));
}

export async function cleanupTestData(collection?: string): Promise<void> {
  if (!_db) return;
  if (collection) {
    await _db.collection(testCollection(collection)).deleteMany({});
  }
}

export async function closeTestDB(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
  }
}
