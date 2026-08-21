/**
 * Regression guard: read/write tools must pin untrusted callers to their own
 * identity.
 *
 * The 2026-08-21 docs review found 14+ MCP tools (vector_search,
 * temporal_recall/search, get_journal, missions, transaction log, …) that
 * passed the raw `input.user_id` straight into `buildScopeFilter` or into
 * identity-scoped services. An untrusted caller (e.g. shoshin's client key)
 * could therefore read another identity's private journals, events, missions
 * and transaction logs — or trigger reflection consolidation under another
 * identity — simply by supplying `user_id`.
 *
 * The handlers live in mcp-server.ts without exports, so these are
 * source-level guards: they assert the wiring (every raw consumption site is
 * wrapped in resolveUserId). The resolution semantics themselves are covered
 * in resolve-user-id.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../src/mcp-server.ts'),
  'utf8',
);

/** Handlers that consume user_id for identity-scoped reads or writes. */
const SCOPED_HANDLERS = [
  'handleVectorSearch',
  'handleTemporalRecall',
  'handleTemporalSearch',
  'handleTimeBlockSummaries',
  'handleSummarizeTimeBlocks',
  'handleDetectPatterns',
  'handleGetJournal',
  'handleListMissions',
  'handleGetMission',
  'handleCreateMission',
  'handleUpdateMissionTask',
  'handleGetMemoryDiagnostics',
  'handleGetAutoJournal',
  'handleGetTransactionLog',
  'handleListAssets',
  'handleTriggerReflection',
];

describe('read/write tools — caller pinning regression guard', () => {
  it('never passes raw input.user_id into buildScopeFilter', () => {
    const raw = src.match(/buildScopeFilter\(input\.user_id\)/g) ?? [];
    expect(raw).toEqual([]);
  });

  it('never passes raw input.user_id into identity-scoped services', () => {
    expect(src).not.toMatch(/createMission\(input\.user_id/);
    expect(src).not.toMatch(/consolidate\(input\.period_type, input\.user_id\)/);
    expect(src).not.toMatch(/getTimeBlockSummaries\(input\.user_id/);
    expect(src).not.toMatch(/user_id: input\.user_id,\s*\n\s*limit/);
  });

  it('every scoped handler resolves the caller before consuming user_id', () => {
    for (const name of SCOPED_HANDLERS) {
      const start = src.indexOf(name);
      expect(start, `${name} should exist in mcp-server.ts`).toBeGreaterThan(-1);
      const body = src.slice(start, start + 5000);
      expect(
        body,
        `${name} must pin its user_id via resolveUserId(input.user_id)`,
      ).toContain('resolveUserId(input.user_id)');
    }
  });

  it('no output label interpolates the raw input user_id', () => {
    expect(src).not.toMatch(/\$\{input\.user_id\}/);
  });

  it('the transaction log no longer falls back to an unscoped query', () => {
    const start = src.indexOf('handleGetTransactionLog');
    const body = src.slice(start, start + 1500);
    expect(body).not.toMatch(/input\.user_id \? await buildScopeFilter/);
    expect(body).toContain('resolveUserId(input.user_id)');
  });
});
