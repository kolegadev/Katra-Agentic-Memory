/**
 * ITER-9 — the imagination dashboard renderers: escaping.
 * Contract: CONTRACT-iter9-observability.md §C/§F ("imagination-dashboard-escaping.test.ts
 * — style check ... execute them with hostile payloads, like ITER-2's escaping test").
 *
 * The functions are extracted VERBATIM from `dashboard/cognition/index.html` and
 * evaluated in an isolated scope with no DOM at all — they are pure string
 * builders, so a renderer that leaks markup fails here and one that escapes
 * cannot. Every view is fed a payload whose every field is the same hostile
 * string, valid both as an attribute value and as a tag.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const DASHBOARD = readFileSync(new URL('../../../dashboard/cognition/index.html', import.meta.url), 'utf8');

/** Valid inside an attribute or a tag: whichever slot it lands in, it fires. */
const XSS = '"><img src=x onerror=alert(1)>';
/** The second hostile shape: a closing script tag plus a bare tag. */
const XSS2 = '</script><svg onload=alert(2)>';

/**
 * Slice one function out of the dashboard source.
 *
 * A multi-line function ends at the first `\n}\n` after its declaration (the
 * house style puts the closing brace at column 0) — and a ONE-LINER (the page's
 * `esc` and `fmt`) ends at the `}` that closes its own declaration line. String
 * literals inside a one-liner (`esc` holds `/["&<>]/g` and `'&quot;'`) make brace
 * counting unreliable, so the line ending is the authority instead.
 */
function extractFunction(name: string): string {
  const asyncStart = DASHBOARD.indexOf(`async function ${name}(`);
  const start = asyncStart > -1 ? asyncStart : DASHBOARD.indexOf(`function ${name}(`);
  expect(start, `function ${name}() not found in dashboard/cognition/index.html`).toBeGreaterThan(-1);
  const declarationLineEnd = DASHBOARD.indexOf('\n', start);
  expect(declarationLineEnd, `${name}() is not terminated`).toBeGreaterThan(start);
  if (DASHBOARD[declarationLineEnd - 1] === '}') {
    return DASHBOARD.slice(start, declarationLineEnd);
  }
  const closing = DASHBOARD.indexOf('\n}\n', start);
  expect(closing, `end of function ${name}() not found`).toBeGreaterThan(start);
  return DASHBOARD.slice(start, closing + 2);
}

/** The ITER-9 block, for the source-level sweep at the bottom. */
const IMAGINATION_SECTION = (() => {
  const start = DASHBOARD.indexOf('// ═══════════ IMAGINATION (ITER-9) ═══════════');
  const end = DASHBOARD.indexOf('// boot', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return DASHBOARD.slice(start, end);
})();

const METRIC_KEYS = [
  ['useful_novelty_rate', 'Useful novelty rate'],
  ['archive_coverage_gain', 'Archive coverage gain'],
  ['idea_survival', 'Idea survival (proxy)'],
  ['time_to_next_viable_direction', 'Time to next viable direction'],
  ['false_novelty', 'False novelty'],
  ['agent_divergence', 'Agent divergence'],
  ['agent_divergence_same_mode_control', 'Agent divergence — same-mode control'],
  ['cost_of_novelty', 'Cost of novelty'],
];

interface Renderers {
  esc: (value: unknown) => string;
  fmt: (value: unknown) => string;
  imgViewHtml: (view: string, body: unknown) => string;
  imgTable: (rows: unknown, headers: unknown, cells: unknown) => string;
  imgKv: (pairs: unknown) => string;
  imgBasis: (text: unknown) => string;
  imgEmpty: (text: unknown) => string;
  imgTag: (text: unknown, cls?: unknown) => string;
  imgMetric: (label: unknown, metric: unknown) => string;
}

function buildRenderers(): Renderers {
  const body = [
    extractFunction('esc'),
    extractFunction('fmt'),
    extractFunction('imgKv'),
    extractFunction('imgTable'),
    extractFunction('imgBasis'),
    extractFunction('imgEmpty'),
    extractFunction('imgTag'),
    extractFunction('imgMetric'),
    extractFunction('imgPrivacy'),
    extractFunction('imgViewHtml'),
    'return { esc, fmt, imgViewHtml, imgTable, imgKv, imgBasis, imgEmpty, imgTag, imgMetric };',
  ].join('\n');
  return new Function('IMG_METRIC_KEYS', body)(METRIC_KEYS);
}

/** Every string in a payload is hostile; numbers stay numbers. */
function hostile(value: unknown): unknown {
  if (typeof value === 'string') return XSS;
  if (Array.isArray(value)) return value.map(hostile);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, hostile(inner)]));
  }
  return value;
}

