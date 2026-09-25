/**
 * MCP tool-surface documentation consistency.
 *
 * Guarded failure (the verifier's finding on ITER-2): `tools/list` returned 81
 * tools with every flag off while `README.md` and `docs/MCP-TOOLS.md` both said
 * 67 — a 15-tool gap that hid the `vault_*`/`auth_*` families. Nothing failed,
 * because the only existing "check" compared the two documents to each other.
 *
 * So this suite never trusts a written-down number: it loads
 * `server/src/mcp-server.ts` per flag state, counts what is actually
 * registered, and requires every number the docs state to equal a measurement.
 * Add a tool without updating the docs (or change the docs without changing the
 * code) and this suite fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => null,
  is_database_connected: () => false,
  connect_to_mongodb: async () => {},
  close_connection: async () => {},
}));

vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
  is_redis_healthy: async () => false,
  close_redis_connection: async () => {},
  get_redis_status: () => ({ connected: false }),
}));

const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
const MCP_TOOLS = readFileSync(new URL('../../../docs/MCP-TOOLS.md', import.meta.url), 'utf8');

/**
 * ITER-4: the same drift showed up in four more files, so they are policed
 * here too — every tool-count mention must equal the measured default surface,
 * and the mention must still be present (deleting one fails the count check).
 * `expected` is how many mentions that shape has today.
 */
