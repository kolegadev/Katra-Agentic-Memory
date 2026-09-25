/**
 * ITER-2 — `get_my_personality` MCP tool.
 * Contract: CONTRACT-iter2-per-identity-personality.md
 *
 * Three layers, matching this repo's conventions for MCP tools:
 *
 *   1. registration — the real `tools` array is inspected after loading
 *      mcp-server.ts twice, once per flag state (the flag is read at module
 *      load), proving the tool exists only when
 *      `PER_IDENTITY_PERSONALITY` is on;
 *   2. dispatch-time re-check — with the flag off the handler (the dispatch
 *      target) throws `Unknown tool` and touches nothing;
 *   3. caller pinning — handlers run through runWithCaller(), the same way the
 *      transport runs every tool call, so an untrusted caller passing another
 *      identity's user_id still reads its OWN configuration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB.asDb(),
  is_database_connected: () => true,
  connect_to_mongodb: async () => {},
  close_connection: async () => {},
}));

vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
  is_redis_healthy: async () => false,
  close_redis_connection: async () => {},
  get_redis_status: () => ({ connected: false }),
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import { handleGetMyPersonality } from '../../src/mcp-server.js';
import { runWithCaller } from '../../src/utils/caller-identity.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';
import { AGENT_MESSAGE_WEIGHT } from '../../src/services/integration/personality-profiles.js';

const FAKE_DB = new FakeDb();
const settings = () => FAKE_DB.collection('system_settings');
const personalityDocs = () => settings().docs.filter((d) => String(d.key).startsWith('personality_config'));

const MCP_SERVER_SOURCE = readFileSync(new URL('../../src/mcp-server.ts', import.meta.url), 'utf8');

const trustedA: CallerIdentity = { user_id: 'agent-a', trusted: true };
const untrustedA: CallerIdentity = { user_id: 'agent-a', trusted: false };
const untrustedB: CallerIdentity = { user_id: 'agent-b', trusted: false };
const TRUSTED_OPERATOR: CallerIdentity = { user_id: 'operator', trusted: true };

const LEGACY_DOC = {
  key: 'personality_config',
  personality: 'scholar',
  source_weights: { vector_search: 7 },
  scoring: { relevance_multiplier: 3 },
  max_context_tokens: 8000,
  updated_at: '2026-09-01T00:00:00.000Z',
};
const IDENTITY_A_DOC = {
  key: 'personality_config:agent-a',
  personality: 'dreamer',
  source_weights: { working_memory: 2, agent_message: 0.5 },
  scoring: {},
  max_context_tokens: 4000,
  origin: 'identity',
  version: 3,
  updated_at: '2026-09-10T10:00:00.000Z',
};

/** Parse the tool's JSON text payload. */
async function callTool(args: unknown, caller: CallerIdentity): Promise<any> {
  const result = await runWithCaller(caller, () => handleGetMyPersonality(args));
  expect(result).toHaveLength(1);
  expect(result[0].type).toBe('text');
  return JSON.parse(result[0].text);
}

/** Load mcp-server.ts under a given flag state (the flag is read at load). */
async function registeredNamesWithFlag(
  value: string | undefined,
  extraFlags: Record<string, string> = {},
): Promise<string[]> {
  vi.resetModules();
  if (value === undefined) delete process.env.PER_IDENTITY_PERSONALITY;
  else process.env.PER_IDENTITY_PERSONALITY = value;
  delete process.env.FOCUSED_IMAGINATION;
  for (const [key, flagValue] of Object.entries(extraFlags)) process.env[key] = flagValue;
  const mod = await import('../../src/mcp-server.js');
  return mod.registeredToolNames();
}

beforeEach(() => {
  FAKE_DB.reset();
  delete process.env.PER_IDENTITY_PERSONALITY;
  // ITER-5: the focused-consolidation tools are a separate flag-gated family;
  // keep it off unless a test asks for it.
  delete process.env.FOCUSED_IMAGINATION;
});

