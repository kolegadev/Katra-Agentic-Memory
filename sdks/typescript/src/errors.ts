/**
 * Satori SDK — Custom Error Classes
 *
 * Provides typed errors for connection failures, authentication issues,
 * and general API errors returned by the Satori cognitive memory server.
 *
 * @module errors
 */

/** Base error class for all Satori SDK errors. */
export class SatoriError extends Error {
  /** Optional HTTP status code associated with the error. */
  public readonly status?: number;

  /** Optional Satori-specific error code. */
  public readonly code?: number;

  constructor(message: string, options?: { status?: number; code?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'SatoriError';
    this.status = options?.status;
    this.code = options?.code;
  }
}

/**
 * Thrown when authentication fails (401/403).
 *
 * The Satori server validates credentials via:
 * - `Authorization: Bearer <token>` header
 * - `X-MCP-Auth` header
 * - `?token=` query parameter
 */
export class SatoriAuthError extends SatoriError {
  constructor(message = 'Authentication failed — check your API key') {
    super(message, { status: 401 });
    this.name = 'SatoriAuthError';
  }
}

/**
 * Thrown when the SDK cannot reach the Satori server or the connection is
 * interrupted mid-session.
 */
export class SatoriConnectionError extends SatoriError {
  constructor(message = 'Could not connect to Satori server', options?: { cause?: unknown }) {
    super(message, { status: 503, cause: options?.cause });
    this.name = 'SatoriConnectionError';
  }
}
