/**
 * Unit tests: per-user agent identity records (F3)
 *
 * getAgentIdentity(userId) reads system_settings key `agent_identity:<user_id>`;
 * when that record is missing it returns an unnamed DEFAULT identity named
 * after the user_id — never the legacy `agent_identity` record (satori's).
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
  name: 'Satori',
  chosen_by: 'the agent',
  established: '2026-08-19',
};

const SHOSHIN_RECORD: AgentIdentity = {
  name: 'Shoshin',
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

  it('no-arg getAgentIdentity keeps the legacy-record behavior (satori)', async () => {
    store.set(LEGACY_IDENTITY_KEY, LEGACY_RECORD);
    const identity = await getAgentIdentity();
    expect(identity.name).toBe('Satori');
    expect(identity.established).toBe('2026-08-19');
  });

  it("getAgentIdentity('satori') returns an unnamed default identity when no per-user record exists (never the legacy record)", async () => {
    store.set(LEGACY_IDENTITY_KEY, LEGACY_RECORD);
    const identity = await getAgentIdentity('satori');
    expect(identity.name).toBe('satori');
    expect(identity.name).not.toBe('Satori');
    expect(identity.is_default).toBe(true);
    expect(identity.chosen_by).toBe('default (unnamed)');
    expect(identity.user_id).toBe('satori');
  });

  it("getAgentIdentity('satori') prefers agent_identity:satori over the legacy record", async () => {
    store.set(LEGACY_IDENTITY_KEY, LEGACY_RECORD);
    store.set(agentIdentityKey('satori'), { ...LEGACY_RECORD, name: 'Satori v2', established: '2026-08-21' });
    const identity = await getAgentIdentity('satori');
    expect(identity.name).toBe('Satori v2');
    expect(identity.established).toBe('2026-08-21');
  });

  it("getAgentIdentity('shoshin') returns the agent_identity:shoshin record", async () => {
    store.set(LEGACY_IDENTITY_KEY, LEGACY_RECORD);
    store.set(agentIdentityKey('shoshin'), SHOSHIN_RECORD);
    const identity = await getAgentIdentity('shoshin');
    expect(identity.name).toBe('Shoshin');
    expect(identity.established).toBe('2026-08-21');
  });

  it("getAgentIdentity('zanshin') returns an unnamed default identity when its own record is missing (never satori's)", async () => {
    store.set(LEGACY_IDENTITY_KEY, LEGACY_RECORD);
    const identity = await getAgentIdentity('zanshin');
    expect(identity.name).toBe('zanshin');
    expect(identity.name).not.toBe('Satori');
    expect(identity.is_default).toBe(true);
    expect(identity.chosen_by).toBe('default (unnamed)');
  });

  it("setAgentIdentity('shoshin', record) writes under agent_identity:shoshin", async () => {
    await setAgentIdentity('shoshin', SHOSHIN_RECORD);
    expect(store.has(agentIdentityKey('shoshin'))).toBe(true);
    expect(store.get(agentIdentityKey('shoshin')).name).toBe('Shoshin');
    expect(store.has(LEGACY_IDENTITY_KEY)).toBe(false);

    const identity = await getAgentIdentity('shoshin');
    expect(identity.name).toBe('Shoshin');
  });

  it('one-arg setAgentIdentity keeps the existing legacy-record behavior (satori)', async () => {
    await setAgentIdentity(LEGACY_RECORD);
    expect(store.has(LEGACY_IDENTITY_KEY)).toBe(true);
    expect(store.get(LEGACY_IDENTITY_KEY).name).toBe('Satori');
    expect(store.has(agentIdentityKey('satori'))).toBe(false);

    const identity = await getAgentIdentity();
    expect(identity.name).toBe('Satori');
  });

  it('setAgentIdentity(userId) without a record throws', async () => {
    await expect(setAgentIdentity('shoshin' as any)).rejects.toThrow(/record is required/i);
  });

  it('rejects an empty identity name', async () => {
    await expect(setAgentIdentity('shoshin', { ...SHOSHIN_RECORD, name: '   ' })).rejects.toThrow(/must not be empty/i);
  });
});
