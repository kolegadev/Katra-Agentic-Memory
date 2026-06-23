import type { Context, MiddlewareHandler } from 'hono';
import { createHash } from 'crypto';
import { get_redis_client } from '../database/redis-connection.js';

interface RateLimitOptions {
  max: number;
  windowMs: number;
  keyPrefix: string;
  /**
   * When Redis is unavailable, allow the request (true) or block with 503
   * (false). Default: true. Set to false for destructive/irreversible endpoints
   * where the rate limit is a hard security control.
   */
  failOpen?: boolean;
  /**
   * 'ip'    — rate-limit by client IP (default; spoofable behind untrusted proxies)
   * 'apiKey'— rate-limit by a hash of the Authorization header, better for
   *           authenticated endpoints where IP is less meaningful
   */
  identifyBy?: 'ip' | 'apiKey';
}

// Lua script: atomically INCR and set TTL only on first touch.
// Returns the new counter value. Avoids the INCR + EXPIRE race that can
// leave keys without a TTL if the process crashes between the two calls.
const INCR_WITH_TTL_SCRIPT = `
  local cur = redis.call('INCR', KEYS[1])
  if cur == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return cur
`;

function get_client_ip(c: Context): string {
  // DEPLOYMENT NOTE: header trust order assumes a Cloudflare or similar
  // trusted-proxy topology. CF-Connecting-IP cannot be spoofed by the client.
  // X-Forwarded-For: take the rightmost entry (appended by our proxy, not client).
  const cf = c.req.header('CF-Connecting-IP');
  if (cf) return cf;

  const xff = c.req.header('X-Forwarded-For');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    const rightmost = parts[parts.length - 1];
    if (rightmost) return rightmost;
  }

  return c.req.header('X-Real-IP') || 'unknown';
}

function get_identity(c: Context, mode: 'ip' | 'apiKey'): string {
  if (mode === 'apiKey') {
    const raw = c.req.header('Authorization') || c.req.header('X-API-Key');
    if (raw) {
      const h = createHash('sha256').update(raw).digest('hex').slice(0, 16);
      return `key:${h}`;
    }
  }
  return `ip:${get_client_ip(c)}`;
}

export function create_rate_limiter(options: RateLimitOptions): MiddlewareHandler {
  const { max, windowMs, keyPrefix, failOpen = true, identifyBy = 'ip' } = options;
  const windowSec = Math.ceil(windowMs / 1000);

  return async (c, next) => {
    let redis: Awaited<ReturnType<typeof get_redis_client>>;
    try {
      redis = await get_redis_client();
    } catch {
      redis = null;
    }

    if (!redis) {
      if (failOpen) return next();
      return c.json({ success: false, error: 'Rate limiter temporarily unavailable' }, 503);
    }

    const identity = get_identity(c, identifyBy);
    const nowMs = Date.now();
    const win = Math.floor(nowMs / windowMs);
    const elapsedFraction = (nowMs % windowMs) / windowMs;

    const curKey = `rl:${keyPrefix}:${identity}:${win}`;
    const prevKey = `rl:${keyPrefix}:${identity}:${win - 1}`;

    try {
      // Sliding-window approximation: combine current window count with the
      // previous window's count weighted by how far we are into the current
      // window. This prevents the 2× burst that fixed-window allows at boundaries.
      const curCount = (await redis.eval(INCR_WITH_TTL_SCRIPT, {
        keys: [curKey],
        arguments: [String(windowSec * 2 + 1)],
      })) as number;

      const prevRaw = await redis.get(prevKey);
      const prevCount = prevRaw ? parseInt(prevRaw, 10) : 0;

      const weighted = curCount + prevCount * (1 - elapsedFraction);

      c.header('X-RateLimit-Limit', String(max));

      if (weighted > max) {
        const resetMs = (win + 1) * windowMs;
        const retryAfter = Math.max(1, Math.ceil((resetMs - nowMs) / 1000));
        c.header('Retry-After', String(retryAfter));
        c.header('X-RateLimit-Remaining', '0');
        return c.json({ success: false, error: 'Too many requests', retry_after: retryAfter }, 429);
      }

      c.header('X-RateLimit-Remaining', String(Math.max(0, Math.floor(max - weighted))));
    } catch (err) {
      console.warn(`[rate-limit:${keyPrefix}] Redis error:`, err);
      if (!failOpen) {
        return c.json({ success: false, error: 'Rate limiter temporarily unavailable' }, 503);
      }
    }

    return next();
  };
}
