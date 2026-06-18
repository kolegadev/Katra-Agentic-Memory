/**
 * Redis Connection Configuration and Client Setup
 * 
 * This module handles Redis connection management for working memory storage.
 * Implements connection pooling, health checks, and automatic reconnection.
 */

import { createClient, RedisClientType } from 'redis';

let redis_client: RedisClientType | null = null;
let connection_attempts = 0;
let last_failed_attempt = 0;
const COOLDOWN_MS = 30_000;
const MAX_CONNECTION_ATTEMPTS = 5;
const RECONNECT_DELAY = 2000;

/**
 * Normalize Redis URL — if REDIS_URL is just host:port (no protocol),
 * construct a proper redis:// URL from REDIS_PASSWORD.
 */
function normalize_redis_url(): string | undefined {
    const raw_url = process.env.REDIS_URL;
    const password = process.env.REDIS_PASSWORD;

    if (!raw_url) return undefined;

    // Already a full URL?
    if (raw_url.startsWith('redis://') || raw_url.startsWith('rediss://')) {
        return raw_url;
    }

    // It's just host:port — build the URL
    if (password) {
        return `redis://default:${encodeURIComponent(password)}@${raw_url}`;
    }

    return `redis://${raw_url}`;
}

/**
 * Mask sensitive info in a Redis URL for safe logging
 */
function mask_redis_url(url: string): string {
    try {
        const u = new URL(url);
        if (u.password) u.password = '****';
        return u.toString();
    } catch {
        return url;
    }
}

/**
 * Redis configuration from environment variables
 */
const redis_config = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0'),
    // Use normalized Redis Cloud URL if provided
    url: normalize_redis_url()
};

/**
 * Initialize Redis client with connection handling
 */
async function initialize_redis_client(): Promise<RedisClientType> {
    if (redis_client && redis_client.isReady) {
        return redis_client;
    }

    try {
        // Create client with URL if provided, otherwise use host/port config
        const reconnectStrategy = (retries: number) => {
            if (retries >= MAX_CONNECTION_ATTEMPTS) {
                console.error('❌ Redis: Max reconnection attempts reached');
                return false;
            }
            console.log(`🔄 Redis: Reconnecting (attempt ${retries + 1}/${MAX_CONNECTION_ATTEMPTS})`);
            return Math.min(retries * 100, RECONNECT_DELAY);
        };

        let client_options = redis_config.url
            ? {
                url: redis_config.url,
                socket: { reconnectStrategy }
            }
            : {
                socket: {
                    host: redis_config.host,
                    port: redis_config.port,
                    reconnectStrategy
                },
                password: redis_config.password,
                database: redis_config.db
            };

        if (redis_config.url) {
            console.log(`🔌 Redis: Using URL ${mask_redis_url(redis_config.url)}`);
        } else {
            console.log(`🔌 Redis: Using ${redis_config.host}:${redis_config.port}`);
        }

        redis_client = createClient(client_options);

        // Event handlers
        redis_client.on('error', (error) => {
            console.error('❌ Redis Client Error:', error);
            connection_attempts++;
        });

        redis_client.on('connect', () => {
            console.log('🔌 Redis: Connecting...');
            connection_attempts = 0;
        });

        redis_client.on('ready', () => {
            console.log('✅ Redis: Connection ready');
        });

        redis_client.on('end', () => {
            console.log('📴 Redis: Connection closed');
        });

        redis_client.on('reconnecting', () => {
            console.log('🔄 Redis: Reconnecting...');
        });

        // Connect to Redis
        await redis_client.connect();
        
        console.log(`✅ Redis connected to ${redis_config.url || redis_config.host}:${redis_config.port}`);
        return redis_client;

    } catch (error) {
        console.error('❌ Failed to initialize Redis client:', error);
        connection_attempts++;

        // If URL failed and we have host/port fallback config, try once
        if (redis_config.url && !redis_config.url.includes('localhost')
            && (process.env.REDIS_HOST || process.env.REDIS_PORT)
            && connection_attempts < MAX_CONNECTION_ATTEMPTS) {
            console.log('🔄 Redis: URL failed, trying REDIS_HOST/REDIS_PORT fallback...');
            try {
                const fallback_client = createClient({
                    socket: {
                        host: redis_config.host,
                        port: redis_config.port,
                        reconnectStrategy: (retries: number) => {
                            if (retries >= 3) return false;
                            return Math.min(retries * 100, RECONNECT_DELAY);
                        }
                    },
                    password: redis_config.password,
                    database: redis_config.db
                });

                fallback_client.on('error', (err) => {
                    console.error('❌ Redis fallback client error:', err);
                });

                await fallback_client.connect();
                redis_client = fallback_client;
                console.log(`✅ Redis connected via fallback to ${redis_config.host}:${redis_config.port}`);
                return redis_client;
            } catch (fallbackError) {
                console.error('❌ Redis fallback connection also failed:', fallbackError);
            }
        }

        if (connection_attempts >= MAX_CONNECTION_ATTEMPTS) {
            console.error('❌ Redis: Max connection attempts exceeded. Using MongoDB fallback.');
        }

        throw error;
    }
}

/**
 * Get Redis client instance
 * @returns Redis client or null if connection failed
 */
export async function get_redis_client(): Promise<RedisClientType | null> {
    try {
        if (redis_client && redis_client.isReady) {
            return redis_client;
        }
        // Skip reconnection if we recently failed
        if (Date.now() - last_failed_attempt < COOLDOWN_MS) {
            return null;
        }
        redis_client = await initialize_redis_client();
        return redis_client;
    } catch (error) {
        console.error('❌ Failed to get Redis client:', error);
        last_failed_attempt = Date.now();
        return null;
    }
}

/**
 * Check Redis connection health
 * @returns boolean indicating if Redis is available
 */
export async function is_redis_healthy(): Promise<boolean> {
    try {
        const client = await get_redis_client();
        if (!client) return false;

        const pong = await client.ping();
        return pong === 'PONG';
    } catch (error) {
        console.error('❌ Redis health check failed:', error);
        return false;
    }
}

/**
 * Close Redis connection
 */
export async function close_redis_connection(): Promise<void> {
    if (redis_client) {
        try {
            await redis_client.quit();
            console.log('✅ Redis connection closed gracefully');
        } catch (error) {
            console.error('❌ Error closing Redis connection:', error);
        } finally {
            redis_client = null;
        }
    }
}

/**
 * Redis connection status information
 */
export function get_redis_status() {
    return {
        connected: redis_client?.isReady || false,
        connection_attempts,
        config: {
            host: redis_config.host,
            port: redis_config.port,
            db: redis_config.db,
            has_password: !!redis_config.password,
            has_url: !!redis_config.url
        }
    };
}