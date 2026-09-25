#!/usr/bin/env node
/**
 * Personality registry generator — ITER-1 canonicalisation.
 *
 * `shared/personality/registry.json` is the single source of truth for the ten
 * memory personality profiles: their sources, weights, scoring parameters,
 * floors, the agent-message invariant and the recommended token budgets. This
 * script renders that registry into the two artifacts the runtimes consume:
 *
 *   server/src/services/integration/personality-profiles.generated.ts
 *   integrations/kolega-code/kolega_katra_bridge/personality_registry.generated.py
 *
 * Usage (from the repository root):
 *   node scripts/generate-personality-registry.mjs                # (re)write both artifacts
 *   node scripts/generate-personality-registry.mjs --check        # verify only; write nothing
 *   node scripts/generate-personality-registry.mjs --out-dir DIR  # render into DIR (tests)
 *
 * `--check` exits non-zero and prints a diff summary when an artifact on disk
 * differs from a fresh generation (or is missing). Output is byte-deterministic:
 * the registry's key order, LF endings, no timestamps, no absolute paths.
 * Dependency-free, no network — it runs beside `npm ci`, not after it.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const REGISTRY_REL = 'shared/personality/registry.json';
const ARTIFACTS = [
  { rel: 'server/src/services/integration/personality-profiles.generated.ts', render: renderTypeScript },
  { rel: 'integrations/kolega-code/kolega_katra_bridge/personality_registry.generated.py', render: renderPython },
];

/** Registry scoring keys, in the order the artifacts declare them. */
const SCORING_KEYS = ['k', 'half_life_days', 'cap_pct', 'floors', 'vector_fetch_limit', 'vector_sample', 'min_fetch_weight'];
/** Registry scoring key → the runtimes' field names, emitted into both artifacts. */
const SCORING_FIELD_NAMES = {
  k: 'relevance_multiplier',
  half_life_days: 'recency_half_life_days',
  cap_pct: 'max_single_source_pct',
  floors: 'budget_floors',
  vector_fetch_limit: 'vector_fetch_limit',
  vector_sample: 'vector_sample',
  min_fetch_weight: 'min_fetch_weight',
};

/** Only the keys whose runtime field name differs need a mapping note. */
function scoringMappingNote() {
  return Object.entries(SCORING_FIELD_NAMES)
    .filter(([key, field]) => key !== field)
    .map(([key, field]) => `${key} \u2192 ${field}`)
    .join(', ');
}
/** The invariant this generator refuses to render if violated. */
const AGENT_MESSAGE_WEIGHT = 10.0;
const FALLBACK_PROFILE = 'balanced';

class RegistryError extends Error {}

