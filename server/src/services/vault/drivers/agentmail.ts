/**
 * Katra Vault — AgentMail driver (F7)
 *
 * Typed ops for the AgentMail REST API, built on the capability core
 * (service 'agentmail', secret injected as the raw key via
 * `injectHeader: 'Authorization'` — the driver never sees the key itself,
 * only the DriverContext that carries it).
 *
 * ⚠ Endpoint shapes per agentmail.to v0 public docs
 * (https://api.agentmail.to/v0/...) — VERIFY AT FIRST REAL USE:
 *   inbox_list:     GET    /v0/inboxes
 *   thread_list:    GET    /v0/inboxes/:inboxId/threads
 *   thread_reply:   POST   /v0/threads/:threadId/replies   body {"message": …}
 *   inbox_create:   POST   /v0/inboxes                    body {"name": …}
 * (A real AgentMail account + key is needed to confirm the exact payload
 * fields; the URL + Authorization shapes below follow the public docs.)
 *
 * Each op returns the parsed upstream JSON body when the upstream responds
 * with a body, the raw body string when it is not JSON, and the unchanged
 * capability result ({status: 0, blocked: …}) when the request was refused
 * by a guard or a limit. The secret never appears in any returned value.
 *
 * Registered on module import.
 */

import { registerDriver } from './index.js';
import type { DriverContext, ServiceDriver } from './index.js';
import type { CapabilityInput, CapabilityResult } from '../capability.js';

const AGENTMAIL_BASE = 'https://api.agentmail.to/v0';
const AGENTMAIL_SERVICE = 'agentmail';
const AGENTMAIL_AUTH_HEADER = 'Authorization';

function urlFor(op: string, ...ids: string[]): string {
  switch (op) {
    case 'inbox_list':
      return `${AGENTMAIL_BASE}/inboxes`;
    case 'thread_list':
      return `${AGENTMAIL_BASE}/inboxes/${encodeURIComponent(ids[0])}/threads`;
    case 'thread_reply':
      return `${AGENTMAIL_BASE}/threads/${encodeURIComponent(ids[0])}/replies`;
    case 'inbox_create':
      return `${AGENTMAIL_BASE}/inboxes`;
    default:
      throw new Error(`vault: agentmail driver: unknown op '${op}'`);
  }
}

/** Run one AgentMail request through the approval-gated capability core. */
function agentmailRequest(
  ctx: DriverContext,
  method: string,
  url: string,
  body?: string,
): Promise<CapabilityResult> {
  const input: CapabilityInput = {
    caller: ctx.caller,
    secretId: ctx.secretId,
    service: AGENTMAIL_SERVICE,
    method,
    url,
    injectHeader: AGENTMAIL_AUTH_HEADER,
    // Verified live 2026-09-04: the AgentMail v0 API expects
    // `Authorization: Bearer <api_key>` (raw key → 403).
    injectScheme: 'Bearer',
  };
  if (body !== undefined) input.body = body;
  return ctx.vaultHttp(input);
}

/** Capability result → parsed upstream body (JSON first, else raw text);
 *  blocked/refused results pass through untouched. */
async function parsedBody(result: CapabilityResult): Promise<unknown> {
  if (result.blocked !== undefined || result.status === 0) return result;
  if (result.body === '') return result;
  try {
    return JSON.parse(result.body) as unknown;
  } catch {
    return result.body;
  }
}

export const agentmailDriver: ServiceDriver = {
  service: AGENTMAIL_SERVICE,
  ops: {
    /** List inboxes: GET https://api.agentmail.to/v0/inboxes */
    async inbox_list(ctx: DriverContext): Promise<unknown> {
      return parsedBody(await agentmailRequest(ctx, 'GET', urlFor('inbox_list')));
    },
    /** List an inbox's threads: GET …/v0/inboxes/:inboxId/threads */
    async thread_list(ctx: DriverContext, inboxId: string): Promise<unknown> {
      return parsedBody(
        await agentmailRequest(ctx, 'GET', urlFor('thread_list', inboxId)),
      );
    },
    /** Reply to a thread: POST …/v0/threads/:threadId/replies {"message": …} */
    async thread_reply(
      ctx: DriverContext,
      threadId: string,
      message: string,
    ): Promise<unknown> {
      return parsedBody(
        await agentmailRequest(
          ctx,
          'POST',
          urlFor('thread_reply', threadId),
          JSON.stringify({ message }),
        ),
      );
    },
    /** Create an inbox: POST https://api.agentmail.to/v0/inboxes {"name": …} */
    async inbox_create(ctx: DriverContext, name: string): Promise<unknown> {
      return parsedBody(
        await agentmailRequest(
          ctx,
          'POST',
          urlFor('inbox_create'),
          JSON.stringify({ name }),
        ),
      );
    },
  },
};

registerDriver(agentmailDriver);
