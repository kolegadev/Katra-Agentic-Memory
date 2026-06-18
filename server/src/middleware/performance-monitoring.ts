/**
 * Performance Monitoring Middleware
 * 
 * Tracks query latency, cache hit rates, and system performance metrics
 * for the cognitive memory architecture.
 */

import type { Context, Next } from 'hono';
import { get_redis_client, get_redis_status } from '../database/redis-connection.js';
import { get_database } from '../database/connection.js';

interface PerformanceMetrics {
    request_count: number;
    total_latency: number;
    average_latency: number;
    min_latency: number;
    max_latency: number;
    cache_hits: number;
    cache_misses: number;
    cache_hit_rate: number;
    redis_operations: number;
    mongodb_operations: number;
    error_count: number;
    last_reset: Date;
}

interface RequestMetrics {
    path: string;
    method: string;
    start_time: number;
    end_time?: number;
    duration?: number;
    status_code?: number;
    cache_hit?: boolean;
    used_redis?: boolean;
    used_mongodb?: boolean;
    error?: string;
}

/**
 * Performance monitoring service
 */
class PerformanceMonitor {
    private metrics: PerformanceMetrics = {
        request_count: 0,
        total_latency: 0,
        average_latency: 0,
        min_latency: Infinity,
        max_latency: 0,
        cache_hits: 0,
        cache_misses: 0,
        cache_hit_rate: 0,
        redis_operations: 0,
        mongodb_operations: 0,
        error_count: 0,
        last_reset: new Date()
    };

    private recent_requests: RequestMetrics[] = [];
    private readonly MAX_RECENT_REQUESTS = 1000;
    private readonly PERFORMANCE_THRESHOLD_MS = 1000; // Warn on requests > 1s

    /**
     * Start tracking a request
     */
    start_request(path: string, method: string): RequestMetrics {
        const request_metrics: RequestMetrics = {
            path,
            method,
            start_time: performance.now()
        };

        return request_metrics;
    }

    /**
     * Complete request tracking
     */
    end_request(request_metrics: RequestMetrics, status_code: number, error?: string): void {
        request_metrics.end_time = performance.now();
        request_metrics.duration = request_metrics.end_time - request_metrics.start_time;
        request_metrics.status_code = status_code;
        request_metrics.error = error;

        // Update aggregate metrics
        this.metrics.request_count++;
        this.metrics.total_latency += request_metrics.duration;
        this.metrics.average_latency = this.metrics.total_latency / this.metrics.request_count;
        this.metrics.min_latency = Math.min(this.metrics.min_latency, request_metrics.duration);
        this.metrics.max_latency = Math.max(this.metrics.max_latency, request_metrics.duration);

        if (error) {
            this.metrics.error_count++;
        }

        // Track cache usage
        if (request_metrics.cache_hit !== undefined) {
            if (request_metrics.cache_hit) {
                this.metrics.cache_hits++;
            } else {
                this.metrics.cache_misses++;
            }
            this.metrics.cache_hit_rate = this.metrics.cache_hits / 
                (this.metrics.cache_hits + this.metrics.cache_misses) * 100;
        }

        // Track database usage
        if (request_metrics.used_redis) {
            this.metrics.redis_operations++;
        }
        if (request_metrics.used_mongodb) {
            this.metrics.mongodb_operations++;
        }

        // Store recent request
        this.recent_requests.push(request_metrics);
        if (this.recent_requests.length > this.MAX_RECENT_REQUESTS) {
            this.recent_requests.shift();
        }

        // Log performance warnings
        if (request_metrics.duration > this.PERFORMANCE_THRESHOLD_MS) {
            console.warn(`⚠️ Slow request: ${request_metrics.method} ${request_metrics.path} took ${request_metrics.duration.toFixed(2)}ms`);
        }

        // Log to structured format for external monitoring
        this.log_request_metrics(request_metrics);
    }

    /**
     * Record cache hit/miss
     */
    record_cache_event(is_hit: boolean, operation_type: 'redis' | 'mongodb' = 'redis'): void {
        if (operation_type === 'redis') {
            this.metrics.redis_operations++;
        } else {
            this.metrics.mongodb_operations++;
        }

        if (is_hit) {
            this.metrics.cache_hits++;
        } else {
            this.metrics.cache_misses++;
        }

        this.metrics.cache_hit_rate = this.metrics.cache_hits / 
            (this.metrics.cache_hits + this.metrics.cache_misses) * 100;
    }

    /**
     * Get current performance metrics
     */
    get_metrics(): PerformanceMetrics & { 
        recent_requests: RequestMetrics[],
        system_health: any 
    } {
        return {
            ...this.metrics,
            recent_requests: this.recent_requests.slice(-100), // Last 100 requests
            system_health: this.get_system_health()
        };
    }