function fail(message) {
  throw new RegistryError(message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a JSON object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requireNumber(value, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number`);
  if (integer && !Number.isInteger(value)) fail(`${label} must be an integer, got ${value}`);
  if (value < min || value > max) fail(`${label} must be between ${min} and ${max}, got ${value}`);
  return value;
}

function requireFloors(value, label, sources) {
  requireObject(value, label);
  let sum = 0;
  for (const [source, floor] of Object.entries(value)) {
    if (!sources.includes(source)) fail(`${label}.${source} is not one of the registry's sources`);
    requireNumber(floor, `${label}.${source}`, { min: 0, max: 1 });
    sum += floor;
  }
  if (sum > 1) fail(`${label} sums to ${sum} — budget floors cannot exceed the whole budget`);
  return value;
}

function requireScoring(value, label, sources) {
  requireObject(value, label);
  for (const key of Object.keys(value)) {
    if (!SCORING_KEYS.includes(key)) fail(`${label}.${key} is not a known scoring key (${SCORING_KEYS.join(', ')})`);
  }
  if ('k' in value) requireNumber(value.k, `${label}.k`, { min: 0 });
  if ('half_life_days' in value) requireNumber(value.half_life_days, `${label}.half_life_days`, { min: Number.MIN_VALUE });
  if ('cap_pct' in value) requireNumber(value.cap_pct, `${label}.cap_pct`, { min: Number.MIN_VALUE, max: 1 });
  if ('floors' in value) requireFloors(value.floors, `${label}.floors`, sources);
  if ('vector_fetch_limit' in value) requireNumber(value.vector_fetch_limit, `${label}.vector_fetch_limit`, { min: 1, integer: true });
  if ('vector_sample' in value && typeof value.vector_sample !== 'boolean') fail(`${label}.vector_sample must be a boolean`);
  if ('min_fetch_weight' in value) requireNumber(value.min_fetch_weight, `${label}.min_fetch_weight`, { min: 0 });
  return value;
}

/**
 * Validate the registry and return the fields the renderers need.
 *
 * The generator is the gate that keeps a hand edit from reaching either
 * runtime: the agent-message weight is pinned here, every weight key must be a
 * known source, and no profile may restate the invariant.
 */
function validate(registry) {
  requireObject(registry, 'registry.json');
  const version = requireString(registry.registry_version, 'registry_version');

  const agentMessageWeight = requireNumber(registry.agent_message_weight, 'agent_message_weight');
  if (agentMessageWeight !== AGENT_MESSAGE_WEIGHT) {
    fail(`agent_message_weight is ${agentMessageWeight}; the invariant is ${AGENT_MESSAGE_WEIGHT} and may not be weakened`);
  }

  if (!Array.isArray(registry.sources) || registry.sources.length === 0) fail('sources must be a non-empty array');
  const sources = registry.sources.map((source, i) => requireString(source, `sources[${i}]`));
  if (new Set(sources).size !== sources.length) fail('sources contains duplicates');
  if (!sources.includes('agent_message')) fail("sources must include 'agent_message'");

  if (!Array.isArray(registry.reflection_family)) fail('reflection_family must be an array');
  const reflectionFamily = registry.reflection_family.map((source, i) => requireString(source, `reflection_family[${i}]`));
  for (const source of reflectionFamily) {
    if (!sources.includes(source)) fail(`reflection_family entry ${source} is not one of the registry's sources`);
  }

  const scoring = requireScoring(registry.default_scoring, 'default_scoring', sources);
  for (const key of SCORING_KEYS) {
    if (!(key in scoring)) fail(`default_scoring.${key} is required — every profile inherits it`);
  }

  requireObject(registry.profiles, 'profiles');
  const profileNames = Object.keys(registry.profiles);
  if (profileNames.length === 0) fail('profiles must not be empty');
  if (!profileNames.includes(FALLBACK_PROFILE)) fail(`profiles must include '${FALLBACK_PROFILE}' — both runtimes fall back to it`);

  const weightKeys = sources.filter((source) => source !== 'agent_message');
  const profiles = {};
  for (const [key, entry] of Object.entries(registry.profiles)) {
    const label = `profiles.${key}`;
    requireObject(entry, label);
    if (requireString(entry.name, `${label}.name`) !== key) fail(`${label}.name must equal its key`);
    requireString(entry.description, `${label}.description`);
    if ('server_description' in entry) requireString(entry.server_description, `${label}.server_description`);

    requireObject(entry.weights, `${label}.weights`);
    if ('agent_message' in entry.weights) {
      fail(`${label}.weights restates agent_message — the invariant lives in agent_message_weight alone`);
    }
    // Declared order is carried through: the Python artifact is a dict literal,
    // so its key order is observable at runtime and must stay as it was.
    const weights = {};
    for (const [source, weight] of Object.entries(entry.weights)) {
      if (!weightKeys.includes(source)) fail(`${label}.weights.${source} is not one of the registry's sources`);
      weights[source] = requireNumber(weight, `${label}.weights.${source}`, { min: 0 });
    }
    for (const source of weightKeys) {
      if (!(source in entry.weights)) fail(`${label}.weights.${source} is missing`);
    }

    profiles[key] = {
      name: entry.name,
      description: entry.description,
      ...('server_description' in entry ? { serverDescription: entry.server_description } : {}),
      weights,
      scoring: requireScoring(entry.scoring, `${label}.scoring`, sources),
    };
  }

  requireObject(registry.recommended_budgets, 'recommended_budgets');
  for (const name of profileNames) {
    if (!(name in registry.recommended_budgets)) fail(`recommended_budgets.${name} is missing`);
  }
  const recommendedBudgets = {};
  for (const [name, budget] of Object.entries(registry.recommended_budgets)) {
    if (!profileNames.includes(name)) fail(`recommended_budgets.${name} is not a known profile`);
    recommendedBudgets[name] = requireNumber(budget, `recommended_budgets.${name}`, { min: 1, integer: true });
  }

  return {
    version,
    agentMessageWeight,
    sources,
    reflectionFamily,
    scoring,
    profileNames,
    profiles,
    recommendedBudgets,
  };
}

// ── rendering primitives ────────────────────────────────────────────────────

/** Floats keep their decimal point (`10.0`), so the Python artifact stays float-typed. */
function asFloat(value, label) {
  requireNumber(value, label);
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

function asInt(value, label) {
  requireNumber(value, label, { integer: true });
  return `${value}`;
}

function asBool(value, label, lang) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  if (lang === 'py') return value ? 'True' : 'False';
  return value ? 'true' : 'false';
}

function tsString(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function pyString(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function indent(level, spaces = 2) {
  return ' '.repeat(level * spaces);
}

/** `floors` is a value, not just a struct: empty floors render inline as `{}`. */
function renderNumber(value, label, key, lang) {
  if (key === 'vector_fetch_limit') return asInt(value, label);
  if (key === 'vector_sample') return asBool(value, label, lang);
  return asFloat(value, label);
}

const GENERATED_BY = [
  'AUTO-GENERATED FILE — DO NOT EDIT BY HAND.',
  '',
  'Generated from shared/personality/registry.json by',
  'scripts/generate-personality-registry.mjs.',
  'Regenerate with: node scripts/generate-personality-registry.mjs',
];

// ── TypeScript artifact ─────────────────────────────────────────────────────

function tsFloors(floors, level, label) {
  const entries = Object.entries(floors);
  if (entries.length === 0) return [indent(level) + 'floors: {},'];
  const lines = [indent(level) + 'floors: {'];
  for (const [source, floor] of entries) {
    lines.push(indent(level + 1) + source + ': ' + asFloat(floor, `${label}.${source}`) + ',');
  }
  lines.push(indent(level) + '},');
  return lines;
}

/** Keys in the order the registry declares them (validation already rejected the rest). */
function declaredScoringKeys(scoring) {
  return Object.keys(scoring).filter((key) => SCORING_KEYS.includes(key));
}

function tsScoring(scoring, level, label) {
  const keys = declaredScoringKeys(scoring);
  if (keys.length === 0) return [indent(level) + '{},'];
  const lines = [indent(level) + '{'];
  for (const key of keys) {
    if (key === 'floors') {
      lines.push(...tsFloors(scoring.floors, level + 1, `${label}.floors`));
    } else {
      lines.push(indent(level + 1) + key + ': ' + renderNumber(scoring[key], `${label}.${key}`, key, 'ts') + ',');
    }
  }
  lines.push(indent(level) + '},');
  return lines;
}

function renderTypeScript(registry) {
  const { version, sources, agentMessageWeight, scoring, profiles, profileNames, recommendedBudgets } = registry;
  const lines = [
    '/**',
    ...GENERATED_BY.map((line) => (line ? ` * ${line}` : ' *')),
    ' *',
    ' * The registry is the single source of truth for the ten memory personality',
    ' * profiles — sources, weights, scoring parameters, budget floors, the',
    ' * agent-message invariant and the recommended token budgets. This module is',
    ' * the server half of that source; the bridge consumes the same registry.',
    ' * ITER-1 changed no value: the numbers here are the ones the server shipped',
    ' * before the registry existed.',
    ' */',
    '',
    '/** Schema version of shared/personality/registry.json. */',
    `export const REGISTRY_VERSION = ${tsString(version)};`,
    '',
    '/** Inter-agent comms always rank first. Not overridable (enforced in the bridge). */',
    `export const AGENT_MESSAGE_WEIGHT = ${asFloat(agentMessageWeight, 'agent_message_weight')};`,
    '',
    '/** All source labels known to the retriever. */',
    'export const ALL_SOURCES = [',
    ...sources.map((source) => `  ${tsString(source)},`),
    '] as const;',
    '',
    '/**',
    ' * Scoring parameters every profile inherits unless it overrides them.',
    ` * Registry scoring keys are the server's field names: ${scoringMappingNote()}.`,
    ' */',
    'export const DEFAULT_SCORING = {',
    `  /** k in: composite = weight * (1 + k*vector_score + recency_score) */`,
    `  k: ${asFloat(scoring.k, 'default_scoring.k')},`,
    '  /** Half-life for power-law recency: 1 / (1 + age_days / half_life) */',
    `  half_life_days: ${asFloat(scoring.half_life_days, 'default_scoring.half_life_days')},`,
    '  /** No single source (except agent_message) may exceed this share. */',
    `  cap_pct: ${asFloat(scoring.cap_pct, 'default_scoring.cap_pct')},`,
    '  /** Guaranteed minimum share of the token budget per source (fractions). */',
    ...tsFloors(scoring.floors, 1, 'default_scoring.floors'),
    '  /** Vector search: how many candidates to fetch. */',
    `  vector_fetch_limit: ${asInt(scoring.vector_fetch_limit, 'default_scoring.vector_fetch_limit')},`,
    '  /** If true, sample the fetched candidates score-weighted at random. */',
    `  vector_sample: ${renderNumber(scoring.vector_sample, 'default_scoring.vector_sample', 'vector_sample', 'ts')},`,
    '  /** Sources whose weight falls below this are not fetched at all. */',
    `  min_fetch_weight: ${asFloat(scoring.min_fetch_weight, 'default_scoring.min_fetch_weight')},`,
    '} as const;',
    '',
    '/** A profile\'s scoring overrides — only the keys it actually restates. */',
    'export interface ProfileScoringOverrides {',
    '  readonly k?: number;',
    '  readonly half_life_days?: number;',
    '  readonly cap_pct?: number;',
    '  readonly floors?: Readonly<Record<string, number>>;',
    '  readonly vector_fetch_limit?: number;',
    '  readonly vector_sample?: boolean;',
    '  readonly min_fetch_weight?: number;',
    '}',
    '',
    '/** One profile as declared in the registry. */',
    'export interface ProfileData {',
    '  readonly name: string;',
    '  readonly description: string;',
    '  /**',
    "   * The server mirror's own wording where it has historically differed from the",
    '   * bridge text (registry v1.0: `legacy` only). ITER-1 is behaviour-preserving,',
    '   * so the server keeps the wording it ships today.',
    '   */',
    '  readonly server_description?: string;',
    '  readonly weights: Readonly<Record<string, number>>;',
    '  readonly scoring: ProfileScoringOverrides;',
    '}',
    '',
    '/** The ten profiles, in registry order. */',
    'export const PROFILE_DATA: Readonly<Record<string, ProfileData>> = {',
  ];

  for (const name of profileNames) {
    const profile = profiles[name];
    lines.push(`  ${name}: {`);
    lines.push(`    name: ${tsString(profile.name)},`);
    lines.push(`    description: ${tsString(profile.description)},`);
    if (profile.serverDescription !== undefined) {
      lines.push(`    server_description: ${tsString(profile.serverDescription)},`);
    }
    lines.push('    weights: {');
    for (const [source, weight] of Object.entries(profile.weights)) {
      lines.push(`      ${source}: ${asFloat(weight, `profiles.${name}.weights.${source}`)},`);
    }
    lines.push('    },');
    lines.push(`    scoring: ${tsScoring(profile.scoring, 2, `profiles.${name}.scoring`).join('\n').trimStart()}`);
    lines.push('  },');
  }

  lines.push('};', '');
  lines.push('/** Recommended token budgets per profile (from IMPLEMENTATION-PLAN.md). */');
  lines.push('export const RECOMMENDED_BUDGETS: Record<string, number> = {');
  for (const [name, budget] of Object.entries(recommendedBudgets)) {
    lines.push(`  ${name}: ${asInt(budget, `recommended_budgets.${name}`)},`);
  }
  lines.push('};', '');

  return lines.join('\n');
}

// ── Python artifact ─────────────────────────────────────────────────────────

function pyFloors(floors, level, label) {
  const entries = Object.entries(floors);
  if (entries.length === 0) return [indent(level, 4) + '"floors": {},'];
  const lines = [indent(level, 4) + '"floors": {'];
  for (const [source, floor] of entries) {
    lines.push(indent(level + 1, 4) + pyString(source) + ': ' + asFloat(floor, `${label}.${source}`) + ',');
  }
  lines.push(indent(level, 4) + '},');
  return lines;
}

function pyScoring(scoring, level, label) {
  const keys = declaredScoringKeys(scoring);
  if (keys.length === 0) return [indent(level, 4) + '{},'];
  const lines = [indent(level, 4) + '{'];
  for (const key of keys) {
    if (key === 'floors') {
      lines.push(...pyFloors(scoring.floors, level + 1, `${label}.floors`));
    } else {
      lines.push(indent(level + 1, 4) + pyString(key) + ': ' + renderNumber(scoring[key], `${label}.${key}`, key, 'py') + ',');
    }
  }
  lines.push(indent(level, 4) + '},');
  return lines;
}

function renderPython(registry) {
  const { version, sources, agentMessageWeight, scoring, profiles, profileNames, recommendedBudgets } = registry;
  const lines = [
    '"""',
    ...GENERATED_BY,
    '',
    'The registry is the single source of truth for the ten memory personality',
    'profiles — sources, weights, scoring parameters, budget floors, the',
    'agent-message invariant and the recommended token budgets. This module is the',
    'bridge half of that source; the server consumes the same registry.',
    '',
    'The file name contains a dot (its TypeScript sibling uses the same',
    'convention), so it is not importable as a submodule: personality.py loads it',
    'by path — see personality._load_registry(). ITER-1 changed no value: the',
    'numbers here are the ones the bridge shipped before the registry existed.',
    '"""',
    '',
    `REGISTRY_VERSION = ${pyString(version)}`,
    '',
    '# Inter-agent comms always rank first. Not overridable.',
    `AGENT_MESSAGE_WEIGHT = ${asFloat(agentMessageWeight, 'agent_message_weight')}`,
    '',
    '# All source labels known to the retriever. "reflection" (legacy umbrella)',
    '# is expanded to the three sub-sources at config load time.',
    'ALL_SOURCES = (',
    ...sources.map((source) => `    ${pyString(source)},`),
    ')',
    '',
    'REFLECTION_FAMILY = (',
    ...registry.reflectionFamily.map((source) => `    ${pyString(source)},`),
    ')',
    '',
    '# Scoring parameters every profile inherits unless it overrides them. The',
    `# registry scoring keys are the dataclass's field names: ${scoringMappingNote()}.`,
    'DEFAULT_SCORING = {',
    `    "k": ${asFloat(scoring.k, 'default_scoring.k')},`,
    `    "half_life_days": ${asFloat(scoring.half_life_days, 'default_scoring.half_life_days')},`,
    `    "cap_pct": ${asFloat(scoring.cap_pct, 'default_scoring.cap_pct')},`,
    ...pyFloors(scoring.floors, 1, 'default_scoring.floors'),
    `    "vector_fetch_limit": ${asInt(scoring.vector_fetch_limit, 'default_scoring.vector_fetch_limit')},`,
    `    "vector_sample": ${renderNumber(scoring.vector_sample, 'default_scoring.vector_sample', 'vector_sample', 'py')},`,
    `    "min_fetch_weight": ${asFloat(scoring.min_fetch_weight, 'default_scoring.min_fetch_weight')},`,
    '}',
    '',
    '# Raw profile records; personality.py materialises PersonalityProfile objects',
    '# from them. "description" is the bridge text; "server_description" (present',
    "# only where the server mirror words it differently) is the server's own copy.",
    'PROFILE_DATA = {',
  ];

  for (const name of profileNames) {
    const profile = profiles[name];
    lines.push(`    ${pyString(name)}: {`);
    lines.push(`        "name": ${pyString(profile.name)},`);
    lines.push(`        "description": ${pyString(profile.description)},`);
    if (profile.serverDescription !== undefined) {
      lines.push(`        "server_description": ${pyString(profile.serverDescription)},`);
    }
    lines.push('        "weights": {');
    for (const [source, weight] of Object.entries(profile.weights)) {
      lines.push(`            ${pyString(source)}: ${asFloat(weight, `profiles.${name}.weights.${source}`)},`);
    }
    lines.push('        },');
    lines.push(`        "scoring": ${pyScoring(profile.scoring, 2, `profiles.${name}.scoring`).join('\n').trimStart()}`);
    lines.push('    },');
  }

  lines.push('}', '');
  lines.push('# Recommended token budgets per profile (from IMPLEMENTATION-PLAN.md).');
  lines.push('RECOMMENDED_BUDGETS = {');
  for (const [name, budget] of Object.entries(recommendedBudgets)) {
    lines.push(`    ${pyString(name)}: ${asInt(budget, `recommended_budgets.${name}`)},`);
  }
  lines.push('}', '');

  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  return [
    'Usage: node scripts/generate-personality-registry.mjs [--check] [--out-dir DIR]',
    '',
    'Renders shared/personality/registry.json into the two generated artifacts:',
    ...ARTIFACTS.map((artifact) => `  ${artifact.rel}`),
    '',
    '  --check        write nothing; exit non-zero if either artifact is stale',
    '  --out-dir DIR  render into DIR instead of the repository root (tests)',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { check: false, outDir: REPO_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--out-dir') {
      const value = argv[i + 1];
      if (!value) fail('--out-dir requires a directory');
      options.outDir = path.resolve(value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else fail(`unknown argument ${arg}\n\n${usage()}`);
  }
  return options;
}

function readRegistry() {
  const registryPath = path.join(REPO_ROOT, REGISTRY_REL);
  let raw;
  try {
    raw = readFileSync(registryPath, 'utf8');
  } catch (error) {
    fail(`cannot read ${REGISTRY_REL}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${REGISTRY_REL} is not valid JSON: ${error.message}`);
  }
  return validate(parsed);
}

/** First differing line, plus how many lines differ — enough to act on. */
function diffSummary(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const total = Math.max(expectedLines.length, actualLines.length);
  let differing = 0;
  let first = null;
  for (let i = 0; i < total; i += 1) {
    if (expectedLines[i] !== actualLines[i]) {
      differing += 1;
      if (first === null) {
        first = { line: i + 1, expected: expectedLines[i] ?? '<missing line>', actual: actualLines[i] ?? '<missing line>' };
      }
    }
  }
  const lines = [
    `    line ${first.line}: on disk  ${first.actual}`,
    `    line ${first.line}: generated ${first.expected}`,
    `    ${differing} of ${total} lines differ`,
  ];
  return lines.join('\n');
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const registry = readRegistry();
  const stale = [];

  for (const artifact of ARTIFACTS) {
    const content = artifact.render(registry);
    const target = path.join(options.outDir, artifact.rel);
    const display = path.relative(options.outDir, target) || artifact.rel;

    if (options.check) {
      let onDisk = null;
      try {
        onDisk = readFileSync(target, 'utf8');
      } catch {
        onDisk = null;
      }
      if (onDisk === null) {
        process.stderr.write(`✗ ${display} is missing\n`);
        stale.push(artifact.rel);
      } else if (onDisk !== content) {
        process.stderr.write(`✗ ${display} is stale\n${diffSummary(content, onDisk)}\n`);
        stale.push(artifact.rel);
      } else {
        process.stdout.write(`✓ ${display} matches a fresh generation\n`);
      }
      continue;
    }

    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    process.stdout.write(`✓ wrote ${display}\n`);
  }

  if (options.check && stale.length > 0) {
    process.stderr.write(`✗ ${stale.length} generated artifact(s) stale — run: node scripts/generate-personality-registry.mjs\n`);
    return 1;
  }
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof RegistryError) {
    process.stderr.write(`✗ registry error: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
