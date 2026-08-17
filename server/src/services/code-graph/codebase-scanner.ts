/**
 * Codebase scanner (F1) — deterministic recursive walk of a source tree with
 * noise-dir hard skips, `.gitignore`/`.katraignore` ignore semantics, symlink
 * containment, and SHA-256 content hashing.
 *
 * Dependency-free: only `node:crypto`, `node:fs`, `node:path`.
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { ChangeSet, ScanManifest, ScannedFile } from './types.js';

/** Directory names that are hard-skipped during the walk (never re-includable). */
const NOISE_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'venv',
  '.venv',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '__pycache__',
  '.graphify',
  'graphify-out',
  '.katra-state',
  '.cache',
]);

/** Glob-style noise names: any basename matching `*.egg-info` is skipped. */
const NOISE_GLOB = /\.egg-info$/;

/** Supported file suffixes (lowercase) mapped to their language tag. */
const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  json: 'json',
  md: 'markdown',
  sh: 'shell',
};

/** VCS markers that stop the ignore-file ancestor walk (exclusive stop is not used; inclusive). */
const VCS_MARKERS = ['.git', '.hg', '.svn'];

interface IgnorePattern {
  /** Glob body: no leading `/`, no trailing `/`, no `!` prefix. */
  pattern: string;
  /** `!` prefix — a match re-includes instead of excluding. */
  negated: boolean;
  /** Trailing `/` — only matches directories. */
  dirOnly: boolean;
  /** Leading `/` — anchored to the ignore file's directory. */
  anchored: boolean;
}

interface IgnoreLevel {
  /** Absolute directory the ignore files were read from. */
  base: string;
  /** Posix path of the scan root relative to `base` ('' when base is the root). */
  rootRel: string;
  /** Patterns in precedence order: `.gitignore` first, `.katraignore` overlay last. */
  patterns: IgnorePattern[];
}

/** Escape a single character for use inside a RegExp. */
function escapeChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/**
 * Translate a gitignore-style glob (posix, no leading/trailing slash) into a
 * RegExp. `*` never crosses `/`, `?` matches one non-slash char, `**` crosses
 * directories, `[...]` character classes are supported.
 */
function globToRegex(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) {
      re += escapeChar(glob[i + 1]);
      i++;
    } else if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i + 1) {
        let body = glob.slice(i + 1, end);
        if (body[0] === '!' || body[0] === '^') body = `^${body.slice(1)}`;
        re += `[${body.replace(/[\\\]\[]/g, '\\$&')}]`;
        i = end;
      } else {
        re += '\\[';
      }
    } else {
      re += escapeChar(c);
    }
  }
  re += '$';
  return new RegExp(re);
}

/** Parse one ignore file's text into ordered patterns (gitignore syntax). */
function parseIgnoreFile(content: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  for (let raw of content.split(/\r?\n/)) {
    raw = raw.replace(/[ \t]+$/, '');
    if (raw === '' || raw.startsWith('#')) continue;
    let negated = false;
    if (raw.startsWith('!')) {
      negated = true;
      raw = raw.slice(1);
    } else if (raw.startsWith('\\!') || raw.startsWith('\\#')) {
      raw = raw.slice(1);
    }
    let dirOnly = false;
    if (raw.endsWith('/')) {
      dirOnly = true;
      raw = raw.slice(0, -1);
    }
    let anchored = false;
    if (raw.startsWith('/')) {
      anchored = true;
      raw = raw.slice(1);
    }
    if (raw === '') continue;
    patterns.push({ pattern: raw, negated, dirOnly, anchored });
  }
  return patterns;
}

/** Read and parse an ignore file, returning [] when absent or unreadable. */
async function readIgnoreLevelFile(absPath: string): Promise<IgnorePattern[]> {
  try {
    const content = await readFile(absPath, 'utf8');
    return parseIgnoreFile(content);
  } catch {
    return [];
  }
}

