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

let _client: MongoClient | null = null;
let _db: Db | null = null;

export async function getTestDB(): Promise<Db> {
  if (_db) return _db;
  _client = new MongoClient(MONGO_URI);
  await _client.connect();
  _db = _client.db(DB_NAME);
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
