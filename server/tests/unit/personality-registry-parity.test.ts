/**
 * ITER-1 — canonical personality registry parity.
 * Contract: CONTRACT-iter1-personality-registry.md
 *
 * The registry (`shared/personality/registry.json`) is the single source of
 * truth for the ten memory personality profiles. This suite proves:
 *
 *   1. the registry is well-formed and declares the ten profiles, the eleven
 *      sources, the agent-message invariant and the recommended budgets;
 *   2. both generated artifacts are fresh — a generation into a temp dir is
 *      byte-identical to what is committed, and `--check` fails on a hand edit;
 *   3. the server runtime materialises exactly the registry's effective values,
 *      with agent_message pinned at 10.0 and unknown names falling back to
 *      `balanced`;
 *   4. zero drift: every profile is field-for-field and source-for-source what
 *      the pre-registry module shipped at 48ba7e6 (evaluated from git, not
 *      transcribed).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_MESSAGE_WEIGHT,
  ALL_SOURCES,
  DEFAULT_FLOORS,
  PROFILES,
  PROFILE_NAMES,
  RECOMMENDED_BUDGETS,
  profile,
} from '../../src/services/integration/personality-profiles.js';
import * as generated from '../../src/services/integration/personality-profiles.generated.js';

const require = createRequire(import.meta.url);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'shared/personality/registry.json');
const GENERATOR = path.join(REPO_ROOT, 'scripts/generate-personality-registry.mjs');
const TS_ARTIFACT_REL = 'server/src/services/integration/personality-profiles.generated.ts';
const PY_ARTIFACT_REL = 'integrations/kolega-code/kolega_katra_bridge/personality_registry.generated.py';
const ARTIFACT_RELS = [TS_ARTIFACT_REL, PY_ARTIFACT_REL];

/** The commit the registry canonicalises; pre-change values are read from it. */
const PRE_CHANGE_COMMIT = '48ba7e6';
const PRE_CHANGE_FILE = 'server/src/services/integration/personality-profiles.ts';

const EXPECTED_PROFILES = [
  'balanced',
  'legacy',
  'scholar',
  'pragmatist',
  'strategist',
  'historian',
  'empath',
  'analyst',
  'sentinel',
  'dreamer',
];

interface Scoring {
  k: number;
  half_life_days: number;
  cap_pct: number;
  floors: Record<string, number>;
  vector_fetch_limit: number;
  vector_sample: boolean;
  min_fetch_weight: number;
}

interface RegistryProfile {
  name: string;
  description: string;
  server_description?: string;
  weights: Record<string, number>;
  scoring: Partial<Scoring>;
}

interface Registry {
  registry_version: string;
  agent_message_weight: number;
  sources: string[];
  reflection_family: string[];
  default_scoring: Scoring;
  profiles: Record<string, RegistryProfile>;
  recommended_budgets: Record<string, number>;
}

interface PreChangeProfile {
  name: string;
  description: string;
  weights: Record<string, number>;
  relevance_multiplier: number;
  recency_half_life_days: number;
  budget_floors: Record<string, number>;
  max_single_source_pct: number;
  vector_fetch_limit: number;
  vector_sample: boolean;
  min_fetch_weight: number;
}

const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;

/** The registry's declared values for one profile: defaults plus its overrides. */
function effectiveScoring(entry: RegistryProfile): Scoring {
  const overrides = entry.scoring ?? {};
  const defaults = registry.default_scoring;
  return {
    k: overrides.k ?? defaults.k,
    half_life_days: overrides.half_life_days ?? defaults.half_life_days,
    cap_pct: overrides.cap_pct ?? defaults.cap_pct,
    floors: overrides.floors ?? defaults.floors,
    vector_fetch_limit: overrides.vector_fetch_limit ?? defaults.vector_fetch_limit,
    vector_sample: overrides.vector_sample ?? defaults.vector_sample,
    min_fetch_weight: overrides.min_fetch_weight ?? defaults.min_fetch_weight,
  };
}

/** The weights one profile should resolve to, agent_message included. */
function effectiveWeights(entry: RegistryProfile): Record<string, number> {
  return { ...entry.weights, agent_message: registry.agent_message_weight };
}

