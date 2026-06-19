/**
 * Katra SDK — Low-Level MCP Client
 *
 * Handles the MCP protocol layer: JSON-RPC framing, SSE response parsing,
 * session handshake (`initialize`), authentication, and request deduplication.
 *
 * This class is used internally by `KatraClient`. End-users should use the
 * high-level `KatraClient` API instead.
 *
 * @module mcp-client
 * @internal
 */

import {
  KatraConnectionError,
  KatraAuthError,
  KatraError,
} from './errors.js';
import type { MCPRequest, MCPResponse, MCPInitializeResult } from './types.js';

/** Options for the low-level MCP client. */
export interface MCPClientOptions {
  /** Base URL of the Katra MCP server. */
  url: string;
  /** API key (optional — only needed if the server requires auth). */
  apiKey?: string;
  /** Custom fetch implementation. */
  fetch?: typeof fetch;
  /** Maximum wait for a single RPC call in ms (default 30_000). */
  timeoutMs?: number;
}

/**
 * Low-level JSON-RPC 2.0 client that speaks the MCP Streamable HTTP
 * transport protocol. Manages the `initialize` handshake, session ID
 * tracking, and SSE-based response parsing.
 */
export class MCPClient {
  readonly #url: string;
  readonly #apiKey?: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #sessionId: string | null = null;
  #nextId = 1;
  #initialized = false;

  constructor(options: MCPClientOptions) {
    const trimmed = options.url.replace(/\/+$/, '');
    this.#url = `${trimmed}/mcp`;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Whether the `initialize` handshake has completed. */
  get initialized(): boolean {
    return this.#initialized;
  }

  /** The current MCP session ID, or `null` before initialization. */
  get sessionId(): string | null {
    return this.#sessionId;
  }

  /**
   * Perform the MCP `initialize` handshake.
   *
   * Must be called once before any `callTool` invocations. The server
   * returns an `mcp-session-id` header that must be passed on subsequent
   * requests.
   *
   * @throws {KatraConnectionError} if the server is unreachable.
   * @throws {KatraAuthError} if the server returns 401/403.
   * @throws {KatraError} on other errors.
   */
  async initialize(): Promise<MCPInitializeResult> {
    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: this.#nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: {
          name: 'katra-sdk-ts',
          version: '1.0.0',
        },
      },
    };

    const { response, sessionId } = await this.#send(request);
    this.#sessionId = sessionId;
    this.#initialized = true;

    // Send the required `initialized` notification (no id)
    // Note: notifications don't have an id and don't expect a response.
    // We send the notification but don't await a response — just fire and forget.
    try {
      const notifHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      if (sessionId) notifHeaders['mcp-session-id'] = sessionId;
      if (this.#apiKey) notifHeaders.Authorization = `Bearer ${this.#apiKey}`;
      await this.#fetch(this.#url, {
        method: 'POST',
        headers: notifHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // Best-effort — notification doesn't require a response
    }

    return response.result as MCPInitializeResult;
  }

  /**
   * Call a tool by name with typed arguments.
   *
   * The session must already be initialized via {@link initialize}.
   *
   * @param name - Tool name (e.g. `store_memory`).
   * @param args - Tool arguments object.
   * @returns Parsed JSON-RPC result content.
   * @throws {KatraError} if the server returns a JSON-RPC error.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.#initialized) {
      await this.initialize();
    }

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: this.#nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    };

    const { response } = await this.#send(request);

    if (response.error) {
      throw new KatraError(response.error.message, {
        code: response.error.code,
        status: response.error.code === -32000 ? 401 : 500,
      });
    }

    // The result is { content: MCPContent[] } — extract the text content
    const result = response.result as { content?: Array<{ type: string; text: string }>; isError?: boolean } | undefined;

    if (!result) return null;

    // If the tool itself returned an error
    if (result.isError) {
      const text = result.content?.map((c) => c.text).join('\n') ?? 'Unknown error';
      throw new KatraError(text);
    }

    return result.content?.map((c) => c.text).join('\n') ?? null;
  }

  /**
   * Release the session by sending a DELETE request (best-effort).
   */
  async close(): Promise<void> {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.#sessionId) {
        headers['mcp-session-id'] = this.#sessionId;
      }
      if (this.#apiKey) {
        headers.Authorization = `Bearer ${this.#apiKey}`;
      }
      await this.#fetch(this.#url, { method: 'DELETE', headers });
    } catch {
      // Best-effort
    }
    this.#sessionId = null;
    this.#initialized = false;
  }

  // ── Private Helpers ─────────────────────────────────────────────

  /**
   * Send a JSON-RPC request via HTTP POST and parse the SSE response.
   *
   * The MCP Streamable HTTP transport returns either:
   * - A single JSON body (for simple responses)
   * - SSE text/event-stream (for streaming / long-running operations)
   *
   * Session ID is extracted from the `mcp-session-id` response header.
   */
  async #send(
    request: MCPRequest & { id?: number },
  ): Promise<{
    response: MCPResponse;
    sessionId: string | null;
  }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };

    if (this.#sessionId) {
      headers['mcp-session-id'] = this.#sessionId;
    }

    if (this.#apiKey) {
      headers.Authorization = `Bearer ${this.#apiKey}`;
    }

    // Don't send a body for notifications (no id) — but we always need a body for JSON-RPC
    // Notifications are JSON-RPC requests without an id field
    const body = JSON.stringify(request);

    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new KatraConnectionError(
        `Failed to reach Katra server at ${this.#url}`,
        { cause: err },
      );
    }

    // Extract session ID from response header
    const sessionId = res.headers.get('mcp-session-id');

    // Handle auth errors
    if (res.status === 401 || res.status === 403) {
      throw new KatraAuthError(`Authentication failed (HTTP ${res.status})`);
    }

    // Some servers return 405 for GET SSE (we only POST so this is unusual)
    if (res.status === 405) {
      throw new KatraError('Katra server does not support this request method');
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new KatraError(`Katra server error (HTTP ${res.status}): ${text}`, {
        status: res.status,
      });
    }

    const contentType = res.headers.get('content-type') ?? '';

    if (contentType.includes('text/event-stream')) {
      // Parse SSE stream — collect all `data:` lines into a single response
      const text = await res.text();
      return {
        response: this.#parseSSE(text, request.id ?? 0),
        sessionId,
      };
    }

    // Plain JSON response
    const json = (await res.json()) as MCPResponse;
    return { response: json, sessionId };
  }

  /**
   * Parse an SSE (Server-Sent Events) stream into a single JSON-RPC response.
   *
   * Concatenates all `data:` lines and treats the final one as the JSON-RPC
   * response object. Handles multiple events (e.g., multiple tool results).
   */
  #parseSSE(text: string, requestId: number): MCPResponse {
    const lines = text.split('\n');
    const dataLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        dataLines.push(trimmed.slice(5).trim());
      }
    }

    if (dataLines.length === 0) {
      return {
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32603, message: 'Empty SSE response from Katra' },
      };
    }

    // Try each data line in reverse — the last valid JSON is the result
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        const line = dataLines[i];
        if (!line) continue;
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && 'jsonrpc' in parsed) {
          return parsed as MCPResponse;
        }
      } catch {
        // Continue — maybe a later line is valid JSON
      }
    }

    // Fallback: parse the first line
    try {
      const firstLine = dataLines[0];
      return JSON.parse(firstLine ?? '{}') as MCPResponse;
    } catch {
      return {
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32603, message: `Could not parse SSE response: ${text.slice(0, 200)}` },
      };
    }
  }
}
