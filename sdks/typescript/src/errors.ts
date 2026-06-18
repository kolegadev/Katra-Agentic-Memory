/**
 * Katra SDK — Custom Error Classes
 *
 * Provides typed errors for connection failures, authentication issues,
 * and general API errors returned by the Katra cognitive memory server.
 *
 * @module errors
 */

/** Base error class for all Katra SDK errors. */
export class KatraError extends Error {
  /** Optional HTTP status code associated with the error. */
  public readonly status?: number;

  /** Optional Katra-specific error code. */
  public readonly code?: number;

  constructor(message: string, options?: { status?: number; code?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'KatraError';
    this.status = options?.status;
    this.code = options?.code;
  }
}

/**
 * Thrown when authentication fails (401/403).
 *
 * The Katra server validates credentials via:
 * - `Authorization: Bearer <token>` header
 * - `X-MCP-Auth` header
 * - `?token=` query parameter
 */
export class KatraAuthError extends KatraError {
  constructor(message = 'Authentication failed — check your API key') {
    super(message, { status: 401 });
    this.name = 'KatraAuthError';
  }
}

/**
 * Thrown when the SDK cannot reach the Katra server or the connection is
 * interrupted mid-session.
 */
export class KatraConnectionError extends KatraError {
  constructor(message = 'Could not connect to Katra server', options?: { cause?: unknown }) {
    super(message, { status: 503, cause: options?.cause });
    this.name = 'KatraConnectionError';
  }
}