/**
 * The real property: no LIVE markup, and the raw hostile string never appears.
 * (The escaped form still CONTAINS the letters `onerror=alert` — it is text a
 * browser renders verbatim — so the check is on the tag and on the raw payload,
 * not on the letters.)
 */
function expectEscaped(html: string, raw: string = XSS): void {
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<svg');
  expect(html).not.toContain('<script');
  expect(html, 'the raw hostile payload reached the output').not.toContain(raw);
  // The payload's `"` is neutralised too, so it cannot break out of an
  // attribute it was interpolated into.
  expect(html).not.toContain(raw.replace(/&/g, '&amp;'));
}

const PRIVACY = {
  scope: 'private',
  private_rows: 1,
  shared_rows: 0,
  raw_reflections_included: false,
  basis: XSS,
};

/** One hostile payload per view: the exact shape the route serves. */
const HOSTILE_PAYLOADS: Record<string, unknown> = {
  overview: {
    plane: 'on',
    identity: XSS,
    missions: [
      { user_id: XSS, mission_id: XSS, cycles: XSS, seeded_cycles: XSS, last_cycle_at: XSS, last_cycle_id: XSS, last_stop_reason: XSS, last_trigger: XSS, admitted_total: XSS, rejected_total: XSS, new_cells_total: XSS, cells_total: XSS, promoted: XSS, basis: XSS },
    ],
    counts: { cycles: XSS, missions: XSS, basis: XSS },
    reason: XSS,
    privacy: PRIVACY,
    basis: XSS,
  },
  cycles: {
    plane: 'on',
    identity: XSS,
    cycles: [
      { cycle_id: XSS, user_id: XSS, mission_id: XSS, mission_version: XSS, trigger: XSS, forced: XSS, status: XSS, stop_reason: XSS, counts: { seeds_admitted: XSS, seeds_rejected: XSS, new_cells: XSS }, novelty: XSS, baton_id: XSS, promoted: XSS, promotion_skipped: XSS, tokens_spent_this_cycle: XSS, created_at: XSS, completed_at: XSS, duration_ms: XSS, error: XSS },
    ],
    reason: XSS,
    privacy: PRIVACY,
    basis: XSS,
  },
  cycle: {
    plane: 'on',
    cycle: { cycle_id: XSS, user_id: XSS, mission_id: XSS, status: XSS, stop_reason: XSS, trigger: XSS, forced: XSS, duration_ms: XSS, baton_id: XSS, promoted: XSS },
    conditions: {
      plateau: [{ name: XSS, met: true, evidence: { note: XSS } }],
      stop: [{ name: XSS, met: true, evidence: { note: XSS2 } }],
      basis: XSS,
    },
    generated: { admitted: [{ seed_id: XSS, operator: XSS, cell_key: XSS, quality: XSS, novelty_score: XSS, coherence_score: XSS, testability_score: XSS, incumbent: XSS }], count: XSS },
    rejected: { rows: [{ seed_id: XSS, operator: XSS, reason: XSS, duplicate_of: XSS, at: XSS }], count: XSS },
    trace_summary: { evidence_counts: { total_refs: XSS }, basis: XSS },
    tokens: { spent_this_cycle: XSS, basis: XSS },
    reason: XSS,
    privacy: PRIVACY,
    basis: XSS,
  },
  traces: {
    plane: 'on',
    identity: XSS,
    traces: [
      { trace_id: XSS, mission_id: XSS, cycle_id: XSS, trigger: XSS, created_at: XSS, signals: [{ index: XSS, kind: XSS, intensity: XSS, confidence: XSS, valence: XSS, low_confidence: XSS, evidence_ref_count: XSS }], evidence: { total_refs: XSS, resolved_refs: XSS, unresolved_ref_count: XSS, unresolved_evidence_count: XSS } },
    ],
    reason: XSS,
    privacy: PRIVACY,
    basis: XSS,
  },
  archive: {
    plane: 'on',
    identity: XSS,
    coverage: { cells_total: XSS, new_cells_this_cycle: XSS, cycle_id: XSS, occupancy: { occupied: XSS, possible: XSS, ratio: XSS }, cells_by_dimension: { [XSS]: { [XSS]: XSS } }, gaps: [{ dimension: XSS, unoccupied_bins: [XSS] }] },
    incumbents: [{ cell_key: XSS, bins: { mechanism: XSS }, quality: XSS, seed_count: XSS, created_cycle_id: XSS, last_cycle_id: XSS, incumbent_seed_id: XSS }],
    reason: XSS,
    privacy: PRIVACY,
    basis: XSS,
  },
  batons: {
    plane: 'on',
    promotion_flag: XSS,
    batons: [
      { baton_id: XSS, scope: XSS, mission_id: XSS, cycle_id: XSS, candidate_portfolio: [{ seed_id: XSS, hypothesis: XSS }], attention_targets: [{ cue: XSS }], excluded_regions: [{ pattern: XSS }], stop_reason: XSS, payload_hash: XSS, created_at: XSS },
    ],
    refusals: [{ baton_id: XSS, code: XSS, reason: XSS }],
    promotions: [{ promotion_id: XSS, baton_id: XSS, promoted_by: XSS, promoted_at: XSS, payload_hash: XSS }],
    reason: XSS,
    privacy: PRIVACY,
    basis: XSS,
  },
  team: {
    plane: 'on',
    identity: XSS,
    modes: [{ assignment_id: XSS, mission_id: XSS, mode: XSS, status: XSS, started_at: XSS, expires_at: XSS, reason: XSS, verified: XSS, refusal: { code: XSS } }],
    envelopes: [{ envelope_id: XSS, mission_id: XSS, child_label: XSS, mode: XSS, disposition_profile: XSS, disposition_version: XSS, allowed_dimensions: [XSS], mutations: XSS, expires_at: XSS, verified: XSS, refusal: { code: XSS } }],
    allocations: [{ portfolio_id: XSS, mission_id: XSS, agents: [{ identity: XSS, mode: XSS }], verifier_reservation: { identity: XSS }, created_at: XSS }],
    first_pass: [{ portfolio_id: XSS, mission_id: XSS, status: XSS, agents: [{ identity: XSS, mode: XSS, seeds_admitted: XSS }], created_at: XSS }],
    synthesis: [{ portfolio_id: XSS, mission_id: XSS, provenance: [{ seed_id: XSS }], promoted: XSS, created_at: XSS }],
    reason: XSS,
    privacy: PRIVACY,
    basis: XSS,
  },
  metrics: {
    plane: 'on',
    identity: XSS,
    metrics: {
      useful_novelty_rate: { status: 'ok', value: { rate: 0.5, note: XSS }, basis: { sources: [XSS], n: XSS, minimum: XSS, window: { days: XSS } }, reason: XSS },
      false_novelty: { status: 'insufficient_data', value: null, basis: { sources: [XSS], n: XSS, minimum: XSS, window: { days: XSS } }, reason: XSS },
      privacy_leakage: { flagged: XSS, shared_artefacts_scanned: XSS, markers_checked: XSS, keys_checked: [XSS], basis: { measurement: XSS } },
      personality_stability: { violations: XSS, envelopes_checked: XSS, assignments_checked: XSS, by_code: { [XSS]: XSS }, basis: { measurement: XSS } },
      window_comparison: { verdict: XSS, metrics: [{ metric: XSS, direction: XSS, target: { min_relative_gain: XSS, source: XSS }, baseline: { value: XSS, n: XSS }, treatment: { value: XSS, n: XSS }, delta: XSS, relative_gain: XSS, verdict: XSS, reason: XSS }], basis: XSS },
      basis: XSS,
    },
    reason: XSS,
    privacy: PRIVACY,
    basis: XSS,
  },
  experiments: {
    plane: 'on',
    identity: XSS,
    experiments: [{ experiment_id: XSS, name: XSS, hypothesis: XSS, arms: [{ label: XSS }], checkpoints: [XSS], observations: XSS, metrics_recorded: [XSS] }],
    write_path: XSS,
    reason: XSS,
    privacy: PRIVACY,
    basis: XSS,
  },
  compare: {
    plane: 'on',
    comparison: {
      experiment_id: XSS,
      verdict: XSS,
      baseline_arm: XSS,
      treatment_arm: XSS,
      counts: { improved: XSS, not_improved: XSS, insufficient_data: XSS },
      metrics: [{ metric: XSS, direction: XSS, target: { min_relative_gain: XSS, source: XSS }, baseline: { weighted_mean: XSS, n: XSS }, treatment: { weighted_mean: XSS, n: XSS }, delta: XSS, relative_gain: XSS, verdict: XSS, reason: XSS }],
      basis: XSS,
      privacy: PRIVACY,
    },
    reason: XSS,
    basis: XSS,
  },
  rollout: {
    plane: XSS,
    scheduler_mode: XSS,
    kill_switch_active: XSS,
    flags: [{ name: XSS, env_var: XSS, stage: XSS, on: XSS }],
    kill_switches: [{ name: XSS, env_var: XSS, armed: XSS, forces: XSS }],
    stages: [{ stage: XSS, flag: XSS, state: XSS, gates: [XSS], watched: [XSS] }],
    rollback: { doc: XSS, kill_switch_command: XSS, flag_off_command: XSS2, code_rollback_command: XSS, note: XSS },
    basis: XSS,
  },
};