const SWEPT_TOOL_COUNTS: Array<{
  file: string;
  label: string;
  pattern: RegExp;
  expected: number;
}> = [
  { file: 'docs/ARCHITECTURE.md', label: '**N registered tools**', pattern: /\*\*(\d+) registered tools\*\*/g, expected: 2 },
  { file: 'docs/ARCHITECTURE.md', label: '### MCP Tools (N,', pattern: /MCP Tools \((\d+),/g, expected: 1 },
  { file: 'docs/ARCHITECTURE.md', label: '(N tools,', pattern: /\((\d+) tools,/g, expected: 1 },
  { file: 'docs/ARCHITECTURE.md', label: '(N tools)', pattern: /\((\d+) tools\)/g, expected: 1 },
  { file: 'docs/Data-Processing-Pipelines.md', label: 'N MCP tools', pattern: /(\d+) MCP tools/g, expected: 1 },
  { file: 'sdks/python/README.md', label: 'registers N MCP tools', pattern: /registers (\d+) MCP tools/g, expected: 1 },
  { file: 'sdks/typescript/README.md', label: 'registers N MCP tools', pattern: /registers (\d+) MCP tools/g, expected: 1 },
];

/** The pre-fix totals, in every shape the swept documents used to state them. */
const STALE_TOOL_COUNTS = [
  '66 registered tools',
  '67 registered tools',
  '66 tools',
  '67 tools',
  '66 MCP tools',
  '67 MCP tools',
  'MCP Tools (66',
  'MCP Tools (67',
  '(66 tools)',
  '(67 tools)',
];

function sweptDocument(file: string): string {
  return readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
}

/** Every environment flag that shapes the registered surface. */
const SURFACE_FLAGS = [
  'PER_IDENTITY_PERSONALITY',
  'COGNITIVE_CONTROL_ENABLED',
  'COGNITIVE_SCHEDULER_MODE',
  'COGNITIVE_ACTIVATION_KILL_SWITCH',
  // ITER-5: focused consolidation + the private Salience Trace.
  'FOCUSED_IMAGINATION',
  // ITER-7: the Creative Baton promotion capability. It is a SECOND flag that
  // only adds anything while FOCUSED_IMAGINATION is on, so the surface must be
  // measured with it on its own as well as together with the family flag.
  'CREATIVE_BATON_PROMOTION',
];

/** The registered tool names for one flag state (module re-loaded each time). */
async function registeredSurface(env: Record<string, string> = {}): Promise<string[]> {
  vi.resetModules();
  for (const key of SURFACE_FLAGS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const mod = await import('../../src/mcp-server.js');
  return mod.registeredToolNames();
}

/** `### tool_name` catalogue headings in docs/MCP-TOOLS.md. */
function cataloguedTools(): string[] {
  return (MCP_TOOLS.match(/^### ([a-z0-9_]+)/gm) ?? []).map((line) => line.slice(4));
}

/** The tool total stated in the header sentence: `exposes **81 tools**`. */
function declaredHeaderTotal(): number | null {
  const match = MCP_TOOLS.match(/exposes \*\*(\d+) tools\*\*/);
  return match ? Number(match[1]) : null;
}

/** Every tool-number mention in README.md (the four public-facing shapes). */
function readmeTotals(): number[] {
  const mentions = README.match(
    /\*\*\d+\*\* specialized tools|\(\d+ tools\)|\*\*\d+ MCP tools\*\*|all \d+ tools/g,
  ) ?? [];
  return mentions.map((mention) => Number(mention.match(/\d+/)![0]));
}

/** The family table rows: `| **Katra Vault** (`vault_*`) … | 11 | names |`. */
function documentedFamilies(): Array<{ prefix: string; stated: number }> {
  const families: Array<{ prefix: string; stated: number }> = [];
  for (const line of MCP_TOOLS.split('\n')) {
    const match = line.match(/^\| \*\*[^*]+\*\* \(`(\w+)_\*`\)[^|]*\| (\d+) \|/);
    if (match) families.push({ prefix: match[1], stated: Number(match[2]) });
  }
  return families;
}

/** The flag table rows: flags label, stated total, and stated delta. */
function documentedFlagRows(): Array<{ flags: string; total: number | null; added: string }> {
  const rows: Array<{ flags: string; total: number | null; added: string }> = [];
  for (const line of MCP_TOOLS.split('\n')) {
    // A flag row is any table row whose second cell is a bolded number (or
    // numbers joined by `/`); the family rows carry a plain number there.
    const match = line.match(/^\| ([^|]+) \| \*\*([\d /]+)\*\* \| ([^|]*) \|$/);
    if (!match) continue;
    const numbers = match[2].split('/').map((n) => Number(n.trim()));
    rows.push({ flags: match[1].trim(), total: numbers[numbers.length - 1], added: match[3].trim() });
  }
  return rows;
}

const flagRow = (flags: string) => {
  const row = documentedFlagRows().find((r) => r.flags === flags);
  expect(row, `docs/MCP-TOOLS.md has no flag-table row for ${flags}`).toBeTruthy();
  return row!;
};

beforeEach(() => {
  for (const key of SURFACE_FLAGS) delete process.env[key];
});

afterEach(() => {
  for (const key of SURFACE_FLAGS) delete process.env[key];
});

describe('MCP surface — the docs state the measured default count', () => {
  it('README.md and docs/MCP-TOOLS.md agree with `tools/list`, flags off', async () => {
    const defaultSurface = await registeredSurface();

    // docs/MCP-TOOLS.md: the header sentence and the "all off" table row.
    expect(declaredHeaderTotal()).toBe(defaultSurface.length);
    expect(flagRow('all off (**default**)').total).toBe(defaultSurface.length);
    expect(flagRow('all off (**default**)').added).toBe('—');

    // README.md: every mention states the same, measured, number.
    const totals = readmeTotals();
    expect(totals).toHaveLength(4); // the four public mentions still exist
    for (const total of totals) expect(total).toBe(defaultSurface.length);

    // No stale pre-fix number survives anywhere.
    for (const stale of ['66 tools', '67 tools', '66 MCP tools', '67 MCP tools']) {
      expect(README, `README.md still claims ${stale}`).not.toContain(stale);
      expect(MCP_TOOLS, `docs/MCP-TOOLS.md still claims ${stale}`).not.toContain(stale);
    }
    expect(README).not.toMatch(/\*\*6[67]\*\* specialized tools/);
  });

  it('the 15-tool gap is documented, not invisible: vault_* and auth_* families', async () => {
    const defaultSurface = await registeredSurface();
    const catalogued = cataloguedTools();

    // The two families the catalogue does not list entry-by-entry.
    const families = documentedFamilies();
    expect(families.map((f) => f.prefix).sort()).toEqual(['auth', 'vault']);
    for (const family of families) {
      const measured = defaultSurface.filter((name) => name.startsWith(`${family.prefix}_`));
      expect(family.stated, `${family.prefix}_* family count`).toBe(measured.length);
      expect(measured.length).toBeGreaterThan(0);
    }

    // Arithmetic that used to be wrong: catalogued-by-default + families = total.
    const cataloguedByDefault = catalogued.filter(
      (name) => name !== 'get_my_personality' && defaultSurface.includes(name),
    );
    const familyTools = defaultSurface.filter(
      (name) => name.startsWith('vault_') || name.startsWith('auth_'),
    );
    expect(cataloguedByDefault.length + familyTools.length).toBe(defaultSurface.length);
    expect(MCP_TOOLS).toContain(`**${cataloguedByDefault.length} catalogued tools**`);
  });

  it('every registered tool is documented somewhere in docs/MCP-TOOLS.md', async () => {
    // ITER-5: the surface now has two independent flag-gated families, so the
    // coverage check runs over the UNION of the catalogued flag states rather
    // than one of them — a tool that is reachable in ANY documented state must
    // be documented, and nothing may be catalogued that no state registers.
    //
    // The states are measured SEQUENTIALLY (ITER-7): `registeredSurface` sets
    // the environment and re-imports, so running the states concurrently lets a
    // later state's env be visible to an earlier state's module evaluation —
    // which is exactly how a two-flag state can silently measure as a one-flag
    // state and report a registered tool as missing.
    const states: string[][] = [];
    for (const env of [
      { PER_IDENTITY_PERSONALITY: '1' },
      { FOCUSED_IMAGINATION: '1' },
      { FOCUSED_IMAGINATION: '1', CREATIVE_BATON_PROMOTION: '1' },
      { PER_IDENTITY_PERSONALITY: '1', FOCUSED_IMAGINATION: '1', CREATIVE_BATON_PROMOTION: '1' },
    ]) {
      states.push(await registeredSurface(env));
    }
    // …which, since ITER-7, is the surface of ten flag-gated tools: one
    // personality tool, the ITER-5 salience pair, the ITER-6 imagination pair,
    // the four ITER-7 cycle/baton/adapter/outcome tools and — only with the
    // promotion flag too — `promote_creative_baton`.
    const surface = [...new Set(states.flat())];
    const catalogued = cataloguedTools();

    const invisible = surface.filter(
      (name) => !catalogued.includes(name) && !MCP_TOOLS.includes(`\`${name}\``),
    );
    expect(invisible, 'registered but undocumented').toEqual([]);

    // …and nothing is documented that is not registered in some flag state.
    const registered = new Set(surface);
    for (const name of catalogued) {
      expect(registered, `${name} is catalogued but not registered`).toContain(name);
    }
  });
});

describe('MCP surface — the docs state the measured flag-gated additions', () => {
  it('PER_IDENTITY_PERSONALITY adds exactly the catalogued get_my_personality', async () => {
    const withoutFlag = await registeredSurface();
    const withFlag = await registeredSurface({ PER_IDENTITY_PERSONALITY: '1' });

    expect(withFlag.length - withoutFlag.length).toBe(1);
    expect(withFlag.filter((name) => !withoutFlag.includes(name))).toEqual(['get_my_personality']);
    expect(flagRow('`PER_IDENTITY_PERSONALITY=1`').total).toBe(withFlag.length);
    expect(flagRow('`PER_IDENTITY_PERSONALITY=1`').added).toBe('+1 — `get_my_personality` (catalogued below)');
  });

  it('the cognitive-control rows state the measured 106 and 119 totals', async () => {
    const defaultCount = (await registeredSurface()).length;
    const read = await registeredSurface({ COGNITIVE_CONTROL_ENABLED: 'read' });
    const write = await registeredSurface({ COGNITIVE_CONTROL_ENABLED: 'write' });
    const scheduled = await registeredSurface({
      COGNITIVE_CONTROL_ENABLED: 'read',
      COGNITIVE_SCHEDULER_MODE: 'shadow',
    });
    const scheduledAlt = await registeredSurface({
      COGNITIVE_CONTROL_ENABLED: 'read',
      COGNITIVE_SCHEDULER_MODE: 'allocate_internal',
    });

    // read and write expose the same tools; any scheduler mode adds the same 13.
    expect(write.length).toBe(read.length);
    expect(scheduledAlt.length).toBe(scheduled.length);

    expect(flagRow('`COGNITIVE_CONTROL_ENABLED=read` or `write`').total).toBe(read.length);
    expect(flagRow('`COGNITIVE_CONTROL_ENABLED=read` or `write`').added).toMatch(
      new RegExp(`^\\+${read.length - defaultCount}\\b`),
    );
    const schedulerRow = flagRow(
      '`COGNITIVE_SCHEDULER_MODE=shadow` or `recommend` or `allocate_internal` (with the row above)',
    );
    expect(schedulerRow.total).toBe(scheduled.length);
    expect(schedulerRow.added).toMatch(new RegExp(`^\\+${scheduled.length - read.length}\\b`));

    // The combined row: personality + each cognitive-control total.
    const combined = await registeredSurface({
      PER_IDENTITY_PERSONALITY: '1',
      COGNITIVE_CONTROL_ENABLED: 'read',
    });
    const combinedScheduled = await registeredSurface({
      PER_IDENTITY_PERSONALITY: '1',
      COGNITIVE_CONTROL_ENABLED: 'read',
      COGNITIVE_SCHEDULER_MODE: 'shadow',
    });
    expect(combined.length).toBe(read.length + 1);
    expect(combinedScheduled.length).toBe(scheduled.length + 1);
    expect(
      flagRow('`PER_IDENTITY_PERSONALITY=1` with a cognitive-control row').total,
    ).toBe(combinedScheduled.length);
    const personalityOnly = (await registeredSurface({ PER_IDENTITY_PERSONALITY: '1' })).length;
    expect(MCP_TOOLS).toContain(
      `**${personalityOnly} / ${combined.length} / ${combinedScheduled.length}**`,
    );
    // The kill switch removes the scheduler-only tools again.
    const killed = await registeredSurface({
      COGNITIVE_CONTROL_ENABLED: 'read',
      COGNITIVE_SCHEDULER_MODE: 'shadow',
      COGNITIVE_ACTIVATION_KILL_SWITCH: '1',
    });
    expect(killed.length).toBe(read.length);
  });

  it('FOCUSED_IMAGINATION adds exactly the eight catalogued tools it owns', async () => {
    // ITER-6 added the imagination pair behind the SAME flag and ITER-7 added
    // four more (the cycle, the baton read, the adapter and the outcome), so
    // this row now measures all eight: the flag-gated family is what the docs
    // describe, and a ninth tool appearing behind this flag without a docs
    // change fails here.
    const withoutFlag = await registeredSurface();
    const withFlag = await registeredSurface({ FOCUSED_IMAGINATION: '1' });
    const added = withFlag.filter((name) => !withoutFlag.includes(name));

    expect(withFlag.length - withoutFlag.length).toBe(8);
    expect(added.sort()).toEqual([
      'baton_candidates_to_work_items',
      'generate_imagination_seeds',
      'get_creative_baton',
      'get_idea_archive',
      'get_salience_trace',
      'record_candidate_outcome',
      'run_focused_consolidation',
      'run_imagination_cycle',
    ]);
    for (const name of added) expect(withoutFlag).not.toContain(name);

    expect(flagRow('`FOCUSED_IMAGINATION=1`').total).toBe(withFlag.length);
    expect(flagRow('`FOCUSED_IMAGINATION=1`').added).toMatch(
      new RegExp(`^\\+${withFlag.length - withoutFlag.length}\\b`),
    );

    // ITER-7: promotion needs a SECOND flag, and that flag on its own exposes
    // nothing at all — the capability is meaningless without the family.
    const promotionAlone = await registeredSurface({ CREATIVE_BATON_PROMOTION: '1' });
    const withPromotion = await registeredSurface({
      FOCUSED_IMAGINATION: '1',
      CREATIVE_BATON_PROMOTION: '1',
    });
    expect(promotionAlone.length).toBe(withoutFlag.length);
    expect(withPromotion.length - withFlag.length).toBe(1);
    expect(withPromotion.filter((name) => !withFlag.includes(name))).toEqual(['promote_creative_baton']);
    expect(flagRow('`FOCUSED_IMAGINATION=1` + `CREATIVE_BATON_PROMOTION=1`').total).toBe(withPromotion.length);
    expect(flagRow('`FOCUSED_IMAGINATION=1` + `CREATIVE_BATON_PROMOTION=1`').added).toMatch(
      new RegExp(`^\\+${withPromotion.length - withFlag.length}\\b`),
    );

    // Independent of every other row: it adds the same tools in combination, and
    // every total the prose states is the measured one.
    const combined = await registeredSurface({
      PER_IDENTITY_PERSONALITY: '1',
      FOCUSED_IMAGINATION: '1',
    });
    const combinedPromoted = await registeredSurface({
      PER_IDENTITY_PERSONALITY: '1',
      FOCUSED_IMAGINATION: '1',
      CREATIVE_BATON_PROMOTION: '1',
    });
    const withCognitive = await registeredSurface({
      COGNITIVE_CONTROL_ENABLED: 'read',
      FOCUSED_IMAGINATION: '1',
      CREATIVE_BATON_PROMOTION: '1',
    });
    const withScheduler = await registeredSurface({
      COGNITIVE_CONTROL_ENABLED: 'read',
      COGNITIVE_SCHEDULER_MODE: 'shadow',
      FOCUSED_IMAGINATION: '1',
      CREATIVE_BATON_PROMOTION: '1',
    });
    const all = await registeredSurface({
      COGNITIVE_CONTROL_ENABLED: 'read',
      COGNITIVE_SCHEDULER_MODE: 'shadow',
      PER_IDENTITY_PERSONALITY: '1',
      FOCUSED_IMAGINATION: '1',
      CREATIVE_BATON_PROMOTION: '1',
    });
    expect(combined.length).toBe(withoutFlag.length + 9);
    expect(combinedPromoted.length).toBe(combined.length + 1);
    expect(withCognitive.length).toBe(withPromotion.length + 25);
    expect(withScheduler.length).toBe(withPromotion.length + 38);
    expect(all.length).toBe(withScheduler.length + 1);
    for (const total of [
      withFlag.length,
      withPromotion.length,
      combined.length,
      combinedPromoted.length,
      withCognitive.length,
      withScheduler.length,
      all.length,
    ]) {
      expect(MCP_TOOLS).toContain(`**${total}**`);
    }
    // The baton row the docs state must be the measured pair.
    expect(MCP_TOOLS).toContain(`**${withFlag.length} / ${withPromotion.length}**`);
  });
});

describe('MCP surface — the swept documents state the measured default count', () => {
  it('every tool-count mention in the swept files equals the measured surface', async () => {
    const defaultSurface = await registeredSurface();

    for (const entry of SWEPT_TOOL_COUNTS) {
      const text = sweptDocument(entry.file);
      const stated = [...text.matchAll(entry.pattern)].map((match) => Number(match[1]));

      // The mention must still be there (deleting it is drift too) …
      expect(stated, `${entry.file} — ${entry.label} mentions`).toHaveLength(entry.expected);
      // … and it must state what the code actually registers.
      for (const value of stated) {
        expect(value, `${entry.file} — ${entry.label}`).toBe(defaultSurface.length);
      }
    }
  });

  it('no swept document still states a pre-fix total', () => {
    for (const entry of SWEPT_TOOL_COUNTS) {
      const text = sweptDocument(entry.file);
      for (const stale of STALE_TOOL_COUNTS) {
        expect(text, `${entry.file} still claims "${stale}"`).not.toContain(stale);
      }
    }
  });

  it('the two identity-scoped tools are documented as caller-pinned, not entity-keyed', () => {
    // ITER-4 made `user_id` meaningful for both readers; the catalogue used to
    // say beliefs were entity-keyed and that the templates tool took no
    // arguments. Either line coming back is drift.
    expect(MCP_TOOLS).not.toContain('currently unused');
    expect(MCP_TOOLS).not.toContain('beliefs are entity-keyed');

    for (const tool of ['get_agent_beliefs', 'get_procedural_templates']) {
      const start = MCP_TOOLS.indexOf(`### ${tool}`);
      expect(start, `${tool} should be catalogued`).toBeGreaterThan(-1);
      const entry = MCP_TOOLS.slice(start, MCP_TOOLS.indexOf('###', start + 4));
      expect(entry, `${tool} must document its user_id parameter`).toContain(
        '| user_id | string | No (caller-bound for untrusted callers) |',
      );
    }
  });
});