function runGenerator(args: string[], cwd = REPO_ROOT): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [GENERATOR, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${PRE_CHANGE_COMMIT}^{commit}`], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let scratchDir: string;

beforeAll(() => {
  scratchDir = mkdtempSync(path.join(tmpdir(), 'personality-registry-'));
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('shared/personality/registry.json', () => {
  it('declares version 1.0, the eleven sources and the agent-message invariant', () => {
    expect(registry.registry_version).toBe('1.0');
    expect(registry.agent_message_weight).toBe(10.0);
    expect(registry.sources).toHaveLength(11);
    expect(new Set(registry.sources).size).toBe(11);
    expect(registry.sources).toContain('agent_message');
    expect(ALL_SOURCES).toEqual(registry.sources);
    expect(registry.reflection_family.length).toBeGreaterThan(0);
    for (const source of registry.reflection_family) expect(registry.sources).toContain(source);
  });

  it('declares exactly the ten profiles, in the order both runtimes ship', () => {
    expect(Object.keys(registry.profiles)).toEqual(EXPECTED_PROFILES);
    expect(PROFILE_NAMES).toEqual(EXPECTED_PROFILES);
  });

  it('gives every profile the registry’s sources and no others, minus the pinned agent_message', () => {
    for (const name of EXPECTED_PROFILES) {
      const entry = registry.profiles[name];
      expect(entry.name).toBe(name);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(Object.keys(entry.weights).sort()).toEqual(
        registry.sources.filter((source) => source !== 'agent_message').sort(),
      );
    }
  });

  it('declares default scoring that balanced inherits, and floors inside the sources', () => {
    for (const key of ['k', 'half_life_days', 'cap_pct', 'floors', 'vector_fetch_limit', 'vector_sample', 'min_fetch_weight']) {
      expect(Object.keys(registry.default_scoring)).toContain(key);
    }
    expect(registry.profiles.balanced.scoring).toEqual({});
    expect(registry.default_scoring.floors).toEqual({ working_memory: 0.1, vector_search: 0.15 });
    for (const name of EXPECTED_PROFILES) {
      for (const source of Object.keys(effectiveScoring(registry.profiles[name]).floors)) {
        expect(registry.sources).toContain(source);
      }
    }
  });

  it('declares a recommended budget for each of the ten profiles', () => {
    expect(Object.keys(registry.recommended_budgets).sort()).toEqual([...EXPECTED_PROFILES].sort());
    for (const budget of Object.values(registry.recommended_budgets)) {
      expect(Number.isInteger(budget)).toBe(true);
      expect(budget).toBeGreaterThan(0);
    }
    expect(RECOMMENDED_BUDGETS).toEqual(registry.recommended_budgets);
  });
});

describe('generated artifacts', () => {
  it('renders the committed artifacts byte-for-byte from the registry', () => {
    const outDir = path.join(scratchDir, 'fresh');
    const result = runGenerator(['--out-dir', outDir]);
    expect(result.status, result.stderr).toBe(0);

    for (const rel of ARTIFACT_RELS) {
      const fresh = readFileSync(path.join(outDir, rel));
      const committed = readFileSync(path.join(REPO_ROOT, rel));
      expect(fresh.equals(committed), `${rel} differs from a fresh generation`).toBe(true);
    }
  });

  it('passes --check on the delivered tree', () => {
    const result = runGenerator(['--check']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(TS_ARTIFACT_REL);
    expect(result.stdout).toContain(PY_ARTIFACT_REL);
  });

  it('fails --check, with a diff summary and writes nothing, when an artifact is hand-edited', () => {
    const outDir = path.join(scratchDir, 'tampered');
    for (const rel of ARTIFACT_RELS) {
      const target = path.join(outDir, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path.join(REPO_ROOT, rel)));
    }
    expect(runGenerator(['--check', '--out-dir', outDir]).status).toBe(0);

    const tampered = path.join(outDir, TS_ARTIFACT_REL);
    writeFileSync(tampered, readFileSync(tampered, 'utf8') + '// hand edit — not generated\n');
    const edited = readFileSync(tampered, 'utf8');

    const result = runGenerator(['--check', '--out-dir', outDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('stale');
    expect(result.stderr).toContain('lines differ');
    expect(readFileSync(tampered, 'utf8')).toBe(edited);
  });

  it('carries a fresh-generation header naming the registry and the generator', () => {
    for (const rel of ARTIFACT_RELS) {
      const content = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(content).toContain('AUTO-GENERATED FILE — DO NOT EDIT BY HAND.');
      expect(content).toContain('shared/personality/registry.json');
      expect(content).toContain('node scripts/generate-personality-registry.mjs');
      expect(content.endsWith('\n')).toBe(true);
      expect(content).not.toMatch(/\r/);
    }
  });

  it('exposes exactly the registry through the generated module', () => {
    expect(generated.REGISTRY_VERSION).toBe(registry.registry_version);
    expect(generated.AGENT_MESSAGE_WEIGHT).toBe(10.0);
    expect(generated.ALL_SOURCES).toEqual(registry.sources);
    expect(generated.RECOMMENDED_BUDGETS).toEqual(registry.recommended_budgets);
    expect(Object.keys(generated.PROFILE_DATA)).toEqual(EXPECTED_PROFILES);
    for (const name of EXPECTED_PROFILES) {
      expect(generated.PROFILE_DATA[name].name).toBe(name);
      expect(generated.PROFILE_DATA[name].weights).toEqual(registry.profiles[name].weights);
      expect(generated.PROFILE_DATA[name].scoring).toEqual(registry.profiles[name].scoring);
    }
  });
});

describe('server runtime parity', () => {
  it('pins the agent-message weight at 10.0, and no profile may restate or lower it', () => {
    expect(AGENT_MESSAGE_WEIGHT).toBe(10.0);
    expect(registry.agent_message_weight).toBe(10.0);
    for (const name of EXPECTED_PROFILES) {
      expect(PROFILES[name].weights.agent_message).toBe(10.0);
      // The pin is the only source of that number: an entry cannot carry its own.
      expect(generated.PROFILE_DATA[name].weights.agent_message).toBeUndefined();
      expect(Object.keys(generated.PROFILE_DATA[name].scoring)).not.toContain('agent_message');
    }
  });

  it('resolves every profile to the registry’s declared effective values', () => {
    for (const name of EXPECTED_PROFILES) {
      const entry = registry.profiles[name];
      const scoring = effectiveScoring(entry);
      const resolved = PROFILES[name];
      expect(resolved.name).toBe(name);
      expect(resolved.description).toBe(entry.server_description ?? entry.description);
      expect(resolved.weights).toEqual(effectiveWeights(entry));
      expect(Object.keys(resolved.weights)).toEqual([...Object.keys(entry.weights), 'agent_message']);
      expect(resolved.relevance_multiplier).toBe(scoring.k);
      expect(resolved.recency_half_life_days).toBe(scoring.half_life_days);
      expect(resolved.budget_floors).toEqual(scoring.floors);
      expect(resolved.max_single_source_pct).toBe(scoring.cap_pct);
      expect(resolved.vector_fetch_limit).toBe(scoring.vector_fetch_limit);
      expect(resolved.vector_sample).toBe(scoring.vector_sample);
      expect(resolved.min_fetch_weight).toBe(scoring.min_fetch_weight);
    }
  });

  it('resolves unknown and empty names to balanced', () => {
    expect(profile('definitely-not-a-profile').name).toBe('balanced');
    expect(profile('').name).toBe('balanced');
    expect(profile('BALANCED').name).toBe('balanced');
    expect(profile('sentinel').name).toBe('sentinel');
    expect(PROFILES['definitely-not-a-profile']).toBeUndefined();
  });

  it('keeps floors and caps inside the documented bounds', () => {
    for (const name of EXPECTED_PROFILES) {
      const scoring = effectiveScoring(registry.profiles[name]);
      const floorTotal = Object.values(scoring.floors).reduce((sum, floor) => sum + floor, 0);

      expect(scoring.k).toBeGreaterThanOrEqual(0);
      expect(scoring.half_life_days).toBeGreaterThan(0);
      expect(scoring.cap_pct).toBeGreaterThan(0);
      expect(scoring.cap_pct).toBeLessThanOrEqual(1);
      expect(Number.isInteger(scoring.vector_fetch_limit)).toBe(true);
      expect(scoring.vector_fetch_limit).toBeGreaterThanOrEqual(1);
      expect(scoring.min_fetch_weight).toBeGreaterThanOrEqual(0);
      for (const floor of Object.values(scoring.floors)) {
        expect(floor).toBeGreaterThanOrEqual(0);
        expect(floor).toBeLessThanOrEqual(1);
      }
      // Budget floors reserve shares of one budget: they cannot overflow it.
      expect(floorTotal).toBeLessThanOrEqual(1);
      for (const weight of Object.values(effectiveWeights(registry.profiles[name]))) {
        expect(weight).toBeGreaterThanOrEqual(0);
      }
    }
    expect(DEFAULT_FLOORS).toEqual(registry.default_scoring.floors);
  });
});

/**
 * The anti-drift proof: the pre-registry module is read out of git, bundled and
 * evaluated in its own Node process (no transcription, no self-reported
 * numbers), then compared with the registry-derived runtime values.
 */
describe(`anti-drift proof against ${PRE_CHANGE_COMMIT}`, () => {
  const available = gitAvailable();

  it.skipIf(!available)('reads the pre-change module out of git', () => {
    const source = execFileSync('git', ['show', `${PRE_CHANGE_COMMIT}:${PRE_CHANGE_FILE}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(source).toContain('export const PROFILES');
  });

  it.skipIf(!available)('matches every profile field-for-field and source-for-source', () => {
    const esbuild = require('esbuild') as typeof import('esbuild');
    const source = execFileSync('git', ['show', `${PRE_CHANGE_COMMIT}:${PRE_CHANGE_FILE}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });

    const bundle = esbuild.buildSync({
      stdin: {
        contents: source,
        loader: 'ts',
        resolveDir: path.join(REPO_ROOT, 'server/src/services/integration'),
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: false,
    });

    const dir = mkdtempSync(path.join(scratchDir, 'pre-change-'));
    const bundlePath = path.join(dir, 'pre-change.mjs');
    const dumpPath = path.join(dir, 'pre-change.json');
    writeFileSync(bundlePath, bundle.outputFiles[0].text);
    // A child process, so the bundle is evaluated by Node, not by the test runner.
    writeFileSync(
      path.join(dir, 'dump.mjs'),
      [
        "import { writeFileSync } from 'node:fs';",
        "import { pathToFileURL } from 'node:url';",
        'const mod = await import(pathToFileURL(process.argv[2]).href);',
        'writeFileSync(process.argv[3], JSON.stringify(mod.PROFILES));',
      ].join('\n'),
    );
    execFileSync(process.execPath, [path.join(dir, 'dump.mjs'), bundlePath, dumpPath], { encoding: 'utf8' });

    const before = JSON.parse(readFileSync(dumpPath, 'utf8')) as Record<string, PreChangeProfile>;
    expect(Object.keys(before)).toEqual(EXPECTED_PROFILES);

    for (const name of EXPECTED_PROFILES) {
      const entry = registry.profiles[name];
      const scoring = effectiveScoring(entry);
      const now = PROFILES[name];

      // Description: each runtime keeps the text it shipped before ITER-1.
      expect(before[name].description).toBe(now.description);
      expect(before[name].name).toBe(now.name);

      // Weights: same numbers, same key order, agent_message last in both.
      expect(before[name].weights).toEqual(now.weights);
      expect(Object.keys(before[name].weights)).toEqual(Object.keys(now.weights));

      // Scoring: the pre-change values are the registry's effective values.
      expect(before[name].relevance_multiplier).toBe(scoring.k);
      expect(before[name].recency_half_life_days).toBe(scoring.half_life_days);
      expect(before[name].max_single_source_pct).toBe(scoring.cap_pct);
      expect(before[name].vector_fetch_limit).toBe(scoring.vector_fetch_limit);
      expect(before[name].vector_sample).toBe(scoring.vector_sample);
      expect(before[name].min_fetch_weight).toBe(scoring.min_fetch_weight);
      expect(before[name].budget_floors).toEqual(scoring.floors);
      expect(Object.keys(before[name].budget_floors)).toEqual(Object.keys(scoring.floors));
      expect(before[name]).toEqual(now);
    }
  });
});