/** Convert an absolute-ish path to posix separators. */
function posixify(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Collect ignore levels: the scan root plus ancestor directories, walking up
 * until a VCS root (`.git`/`.hg`/`.svn`) is found or the filesystem root is
 * reached. Each level parses `.gitignore` then `.katraignore` (overlay — later
 * patterns win over earlier ones).
 */
async function collectIgnoreLevels(rootAbs: string): Promise<IgnoreLevel[]> {
  const levels: IgnoreLevel[] = [];
  let dir = rootAbs;
  const fsRoot = parse(dir).root;
  for (;;) {
    let vcsFound = false;
    for (const marker of VCS_MARKERS) {
      try {
        await lstat(join(dir, marker));
        vcsFound = true;
        break;
      } catch {
        /* marker absent */
      }
    }
    const patterns = [
      ...(await readIgnoreLevelFile(join(dir, '.gitignore'))),
      ...(await readIgnoreLevelFile(join(dir, '.katraignore'))),
    ];
    if (patterns.length > 0) {
      levels.push({
        base: dir,
        rootRel: posixify(relative(dir, rootAbs)),
        patterns,
      });
    }
    if (vcsFound || dir === fsRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Shallowest ancestor first, scan root last → "last match wins" prefers the
  // most specific (deepest) ignore file and the `.katraignore` overlay.
  return levels.reverse();
}

/**
 * Check whether a pattern matches `rel` (posix, relative to the pattern's own
 * directory) or any ancestor directory prefix of it. Dir-only patterns only
 * match directory prefixes; unanchored slash-less patterns match any path
 * segment (gitignore basename matching).
 */
function matchesPattern(
  p: IgnorePattern,
  rel: string,
  isDir: boolean,
): boolean {
  if (rel === '' || rel === '.') return false;
  const segments = rel.split('/');
  const re = globToRegex(p.pattern);
  for (let k = 1; k <= segments.length; k++) {
    const prefixIsDir = k < segments.length || isDir;
    if (p.dirOnly && !prefixIsDir) continue;
    if (p.anchored || p.pattern.includes('/')) {
      if (re.test(segments.slice(0, k).join('/'))) return true;
    } else if (re.test(segments[k - 1])) {
      return true;
    }
  }
  return false;
}

/** Evaluate all ignore levels in order (last match wins) for one path. */
function evaluateIgnored(
  levels: IgnoreLevel[],
  rel: string,
  isDir: boolean,
): boolean {
  let ignored = false;
  for (const level of levels) {
    const relFromBase = level.rootRel ? `${level.rootRel}/${rel}` : rel;
    for (const p of level.patterns) {
      if (matchesPattern(p, relFromBase, isDir)) ignored = !p.negated;
    }
  }
  return ignored;
}

/** Hard-skip check: noise dirs and `*.egg-info` names are never scanned. */
function isNoiseName(name: string): boolean {
  return NOISE_DIRS.has(name) || NOISE_GLOB.test(name);
}

/** Suffix dispatch: return the language tag or null for unsupported files. */
function languageFor(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return LANGUAGES[ext] ?? null;
}

/** Containment check: is `target` (absolute, already realpath'd) inside `rootReal`? */
function isInsideRoot(rootReal: string, target: string): boolean {
  const rel = relative(rootReal, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

interface WalkState {
  levels: IgnoreLevel[];
  followSymlinks: boolean;
  rootReal: string;
  visitedDirTargets: Set<string>;
  results: ScannedFile[];
}

/** Hash + stat one accepted file and append it to the results. */
async function recordFile(
  state: WalkState,
  absPath: string,
  relPath: string,
): Promise<void> {
  try {
    const [st, content] = await Promise.all([stat(absPath), readFile(absPath)]);
    const hash = createHash('sha256').update(content).digest('hex');
    state.results.push({
      relPath,
      absPath,
      size: st.size,
      mtimeMs: st.mtimeMs,
      hash,
      language: languageFor(relPath) ?? '',
    });
  } catch {
    /* unreadable file — skip without failing the scan */
  }
}

/** Recursive directory walk. */
async function walk(
  state: WalkState,
  dirAbs: string,
  dirRel: string,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const abs = join(dirAbs, entry.name);
    const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
    if (isNoiseName(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(abs);
      } catch {
        continue; // broken symlink
      }
      const targetStat = await stat(target).catch(() => null);
      if (!targetStat) continue;
      if (targetStat.isDirectory()) {
        if (!state.followSymlinks || !isInsideRoot(state.rootReal, target))
          continue;
        if (state.visitedDirTargets.has(target)) continue; // cycle guard
        state.visitedDirTargets.add(target);
        await walk(state, abs, rel);
      } else if (isInsideRoot(state.rootReal, target)) {
        await recordFile(state, abs, rel);
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (evaluateIgnored(state.levels, rel, true)) continue;
      await walk(state, abs, rel);
    } else if (entry.isFile()) {
      if (evaluateIgnored(state.levels, rel, false)) continue;
      if (!languageFor(entry.name)) continue;
      await recordFile(state, abs, rel);
    }
  }
}

/**
 * Recursively scan `root` and return one {@link ScannedFile} per supported
 * file, sorted by relPath. Skips noise dirs, applies gitignore-style ignore
 * rules from `.gitignore`/`.katraignore` (scan root + ancestors up to a VCS
 * root), and includes file symlinks only when their realpath target lives
 * inside the root. Dir symlinks are followed only when `followSymlinks` is
 * true (target containment + cycle guard still apply).
 */
export async function scanCodebase(
  root: string,
  opts?: { followSymlinks?: boolean },
): Promise<ScannedFile[]> {
  const rootAbs = resolve(root);
  const rootStat = await stat(rootAbs).catch(() => null);
  if (!rootStat) throw new Error(`Scan root does not exist: ${rootAbs}`);
  if (!rootStat.isDirectory())
    throw new Error(`Scan root is not a directory: ${rootAbs}`);
  const rootReal = await realpath(rootAbs);
  const state: WalkState = {
    levels: await collectIgnoreLevels(rootAbs),
    followSymlinks: opts?.followSymlinks === true,
    rootReal,
    visitedDirTargets: new Set([rootReal]),
    results: [],
  };
  await walk(state, rootAbs, '');
  state.results.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  return state.results;
}

/**
 * Classify a fresh scan against a previously persisted manifest. A file is
 * added when its relPath is missing from the manifest, unchanged when mtime,
 * size and hash all match, modified when the content hash differs, and
 * deleted when a manifest key is absent from the current scan.
 */
export function classifyChanges(
  prev: ScanManifest | null,
  current: ScannedFile[],
): ChangeSet {
  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];
  const deleted: string[] = [];
  const seen = new Set<string>();
  for (const f of current) {
    seen.add(f.relPath);
    const prior = prev?.files[f.relPath];
    if (!prior) {
      added.push(f.relPath);
    } else if (
      prior.mtimeMs === f.mtimeMs &&
      prior.size === f.size &&
      prior.hash === f.hash
    ) {
      unchanged.push(f.relPath);
    } else if (prior.hash !== f.hash) {
      modified.push(f.relPath);
    } else {
      unchanged.push(f.relPath); // metadata-only change (e.g. touch) — content identical
    }
  }
  if (prev) {
    for (const key of Object.keys(prev.files)) {
      if (!seen.has(key)) deleted.push(key);
    }
    deleted.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return { added, modified, deleted, unchanged, total: current.length };
}
