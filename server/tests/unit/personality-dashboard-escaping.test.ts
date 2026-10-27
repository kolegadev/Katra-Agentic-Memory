/**
 * ITER-2 — dashboard Personality tab: escaping of server/user values.
 * Contract: CONTRACT-iter2-per-identity-personality.md
 *
 * The verifier's finding: `renderPersonalityResolution()` interpolated the
 * server-provided `resolved_for` (and the identity list interpolated user ids)
 * into `innerHTML` unescaped — self-XSS grade.
 *
 * Guessing from the source that a `.replace()` chain is present is not proof,
 * so this suite *executes* the dashboard's own functions: the snippets are
 * extracted verbatim from `dashboard/index.html` and evaluated in an isolated
 * scope with stub DOM/fetch objects, then fed hostile payloads. A renderer
 * that leaks markup fails here; one that escapes cannot.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const DASHBOARD_SOURCE = readFileSync(
  new URL('../../../dashboard/index.html', import.meta.url),
  'utf8',
);

/** Hostile payload used for every field: valid inside an attribute or a tag. */
const XSS = '"><img src=x onerror=alert(1)>';

/** Slice one function out of the dashboard source (first `\n}\n` ends it). */
function extractFunction(name: string): string {
  const asyncStart = DASHBOARD_SOURCE.indexOf(`async function ${name}(`);
  const start = asyncStart > -1 ? asyncStart : DASHBOARD_SOURCE.indexOf(`function ${name}(`);
  expect(start, `function ${name}() not found in dashboard/index.html`).toBeGreaterThan(-1);
  const end = DASHBOARD_SOURCE.indexOf('\n}\n', start);
  expect(end, `end of function ${name}() not found`).toBeGreaterThan(start);
  return DASHBOARD_SOURCE.slice(start, end + 2);
}