    /**
     * Get performance statistics by endpoint
     */
    get_endpoint_stats() {
        const endpoint_stats = new Map<string, {
            count: number;
            total_duration: number;
            avg_duration: number;
            min_duration: number;
            max_duration: number;
            error_count: number;
        }>();

        this.recent_requests.forEach(req => {
            const endpoint = `${req.method} ${req.path}`;
            const existing = endpoint_stats.get(endpoint) || {
                count: 0,
                total_duration: 0,
                avg_duration: 0,
                min_duration: Infinity,
                max_duration: 0,
                error_count: 0
            };

            if (req.duration) {
                existing.count++;
                existing.total_duration += req.duration;
                existing.avg_duration = existing.total_duration / existing.count;
                existing.min_duration = Math.min(existing.min_duration, req.duration);
                existing.max_duration = Math.max(existing.max_duration, req.duration);
            }

            if (req.error) {
                existing.error_count++;
            }

            endpoint_stats.set(endpoint, existing);
        });

        return Object.fromEntries(endpoint_stats);
    }

    /**
     * Reset metrics
     */
    reset_metrics(): void {
        this.metrics = {
            request_count: 0,
            total_latency: 0,
            average_latency: 0,
            min_latency: Infinity,
            max_latency: 0,
            cache_hits: 0,
            cache_misses: 0,
            cache_hit_rate: 0,
            redis_operations: 0,
            mongodb_operations: 0,
            error_count: 0,
            last_reset: new Date()
        };
        this.recent_requests = [];
        console.log('📊 Performance metrics reset');
    }

    /**
     * Get system health information
     */
    private get_system_health() {
        const redis_status = get_redis_status();
        
        return {
            redis: redis_status,
            mongodb: {
                connected: true, // TODO: Implement MongoDB health check
            },
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            cpu_usage: process.cpuUsage()
        };
    }

    /**
     * Log request metrics in structured format
     */
    private log_request_metrics(request: RequestMetrics): void {
        if (process.env.NODE_ENV === 'production') {
            // In production, log structured JSON for external systems
            console.log(JSON.stringify({
                type: 'request_metrics',
                timestamp: new Date().toISOString(),
                path: request.path,
                method: request.method,
                duration_ms: request.duration,
                status_code: request.status_code,
                cache_hit: request.cache_hit,
                used_redis: request.used_redis,
                used_mongodb: request.used_mongodb,
                error: request.error
            }));
        }
    }
}

// Singleton instance
const performance_monitor = new PerformanceMonitor();

/**
 * Hono middleware for performance tracking
 */
export const performance_middleware = async (c: Context, next: Next) => {
    const request_metrics = performance_monitor.start_request(c.req.path, c.req.method);
    
    // Add performance context to request
    c.set('performance_metrics', request_metrics);
    c.set('performance_monitor', performance_monitor);

    let error: string | undefined;
    
    try {
        await next();
    } catch (e) {
        error = e instanceof Error ? e.message : 'Unknown error';
        throw e;
    } finally {
        performance_monitor.end_request(request_metrics, c.res.status, error);
    }
};

/**
 * Helper function to record cache events from services
 */
export const record_cache_event = (is_hit: boolean, operation_type: 'redis' | 'mongodb' = 'redis') => {
    performance_monitor.record_cache_event(is_hit, operation_type);
};

/**
 * Helper to mark request as using Redis
 */
export const mark_redis_usage = (c: Context) => {
    const metrics = c.get('performance_metrics') as RequestMetrics;
    if (metrics) {
        metrics.used_redis = true;
    }
};

/**
 * Helper to mark request as using MongoDB
 */
export const mark_mongodb_usage = (c: Context) => {
    const metrics = c.get('performance_metrics') as RequestMetrics;
    if (metrics) {
        metrics.used_mongodb = true;
    }
};

/**
 * Helper to mark cache hit/miss
 */
export const mark_cache_result = (c: Context, is_hit: boolean) => {
    const metrics = c.get('performance_metrics') as RequestMetrics;
    if (metrics) {
        metrics.cache_hit = is_hit;
    }
};

/**
 * Get performance dashboard data
 */
export const get_performance_dashboard = () => {
    return {
        current_metrics: performance_monitor.get_metrics(),
        endpoint_stats: performance_monitor.get_endpoint_stats(),
        alerts: get_performance_alerts()
    };
};

/**
 * Get performance alerts
 */
function get_performance_alerts() {
    const metrics = performance_monitor.get_metrics();
    const alerts = [];

    if (metrics.average_latency > 500) {
        alerts.push({
            level: 'warning',
            message: `Average response time is ${metrics.average_latency.toFixed(2)}ms (threshold: 500ms)`,
            metric: 'latency'
        });
    }

    if (metrics.cache_hit_rate < 80 && metrics.cache_hits + metrics.cache_misses > 100) {
        alerts.push({
            level: 'warning',
            message: `Cache hit rate is ${metrics.cache_hit_rate.toFixed(1)}% (target: >80%)`,
            metric: 'cache_hit_rate'
        });
    }

    if (metrics.error_count > 0 && metrics.error_count / metrics.request_count > 0.05) {
        alerts.push({
            level: 'error',
            message: `Error rate is ${((metrics.error_count / metrics.request_count) * 100).toFixed(1)}% (threshold: 5%)`,
            metric: 'error_rate'
        });
    }

    if (!metrics.system_health?.redis?.connected) {
        alerts.push({
            level: 'error',
            message: 'Redis connection is down - using MongoDB fallback',
            metric: 'redis_health'
        });
    }

    return alerts;
}

/**
 * Reset performance metrics
 */
export const reset_performance_metrics = () => {
    performance_monitor.reset_metrics();
};

export { performance_monitor };