afterEach(() => {
  FAKE_DB.reset();
  delete process.env.PER_IDENTITY_PERSONALITY;
  delete process.env.FOCUSED_IMAGINATION;
});

describe('get_my_personality — registration is gated by the flag', () => {
  it('is registered when PER_IDENTITY_PERSONALITY is on, and absent when it is off', async () => {
    const withoutFlag = await registeredNamesWithFlag(undefined);
    const withFlag = await registeredNamesWithFlag('1');

    expect(withoutFlag).not.toContain('get_my_personality');
    expect(withFlag).toContain('get_my_personality');
    // Exactly one tool more than the flag-off surface.
    expect(withFlag.length).toBe(withoutFlag.length + 1);
    expect(withFlag.filter((n) => n === 'get_my_personality')).toHaveLength(1);
    // `true`/`yes` are the other truthy spellings.
    const withTrue = await registeredNamesWithFlag('true');
    expect(withTrue).toContain('get_my_personality');
  });

  it('the tool is wired into the dispatch switch and declares the flag gate', () => {
    expect(MCP_SERVER_SOURCE).toMatch(/case 'get_my_personality': result = await handleGetMyPersonality\(args\); break;/);
    expect(MCP_SERVER_SOURCE).toMatch(
      /if \(perIdentityPersonalityEnabled\(\)\) \{\s*tools\.push\(\{\s*name: 'get_my_personality',/,
    );
    expect(MCP_SERVER_SOURCE).toMatch(/throw new Error\('Unknown tool: get_my_personality'\)/);
  });

  it('the documented catalogue matches the registered surface', async () => {
    // ITER-5 added a second flag-gated catalogue family (`FOCUSED_IMAGINATION`),
    // so every catalogue entry must be registered in SOME documented flag state
    // — this checks the two the docs name, together and apart.
    const states = await Promise.all([
      registeredNamesWithFlag('1'),
      registeredNamesWithFlag(undefined, { FOCUSED_IMAGINATION: '1' }),
      registeredNamesWithFlag('1', { FOCUSED_IMAGINATION: '1' }),
    ]);
    const registered = [...new Set(states.flat())];
    const catalogue = readFileSync(new URL('../../../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    const documented = (catalogue.match(/^### ([a-z0-9_]+)/gm) ?? []).map((line) => line.replace('### ', ''));

    expect(documented).toContain('get_my_personality');
    expect(documented).toContain('run_focused_consolidation');
    expect(documented).toContain('get_salience_trace');
    // ITER-6 added the imagination pair behind the same flag; each has its own
    // catalogue entry, so nothing on that surface is invisible either.
    expect(documented).toContain('generate_imagination_seeds');
    expect(documented).toContain('get_idea_archive');
    // Every documented tool really is registered…
    for (const name of documented) {
      expect(registered, `${name} is documented but not registered`).toContain(name);
    }
    // …and the only tools without their own catalogue entry are the vault/auth
    // family — each of which the "Registered surface" section names explicitly
    // (by tool and by family count), so nothing on the surface is invisible.
    const withoutEntry = registered.filter((name) => !documented.includes(name));
    expect(withoutEntry.length).toBeGreaterThan(0);
    for (const name of withoutEntry) {
      expect(name.startsWith('vault_') || name.startsWith('auth_'), `${name} needs a catalogue entry`).toBe(true);
      expect(catalogue, `${name} is neither catalogued nor named in the family table`).toContain(`\`${name}\``);
    }
  });
});

describe('get_my_personality — flag off is indistinguishable from not existing', () => {
  it('throws Unknown tool and reads nothing', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC), structuredClone(IDENTITY_A_DOC));
    const before = structuredClone(settings().docs);
    const findSpy = vi.spyOn(settings(), 'findOne');

    await expect(callTool({}, trustedA)).rejects.toThrow('Unknown tool: get_my_personality');

    expect(findSpy).not.toHaveBeenCalled();
    expect(settings().docs).toEqual(before);
  });
});

describe('get_my_personality — resolved payload', () => {
  beforeEach(() => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
  });

  it('returns the caller’s own record with effective weights, version and origin', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC), structuredClone(IDENTITY_A_DOC));

    const payload = await callTool({}, untrustedA);

    expect(payload.user_id).toBe('agent-a');
    expect(payload.profile).toBe('dreamer');
    expect(payload.origin).toBe('identity');
    expect(payload.version).toBe(3);
    expect(payload.updated_at).toBe('2026-09-10T10:00:00.000Z');
    expect(payload.max_context_tokens).toBe(4000);
    expect(payload.max_context_tokens_source).toBe('record');
    // Effective weights: stored overrides merged over profile defaults.
    expect(payload.source_weights.working_memory).toBe(2);
    expect(payload.source_weights.missions).toBeGreaterThan(0);
    // The agent-message invariant survives a stored attempt to weaken it.
    expect(payload.source_weights.agent_message).toBe(AGENT_MESSAGE_WEIGHT);
    // Thinking modes are Phase 6.
    expect(payload.active_mode).toBeNull();
    expect(payload.active_mode_note).toContain('Phase 6');
  });

  it('reports origin legacy when the identity has no record, with the profile budget', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC));

    const payload = await callTool({}, untrustedB);

    expect(payload.user_id).toBe('agent-b');
    expect(payload.origin).toBe('legacy');
    expect(payload.version).toBe(0);
    expect(payload.profile).toBe('scholar');
    expect(payload.source_weights.vector_search).toBe(7);
    expect(personalityDocs().some((d) => d.key === 'personality_config:agent-b')).toBe(false);
  });

  it('reports origin default when nothing is saved anywhere', async () => {
    const payload = await callTool({}, untrustedB);

    expect(payload.origin).toBe('default');
    expect(payload.version).toBe(0);
    expect(payload.profile).toBe('balanced');
    expect(payload.max_context_tokens_source).toBe('profile-default');
    expect(payload.updated_at).toBeNull();
  });

  it('is read-only: no document is created by a call', async () => {
    const payload = await callTool({}, untrustedA);

    expect(payload.origin).toBe('default');
    expect(personalityDocs()).toHaveLength(0);
  });
});

