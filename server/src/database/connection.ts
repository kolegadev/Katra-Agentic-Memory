import { MongoClient, Db } from 'mongodb';
import { createHash } from 'crypto';
import { runDatabaseMigrations } from './migrations.js';

/**
 * MongoDB Atlas enforces a max database name length of 38 bytes on some tiers.
 * If the provided DATABASE_NAME exceeds this, hash it to a deterministic short name.
 */
const normalize_database_name = (name: string): string => {
  const MAX_DB_NAME_LENGTH = 38;
  if (name.length <= MAX_DB_NAME_LENGTH) {
    return name;
  }
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 30);
  return `db_${hash}`; // 33 characters total — safely under the limit
};

let client: MongoClient | null = null;
let database: Db | null = null;
let isConnected: boolean = false;
let connectionError: string | null = null;

const poolMetrics = {
  totalConnectionsCreated: 0,
  totalConnectionsClosed: 0,
  currentActiveConnections: 0,
  maxConnectionsObserved: 0,
};

export const connect_to_mongodb = async (): Promise<Db | null> => {
  if (database) {
    return database;
  }

  // Use environment variable for MongoDB connection (never hardcode credentials)
  let mongodb_uri = process.env.MONGODB_URI;
  const fallback_uri = process.env.MONGODB_URI_FALLBACK;

  if (!mongodb_uri && !fallback_uri) {
    throw new Error('MONGODB_URI environment variable is required');
  }
  const raw_database_name = process.env.DATABASE_NAME || 'db-nimble-cascade-ltj335';
  const database_name = normalize_database_name(raw_database_name);

  console.log('🔗 Attempting to connect to MongoDB...');
  console.log('📍 Database:', database_name);
  if (raw_database_name !== database_name) {
    console.log('⚠️  Original database name was too long; using hashed name instead');
  }

  try {
    client = new MongoClient(mongodb_uri || fallback_uri!, {
      serverSelectionTimeoutMS: 8000,    // Shorter timeout for faster failures
      socketTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10,
      minPoolSize: 1,                    // Reduce minimum pool size
      maxIdleTimeMS: 60000,
      waitQueueTimeoutMS: 8000,
      retryWrites: true,
    });

    // Track pool metrics for leak detection
    client.on('connectionCreated', () => {
      poolMetrics.totalConnectionsCreated++;
      poolMetrics.currentActiveConnections++;
      if (poolMetrics.currentActiveConnections > poolMetrics.maxConnectionsObserved) {
        poolMetrics.maxConnectionsObserved = poolMetrics.currentActiveConnections;
      }
    });

    client.on('connectionClosed', () => {
      poolMetrics.totalConnectionsClosed++;
      poolMetrics.currentActiveConnections = Math.max(0, poolMetrics.currentActiveConnections - 1);
    });

    client.on('connectionPoolCreated', () => {
      console.log('🔄 MongoDB connection pool created');
    });

    client.on('connectionPoolClosed', () => {
      console.log('📴 MongoDB connection pool closed');
    });

    await client.connect();
    database = client.db(database_name);
    isConnected = true;
    connectionError = null;
    console.log('✅ Successfully connected to MongoDB Atlas');
    console.log('🗄️ Database ready:', database_name);

    // Run migrations / index management consistently on startup
    await runDatabaseMigrations(database);

    return database;
  } catch (error) {
    const errMsg = (error as Error).message;

    // If we have a fallback URI and the primary failed, try the fallback once
    if (mongodb_uri && fallback_uri && !isConnected) {
      console.warn('⚠️  Primary MongoDB connection failed, trying fallback URI...');
      try {
        client = new MongoClient(fallback_uri, {
          serverSelectionTimeoutMS: 8000,
          socketTimeoutMS: 10000,
          connectTimeoutMS: 10000,
          maxPoolSize: 10,
          minPoolSize: 1,
          maxIdleTimeMS: 60000,
          waitQueueTimeoutMS: 8000,
          retryWrites: true,
        });

        client.on('connectionCreated', () => {
          poolMetrics.totalConnectionsCreated++;
          poolMetrics.currentActiveConnections++;
          if (poolMetrics.currentActiveConnections > poolMetrics.maxConnectionsObserved) {
            poolMetrics.maxConnectionsObserved = poolMetrics.currentActiveConnections;
          }
        });

        client.on('connectionClosed', () => {
          poolMetrics.totalConnectionsClosed++;
          poolMetrics.currentActiveConnections = Math.max(0, poolMetrics.currentActiveConnections - 1);
        });

        await client.connect();
        database = client.db(database_name);
        isConnected = true;
        connectionError = null;
        console.log('✅ Successfully connected to MongoDB via fallback URI');
        console.log('🗄️ Database ready:', database_name);
        await runDatabaseMigrations(database);
        return database;
      } catch (fallbackError) {
        console.warn('⚠️  Fallback MongoDB connection also failed');
      }
    }

    console.warn('⚠️  MongoDB connection failed, running in offline mode');
    console.warn('🔧 This is normal in development - the app will use in-memory storage');
    if (errMsg.includes('tlsv1 alert internal error') || errMsg.includes('SSL alert number 80')) {
      console.warn('🔒 If using MongoDB Atlas, add your current IP to the Network Access allowlist (or set 0.0.0.0/0)');
    }
    console.warn('Error details:', errMsg);
    isConnected = false;
    connectionError = errMsg;
    return null; // Return null instead of throwing
  }
};

export const get_database = (): Db => {
  if (!database) {
    throw new Error('Database not connected. Call connect_to_mongodb() first.');
  }
  return database;
};

export const is_database_connected = (): boolean => {
  return isConnected;
};

export const get_connection_error = (): string | null => {
  return connectionError;
};

export const get_pool_health = (): {
  connected: boolean;
  currentActiveConnections: number;
  maxConnectionsObserved: number;
  totalConnectionsCreated: number;
  totalConnectionsClosed: number;
  connectionError: string | null;
} => {
  return {
    connected: isConnected,
    currentActiveConnections: poolMetrics.currentActiveConnections,
    maxConnectionsObserved: poolMetrics.maxConnectionsObserved,
    totalConnectionsCreated: poolMetrics.totalConnectionsCreated,
    totalConnectionsClosed: poolMetrics.totalConnectionsClosed,
    connectionError,
  };
};

export const close_connection = async (): Promise<void> => {
  if (client) {
    await client.close();
    client = null;
    database = null;
  }
};
