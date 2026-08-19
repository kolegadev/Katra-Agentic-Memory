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
}

const LEGACY_DEFAULT_NAME = 'Unnamed Memory';

async function getStoredIdentity(): Promise<AgentIdentity | null> {
  try {
    const db = get_database();
    const doc = await db.collection('system_settings').findOne({ key: 'agent_identity' });
    if (doc && doc.value && typeof doc.value.name === 'string' && doc.value.name.trim()) {
      return doc.value as AgentIdentity;
    }
    return null;
  } catch {
    return null; // DB not ready — fall through to env/default
  }
}

export async function getAgentIdentity(): Promise<AgentIdentity> {
  const stored = await getStoredIdentity();
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

export async function getAgentIdentityName(): Promise<string> {
  return (await getAgentIdentity()).name;
}

export async function setAgentIdentity(identity: AgentIdentity): Promise<AgentIdentity> {
  const db = get_database();
  const clean: AgentIdentity = {
    name: String(identity.name || '').trim().slice(0, 80),
    chosen_by: String(identity.chosen_by || 'unknown').slice(0, 200),
    confirmed_by: identity.confirmed_by ? String(identity.confirmed_by).slice(0, 200) : undefined,
    established: identity.established || new Date().toISOString().slice(0, 10),
    rationale: identity.rationale ? String(identity.rationale).slice(0, 500) : undefined,
    updated_at: new Date().toISOString(),
  };
  if (!clean.name) throw new Error('Identity name must not be empty');
  await db.collection('system_settings').updateOne(
    { key: 'agent_identity' },
    { $set: { key: 'agent_identity', value: clean, updated_at: new Date() } },
    { upsert: true },
  );
  return clean;
}