describe('get_my_personality — caller pinning', () => {
  beforeEach(() => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
    settings().docs.push(structuredClone(LEGACY_DOC), structuredClone(IDENTITY_A_DOC));
  });

  it('an untrusted caller passing another user_id gets its own configuration', async () => {
    const payload = await callTool({ user_id: 'agent-b' }, untrustedA);

    expect(payload.user_id).toBe('agent-a');
    expect(payload.profile).toBe('dreamer');
    expect(JSON.stringify(payload)).not.toContain('scholar');
  });

  it('an untrusted caller cannot read another identity even when it names an unknown one', async () => {
    const payload = await callTool({ user_id: 'operator' }, untrustedB);

    expect(payload.user_id).toBe('agent-b');
    expect(payload.origin).toBe('legacy');
    expect(payload.profile).toBe('scholar');
    expect(payload.profile).not.toBe('dreamer');
  });

  it('a trusted caller may name an identity', async () => {
    const payload = await callTool({ user_id: 'agent-a' }, TRUSTED_OPERATOR);

    expect(payload.user_id).toBe('agent-a');
    expect(payload.profile).toBe('dreamer');
  });

  it('without a user_id argument the caller reads its own record', async () => {
    const payload = await callTool({}, untrustedB);

    expect(payload.user_id).toBe('agent-b');
    expect(payload.origin).toBe('legacy');
  });

  it('a supplied user_id never changes who is pinned for a trusted caller’s own read', async () => {
    const payload = await callTool({ user_id: 'agent-a' }, trustedA);

    expect(payload.user_id).toBe('agent-a');
    expect(payload.profile).toBe('dreamer');
  });
});