/** The personality-tab block, for the interpolation sweep below. */
const PERSONALITY_SECTION = (() => {
  const start = DASHBOARD_SOURCE.indexOf('// ═══════════ PERSONALITY ═══════════');
  const end = DASHBOARD_SOURCE.indexOf('// ── Identity ──', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return DASHBOARD_SOURCE.slice(start, end);
})();

interface DashboardSnippets {
  escHtml: (v: unknown) => string;
  renderPersonalityResolution: (d: any) => void;
  loadPersonalityIdentities: () => Promise<void>;
}

/**
 * Evaluate the dashboard's own `escHtml`, `renderPersonalityResolution` and
 * `loadPersonalityIdentities` (extracted from the HTML, never retyped) with
 * injectable globals, exactly as the browser would scope them.
 */
function buildDashboardSnippets(globals: Record<string, unknown>): DashboardSnippets {
  const body = [
    extractFunction('escHtml'),
    extractFunction('renderPersonalityResolution'),
    extractFunction('loadPersonalityIdentities'),
    'return { escHtml, renderPersonalityResolution, loadPersonalityIdentities };',
  ].join('\n');
  return new Function(...Object.keys(globals), body)(...Object.values(globals));
}

function resolutionRenderer() {
  const el = { innerHTML: '' };
  const document = { getElementById: (id: string) => (id === 'pers-resolution' ? el : null) };
  return { el, ...buildDashboardSnippets({ document, API: '/api/v1', callerIdentityId: '' }) };
}

function identitiesRenderer(agents: unknown[]) {
  const list = { dataset: {} as Record<string, string>, innerHTML: '' };
  const document = { getElementById: (id: string) => (id === 'pers-identity-list' ? list : null) };
  const fetch = async () => ({ json: async () => ({ agents }) });
  return { list, ...buildDashboardSnippets({ document, fetch, API: '/api/v1', callerIdentityId: '' }) };
}

describe('dashboard escHtml', () => {
  it('neutralises every HTML metacharacter', () => {
    const { escHtml } = buildDashboardSnippets({});

    expect(escHtml(`<img src=x onerror="alert(1)">`)).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
    expect(escHtml(`'&"<>`)).toBe('&#039;&amp;&quot;&lt;&gt;');
    expect(escHtml(0)).toBe('0');
    expect(escHtml(12.5)).toBe('12.5');
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });
});

describe('dashboard Personality tab — renderPersonalityResolution()', () => {
  it('escapes a hostile resolved_for in every place it appears', () => {
    const { el, renderPersonalityResolution } = resolutionRenderer();

    renderPersonalityResolution({
      resolved_for: XSS,
      origin: 'identity',
      version: 3,
      config: { personality: 'balanced', updated_at: '2026-09-25T00:00:00.000Z' },
      per_identity_enabled: true,
    });

    expect(el.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // …including the origin line, which embeds the identity inside the label.
    expect(el.innerHTML).toContain(
      'personality_config:&quot;&gt;&lt;img src=x onerror=alert(1)&gt;',
    );
    // Nothing the server sent can become live markup: the payload survives
    // only as escaped text.
    expect(el.innerHTML).not.toContain('<img');
    expect(el.innerHTML).not.toContain('<img src=x onerror=');
  });

  it('escapes a hostile profile name, timestamp and version', () => {
    const { el, renderPersonalityResolution } = resolutionRenderer();

    renderPersonalityResolution({
      resolved_for: 'agent-a',
      origin: 'identity',
      version: '<b>9</b>',
      config: { personality: '<script>alert(2)</script>', updated_at: XSS },
      per_identity_enabled: true,
    });

    expect(el.innerHTML).not.toContain('<script');
    expect(el.innerHTML).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(el.innerHTML).not.toContain('<b>9</b>');
    expect(el.innerHTML).not.toContain('<img');
  });

  it('keeps escaping when the flag-off notice and the legacy origin render', () => {
    const { el, renderPersonalityResolution } = resolutionRenderer();

    renderPersonalityResolution({
      resolved_for: XSS,
      origin: 'legacy',
      version: 0,
      config: { personality: 'scholar', updated_at: null },
      per_identity_enabled: false,
    });

    expect(el.innerHTML).toContain('legacy global record');
    expect(el.innerHTML).toContain('PER_IDENTITY_PERSONALITY is off');
    expect(el.innerHTML).not.toContain('<img');
  });
});

describe('dashboard Personality tab — identity list rendering', () => {
  it('escapes identity ids from the server before they reach the datalist', async () => {
    const { list, loadPersonalityIdentities } = identitiesRenderer([
      { user_id: XSS },
      { user_id: 'agent-a' },
    ]);

    await loadPersonalityIdentities();

    expect(list.innerHTML).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(list.innerHTML).not.toContain('<img');
    expect(list.innerHTML).not.toContain('<img src=x onerror=');
    // The ordinary id is unchanged, and the one-shot load guard still works.
    expect(list.innerHTML).toContain('value="agent-a"');
    expect(list.dataset.loaded).toBe('1');
  });
});

describe('dashboard Personality tab — no interpolation bypasses the escaper', () => {
  it('routes every server/user value through escHtml() in the personality section', () => {
    // Positive control: the escaped forms really are the ones in the source.
    for (const escaped of [
      'escHtml(name)',
      'escHtml(id)',
      'escHtml(src)',
      'escHtml(label)',
      'escHtml(val)',
      'escHtml(d.config.personality)',
      'escHtml(d.config.updated_at)',
      'escHtml(d.version ?? 0)',
    ]) {
      expect(PERSONALITY_SECTION, `${escaped} is missing`).toContain(escaped);
    }

    // …and the raw interpolations the finding named are gone.
    for (const raw of [
      '${d.resolved_for}',
      '${d.config.personality}',
      '${d.config.updated_at}',
      '${d.version',
      '${name}',
      '${id}',
      '${src}',
      '${label}',
      '${val}',
    ]) {
      expect(PERSONALITY_SECTION, `${raw} is interpolated without escHtml`).not.toContain(raw);
    }
  });
});
