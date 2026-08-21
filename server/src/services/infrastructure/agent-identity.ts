/**
 * Agent Identity — the name the memory holds for its own inhabitant.
 *
 * John's design (2026-08-19): the agent's identity must live INSIDE the
 * memory, not in the code. The MCP server, the dashboard, and every
 * identity-bearing surface ask the memory who they are; the memory
 * answers with the stored name. The LLM bodies change; the memory and
 * the name it carries are the continuity.
 *
 * Stored in system_settings under key `agent_identity`. Fallback chain
 * when no record exists: AGENT_IDENTITY_NAME env → 'Katra'.
 *
 * F3 (identity separation, 2026-08-21): identity records are now PER USER.
 * The legacy `agent_identity` record is Satori's (the pre-separation single
 * identity, established 2026-08-19). Each additional identity (Shoshin,
 * Zanshin) is stored under `agent_identity:<user_id>`. Per-user lookups
 * read ONLY the per-user record; when it is missing they return an unnamed
 * default identity named after the user_id — never the legacy record. The
 * legacy record is reachable only through the no-arg call (satori's chain).
 */

import { get_database } from '../../database/connection.js';

export interface AgentIdentity {
  name: string;
  /** Who chose this name — the agent itself, its operator, or both. */
  chosen_by: string;
  confirmed_by?: string;
  /** ISO date the identity was established / last changed. */
  established: string;
  rationale?: string;
  updated_at?: string;
  /**
   * True while the identity is still the built-in fallback — i.e. the
   * memory has never been named by its owner. The dashboard uses this to
   * show the first-run onboarding prompt; a fresh install names itself
   * instead of inheriting anyone else's name.
   */
  is_default?: boolean;
  /** The user this identity record belongs to (F3 per-user identities). */
  user_id?: string;
}

const LEGACY_DEFAULT_NAME = 'Unnamed Memory';

/** Legacy single-identity record key — this record IS satori's. */
export const LEGACY_IDENTITY_KEY = 'agent_identity';

/** Per-user identity record key: `agent_identity:<user_id>` (F3). */
export function agentIdentityKey(userId: string): string {
  return `agent_identity:${userId}`;
}

async function getStoredIdentity(key: string): Promise<AgentIdentity | null> {
  try {
    const db = get_database();
    const doc = await db.collection('system_settings').findOne({ key });
    if (doc && doc.value && typeof doc.value.name === 'string' && doc.value.name.trim()) {
      return doc.value as AgentIdentity;
    }
    return null;
  } catch {
    return null; // DB not ready — fall through to env/default
  }
}

/**
 * Resolve the identity record for a user.
 *
 * - `getAgentIdentity('shoshin')` reads `agent_identity:shoshin`. When no
 *   per-user record exists it returns an unnamed DEFAULT identity named
 *   after the user_id — it must NEVER fall back to the legacy record,
 *   because that would hand one agent another agent's identity.
 * - `getAgentIdentity()` (no-arg) keeps the existing behavior: the legacy
 *   `agent_identity` record → AGENT_IDENTITY_NAME env → built-in default.
 *   This is satori's chain (backward compatibility).
 */
export async function getAgentIdentity(userId?: string): Promise<AgentIdentity> {
  if (userId) {
    const perUser = await getStoredIdentity(agentIdentityKey(userId));
    if (perUser) return perUser;
    // F3: a caller asking for ITS OWN identity must never receive another
    // agent's record. No per-user record → unnamed default for that user.
    return {
      name: userId,
      chosen_by: 'default (unnamed)',
      established: new Date().toISOString().slice(0, 10),
      is_default: true,
      user_id: userId,
    };
  }
  const stored = await getStoredIdentity(LEGACY_IDENTITY_KEY);
  if (stored) return stored;
  const envName = process.env.AGENT_IDENTITY_NAME?.trim();
  if (envName) {
    return {
      name: envName,
      chosen_by: 'environment (AGENT_IDENTITY_NAME)',
      established: new Date().toISOString().slice(0, 10),
      is_default: false,
    };
  }
  return {
    name: LEGACY_DEFAULT_NAME,
    chosen_by: 'not yet named',
    established: 'not established',
    rationale:
      'This memory has not been named yet. The dashboard onboarding will ask its owner to give it a name — the identity every MCP client will see.',
    is_default: true,
  };
}

export async function getAgentIdentityName(userId?: string): Promise<string> {
  return (await getAgentIdentity(userId)).name;
}

/**
 * Persist an identity record.
 *
 * - `setAgentIdentity(record)` — one-arg form (existing behavior): writes
 *   the legacy `agent_identity` record, i.e. satori's identity.
 * - `setAgentIdentity(userId, record)` — per-user form (F3): writes
 *   `agent_identity:<user_id>` for the given identity.
 */
export async function setAgentIdentity(
  identity: AgentIdentity
): Promise<AgentIdentity>;
export async function setAgentIdentity(
  userId: string,
  identity: AgentIdentity
): Promise<AgentIdentity>;
export async function setAgentIdentity(
  userIdOrIdentity: string | AgentIdentity,
  maybeIdentity?: AgentIdentity
): Promise<AgentIdentity> {
  let key: string;
  let raw: AgentIdentity;
  if (typeof userIdOrIdentity === 'string') {
    key = agentIdentityKey(userIdOrIdentity);
    if (!maybeIdentity) {
      throw new Error('Identity record is required when userId is provided');
    }
    raw = maybeIdentity;
  } else {
    key = LEGACY_IDENTITY_KEY;
    raw = userIdOrIdentity;
  }

  const db = get_database();
  const clean: AgentIdentity = {
    name: String(raw.name || '').trim().slice(0, 80),
    chosen_by: String(raw.chosen_by || 'unknown').slice(0, 200),
    confirmed_by: raw.confirmed_by ? String(raw.confirmed_by).slice(0, 200) : undefined,
    established: raw.established || new Date().toISOString().slice(0, 10),
    rationale: raw.rationale ? String(raw.rationale).slice(0, 500) : undefined,
    updated_at: new Date().toISOString(),
  };
  if (!clean.name) throw new Error('Identity name must not be empty');
  await db.collection('system_settings').updateOne(
    { key },
    { $set: { key, value: clean, updated_at: new Date() } },
    { upsert: true },
  );
  return clean;
}