describe('dashboard imagination renderers — escaping', () => {
  it('neutralises every HTML metacharacter', () => {
    const { esc } = buildRenderers();
    expect(esc(`<img src=x onerror="alert(1)">`)).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(esc(`&"<>`)).toBe('&amp;&quot;&lt;&gt;');
    expect(esc(0)).toBe('0');
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('escapes a hostile payload in every view', () => {
    const renderers = buildRenderers();
    for (const [view, payload] of Object.entries(HOSTILE_PAYLOADS)) {
      const html = renderers.imgViewHtml(view, hostile(payload));
      expect(html.length, `${view} rendered nothing`).toBeGreaterThan(0);
      expectEscaped(html);
      // The payload survives only as escaped text — a positive control that the
      // hostile value really did reach the output.
      expect(html, `${view} dropped the payload instead of escaping it`).toContain('&lt;img src=x onerror=alert(1)&gt;');
    }
  });

  it('escapes the empty-with-reason notice and the flag-off notice', () => {
    const renderers = buildRenderers();
    const off = renderers.imgViewHtml('cycles', {
      plane: 'off',
      flag: { name: XSS, on: false },
      reason: XSS,
      cycles: [],
    });
    expectEscaped(off);
    expect(off).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const empty = renderers.imgViewHtml('traces', {
      plane: 'on',
      traces: [],
      reason: XSS2,
      privacy: PRIVACY,
      basis: XSS,
    });
    expectEscaped(empty, XSS2);
    expect(empty).toContain('&lt;/script&gt;&lt;svg onload=alert(2)&gt;');
  });

  it('escapes an unknown view name rather than echoing it raw', () => {
    const renderers = buildRenderers();
    const html = renderers.imgViewHtml(XSS, { plane: 'on' });
    expectEscaped(html);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('the helpers escape both the label and the value', () => {
    const renderers = buildRenderers();
    expectEscaped(renderers.imgKv([[XSS, XSS2]]));
    expectEscaped(renderers.imgTable([{ a: XSS }], [XSS], () => [XSS2]));
    expectEscaped(renderers.imgTag(XSS, XSS2));
    expectEscaped(renderers.imgBasis(XSS));
    expectEscaped(renderers.imgEmpty(XSS));
    expectEscaped(renderers.imgMetric(XSS, { status: 'ok', value: XSS, basis: { sources: [XSS], n: 1, minimum: 1, window: { days: 1 } }, reason: XSS }));
    // A null/undefined payload is still a stated reason, never a crash or raw output.
    expect(renderers.imgViewHtml('cycles', null)).toContain('No payload');
    expect(renderers.imgViewHtml('cycles', undefined)).toContain('No payload');
  });
});

describe('the dashboard and the routes agree on the surface', () => {
  it('every view the page offers exists as a route, and every route has a view', () => {
    const routeSource = readFileSync(new URL('../../src/routes/imagination-dashboard-routes.ts', import.meta.url), 'utf8');
    const routes = [
      '/overview',
      '/cycles',
      '/cycles/:cycleId',
      '/traces',
      '/archive',
      '/batons',
      '/team',
      '/metrics',
      '/experiments',
      '/experiments/compare',
      '/experiments/:experimentId/compare',
      '/rollout',
      '/experiments/observations',
    ];
    for (const path of routes) {
      expect(routeSource, `${path} is not mounted`).toContain(`'${path}'`);
    }
    // The page's own view list: the nine tab views plus the two reached from a
    // list (`cycle` from the cycles table, `compare` from the experiments table).
    const views = /const IMG_VIEWS = \[([^\]]*)\]/.exec(DASHBOARD)![1]
      .split(',')
      .map((entry) => entry.replace(/['\s]/g, ''))
      .filter(Boolean);
    expect(views).toEqual(['overview', 'cycles', 'traces', 'archive', 'batons', 'team', 'metrics', 'experiments', 'rollout']);
    for (const view of [...views, 'cycle', 'compare']) {
      expect(IMAGINATION_SECTION, `${view} has no renderer`).toContain(`view === '${view}'`);
    }
    // The page reads the API base the routes are mounted at.
    expect(DASHBOARD).toContain("const IMG_API = '/api/v1/imagination'");
  });
});

describe('dashboard imagination renderers — no interpolation bypasses the escaper', () => {
  it('routes every server value through the escaping helpers', () => {
    // Positive control: the helpers exist and are the ones the section uses.
    expect(DASHBOARD, 'the page-level escaper is missing').toContain('function esc(');
    for (const helper of ['function imgKv(', 'function imgTable(', 'function imgBasis(', 'function imgEmpty(', 'function imgTag(', 'function imgMetric(', 'function imgPrivacy(', 'function imgViewHtml(']) {
      expect(IMAGINATION_SECTION, `${helper} missing from the ITER-9 section`).toContain(helper);
    }
    // Every cell/value builder in the section goes through a helper that
    // escapes (esc / imgTag / imgEmpty / imgBasis / imgTable / imgKv /
    // imgMetric / imgPrivacy), and no cell is built with a bare concatenation
    // of a server field.
    const cells = IMAGINATION_SECTION.match(/=> \[[^\]]*\]/g) ?? [];
    expect(cells.length).toBeGreaterThan(10);
    for (const cell of cells) {
      expect(cell, `a table cell is not escaped: ${cell}`).not.toMatch(/\+\s*(r|s|m|t|c|e|i|p|x|a|f|k|row)\.\w+\s*\+/);
    }
    // The one place a JSON payload is rendered goes through esc().
    expect(IMAGINATION_SECTION).toContain('esc(JSON.stringify(');
    // …and nothing in the section assigns innerHTML from a raw field.
    expect(IMAGINATION_SECTION).not.toMatch(/innerHTML\s*=\s*(?!.*esc\()[^;]*\b(b\.|body\.)/);
  });
});
