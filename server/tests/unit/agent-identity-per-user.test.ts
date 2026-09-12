/**
 * Unit tests: per-user agent identity records (F3)
 *
 * getAgentIdentity(userId) reads system_settings key `agent_identity:<user_id>`;
 * when that record is missing it returns an unnamed DEFAULT identity named
 * after the user_id — never the legacy `agent_identity` record (katra's).
 * Only the no-arg form keeps the legacy-record behavior; setAgentIdentity(
 * userId, record) writes the per-user record while the one-arg form keeps
 * writing the legacy record.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, any>());

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => ({
    collection: () => ({
      findOne: async ({ key }: { key?: string }) =>
        store.has(key!) ? { key, value: store.get(key!) } : null,
      updateOne: async ({ key }: { key?: string }, update: any = {}) => {
        store.set(key!, (update.$set ?? {}).value);
        return { acknowledged: true, upsertedCount: 1 };
      },
    }),
  }),
  is_database_connected: () => true,
}));

import {
  getAgentIdentity,
  setAgentIdentity,
  agentIdentityKey,
  LEGACY_IDENTITY_KEY,
  type AgentIdentity,
} from '../../src/services/infrastructure/agent-identity.js';

const LEGACY_RECORD: AgentIdentity = {
  name: 'Katra',
  chosen_by: 'the agent',
  established: '2026-08-19',
};

const AGENT_A_RECORD: AgentIdentity = {
  name: 'Agent-A',
  chosen_by: 'the agent',
  established: '2026-08-21',
};

describe('per-user identity records (F3)', () => {
  beforeEach(() => {
    store.clear();
    delete process.env.AGENT_IDENTITY_NAME;
  });

  afterEach(() => {
    store.clear();
    delete process.env.AGENT_IDENTITY_NAME;
  });

  it('no-arg getAgentIdentity keeps the legacy-record behavior (katra)', async () => {
    store.set(LEGACY_IDENTITY_KEY, LEGACY_RECORD);
    const identity = await getAgentIdentity();
    expect(identity.name).toBe('Katra');
    expect(identity.established).toBe('2026-08-19');
  });

  it("getAgentIdentity('katra') returns an unnamed default identity when no per-user record exists (never the legacy record)", async () => {
    store.set(LEGACY_IDENTITY_KEY, LEGACY_RECORD);
    const identity = await getAgentIdentity('katra');
    expect(identity.name).toBe('katra');
    expect(identity.name).not.toBe('Katra');
    expect(identity.is_default).toBe(true);
    expect(identity.chosen_by).toBe('default (unnamed)');
    expect(identity.user_id).toBe('katra');
  });

  it("getAgentIdentity('katra') prefers agent_identity:katra over the legacy record", async () => {
    store.set(LEGACY_IDENTITY_KEY, LEGACY_RECORD);
    store.set(agentIdentityKey('katra'), { ...LEGACY_RECORD, name: 'Katra v2', established: '2026-08-21' });
    const identity = await getAgentIdentity('katra');
    expect(identity.name).toBe('Katra v2');
    expect(identity.established).toBe('2026-08-21');
  });

  it("getAgentIdentity('agent-a') returns the agent_identity:agent-a record", async () => {
    store.set(LEGACY_IDENTITY_KEY, LEGACY_RECORD);
    store.set(agentIdentityKey('agent-a'), AGENT_A_RECORD);
    const identity = await getAgentIdentity('agent-a');
    expect(identity.name).toBe('Agent-A');
    expect(identity.established).toBe('2026-08-21');
  });

  it("getAgentIdentity('agent-b') returns an unnamed default identity when its own record is missing (never katra's)", async () => {
    store.set(LEGACY_IDENTITY_KEY, LEGACY_RECORD);
    const identity = await getAgentIdentity('agent-b');
    expect(identity.name).toBe('agent-b');
    expect(identity.name).not.toBe('Katra');
    expect(identity.is_default).toBe(true);
    expect(identity.chosen_by).toBe('default (unnamed)');
  });

  it("setAgentIdentity('agent-a', record) writes under agent_identity:agent-a", async () => {
    await setAgentIdentity('agent-a', AGENT_A_RECORD);
    expect(store.has(agentIdentityKey('agent-a'))).toBe(true);
    expect(store.get(agentIdentityKey('agent-a')).name).toBe('Agent-A');
    expect(store.has(LEGACY_IDENTITY_KEY)).toBe(false);

    const identity = await getAgentIdentity('agent-a');
    expect(identity.name).toBe('Agent-A');
  });

  it('one-arg setAgentIdentity keeps the existing legacy-record behavior (katra)', async () => {
    await setAgentIdentity(LEGACY_RECORD);
    expect(store.has(LEGACY_IDENTITY_KEY)).toBe(true);
    expect(store.get(LEGACY_IDENTITY_KEY).name).toBe('Katra');
    expect(store.has(agentIdentityKey('katra'))).toBe(false);

    const identity = await getAgentIdentity();
    expect(identity.name).toBe('Katra');
  });

  it('setAgentIdentity(userId) without a record throws', async () => {
    await expect(setAgentIdentity('agent-a' as any)).rejects.toThrow(/record is required/i);
  });

  it('rejects an empty identity name', async () => {
    await expect(setAgentIdentity('agent-a', { ...AGENT_A_RECORD, name: '   ' })).rejects.toThrow(/must not be empty/i);
  });
});
