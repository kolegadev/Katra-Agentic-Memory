/**
 * Unit tests: CodebaseScanner (F1)
 *
 * Builds a fixture tree under os.tmpdir() in beforeAll (rm -rf in afterAll)
 * and verifies: suffix dispatch + language mapping, noise-dir hard skips,
 * gitignore/katraignore semantics (negation, last-match-wins, trailing-slash
 * dir patterns, anchoring, parent-directory exclusion), symlink containment,
 * deterministic sorting, and two-scan change classification covering both the
 * mtime-unchanged and mtime-changed/hash-checked paths.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import {
  classifyChanges,
  scanCodebase,
} from '../../../src/services/code-graph/codebase-scanner.js';
import type { ScannedFile } from '../../../src/services/code-graph/types.js';

let root: string;
let outside: string;

/** Write a file (creating parents) under `base`; returns its absolute path. */
async function write(
  base: string,
  rel: string,
  content: string,
): Promise<string> {
  const abs = join(base, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  return abs;
}

const sha256 = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

/** relPaths of a scan result. */
const relPaths = (files: ScannedFile[]): string[] =>
  files.map((f) => f.relPath);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'katra-scanner-'));
  outside = await mkdtemp(join(tmpdir(), 'katra-scanner-outside-'));

  // ── walk-basics fixture ────────────────────────────────────────────────
  await write(root, 'walk/src/a.ts', 'const a = 1;\n');
  await write(root, 'walk/src/sub/b.js', 'let b = 2;\n');
  await write(root, 'walk/notes.md', '# Notes\n');
  await write(root, 'walk/data.json', '{"x": 1}');
  await write(root, 'walk/run.sh', '#!/bin/sh\necho hi\n');
  await write(root, 'walk/tool.mjs', 'export default 1;\n');
  await write(root, 'walk/mod.cjs', 'module.exports = 2;\n');
  await write(root, 'walk/types.mts', 'export const t = 1;\n');
  await write(root, 'walk/types.cts', 'export const c = 2;\n');
  await write(root, 'walk/view.jsx', 'export default () => null;\n');
  await write(root, 'walk/deep/nested/deep.ts', 'export const deep = true;\n');
  await write(root, 'walk/style.css', 'body {}');
  await write(root, 'walk/README', 'no extension');
  // noise dirs (hard skip)
  for (const dir of [
    'node_modules/pkg',
    '.git',
    'dist',
    'build',
    'target',
    '.venv',
    'venv',
    '__pycache__',
    '.cache',
    '.graphify',
    'graphify-out',
    '.katra-state',
    '.next',
    '.nuxt',
    '.hg',
    '.svn',
    'wheel-1.0.egg-info',
    'lib.egg-info',
  ]) {
    await write(root, `walk/${dir}/noise.ts`, 'noise');
  }

  // ── gitignore fixture ──────────────────────────────────────────────────
  await write(
    root,
    'ignore/.gitignore',
    [
      '# comment line',
      '',
      '*.md',
      '!keep.md',
      'cache-dir/',
      'src/generated.ts',
      '/anchored.ts',
      'special?.ts',
      '',
    ].join('\n'),
  );
  await write(root, 'ignore/a.md', 'a');
  await write(root, 'ignore/keep.md', 'keep');
  await write(root, 'ignore/sub/deep.md', 'deep');
  await write(root, 'ignore/cache-dir/x.ts', 'x');
  await write(root, 'ignore/cache-dir/deep/y.ts', 'y');
  await write(root, 'ignore/src/generated.ts', 'gen');
  await write(root, 'ignore/other/src/generated.ts', 'gen2');
  await write(root, 'ignore/anchored.ts', 'anch');
  await write(root, 'ignore/sub/anchored.ts', 'anch2');
  await write(root, 'ignore/specialA.ts', 'one');
  await write(root, 'ignore/specialAB.ts', 'two');
  await write(root, 'ignore/normal.ts', 'norm');

  // ── katraignore overlay fixture ────────────────────────────────────────
  await write(root, 'overlay/.gitignore', 'notes.ts\nsecret.ts\n');
  await write(root, 'overlay/.katraignore', '!notes.ts\nsecret2.ts\n');
  await write(root, 'overlay/notes.ts', 'n');
  await write(root, 'overlay/secret.ts', 's');
  await write(root, 'overlay/secret2.ts', 's2');
  await write(root, 'overlay/normal.ts', 'ok');

  // ── parent-exclusion fixture ───────────────────────────────────────────
  await write(root, 'parentex/.gitignore', 'logs/\n');
  await write(root, 'parentex/.katraignore', '!logs/keep.md\n');
  await write(root, 'parentex/logs/keep.md', 'keep');
  await write(root, 'parentex/logs/other.md', 'other');
  await write(root, 'parentex/top.md', 'top');

  // ── dir re-inclusion fixture ───────────────────────────────────────────
  await write(root, 'reincl/.gitignore', 'scratch/\n!scratch/\n');
  await write(root, 'reincl/scratch/x.ts', 'x');
  await write(root, 'reincl/normal.ts', 'ok');

  // ── symlink fixture ────────────────────────────────────────────────────
  await write(root, 'sym/real/inside.ts', 'inside content');
  await write(root, 'sym/plain.ts', 'plain content');
  await write(outside, 'external.ts', 'outside content');
  await symlink(join(root, 'sym/real/inside.ts'), join(root, 'sym/linked.ts'));
  await symlink(join(outside, 'external.ts'), join(root, 'sym/extlink.ts'));
  await symlink(join(root, 'sym/real'), join(root, 'sym/dirlink'));
  await symlink(join(root, 'sym/missing.ts'), join(root, 'sym/broken.ts'));
  await symlink(join(root, 'sym'), join(root, 'sym/cycle'));

  // ── classification fixture ─────────────────────────────────────────────
  await write(root, 'classify/alpha.ts', 'alpha');
  await write(root, 'classify/bravo.ts', 'bravo');
  await write(root, 'classify/charlie.ts', 'charlie');
  await write(root, 'classify/delta.ts', 'delta');
  await write(root, 'classify/echo.ts', 'echo');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('scanCodebase — walk basics', () => {
  const EXPECTED: Record<string, { language: string; hash: string }> = {
    'data.json': {
      language: 'json',
      hash: '613fe5aa65343dbb1b9abe6abac6773f5c91bd60d3f2ffb7e2eae69e1db8b227',
    },
    'deep/nested/deep.ts': {
      language: 'typescript',
      hash: 'b03714a00eced3de544ddaaacc7a5d1f20e222ecc413b28cdc190cff1deb73a0',
    },
    'mod.cjs': {
      language: 'javascript',
      hash: '0178ebe33198629bc345d7410d644ab4991518d537db5fd04912d281df792928',
    },
    'notes.md': {
      language: 'markdown',
      hash: '365d0b84ae63c2afc293dedd2b00bdf0dc8d6ef70c9297d90f9e5682ab0d72ee',
    },
    'run.sh': {
      language: 'shell',
      hash: '299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba',
    },
    'src/a.ts': {
      language: 'typescript',
      hash: 'b79b14bd2584dd52b0f0ef042a2a4f104cda48330500e12237737cc51fbda43d',
    },
    'src/sub/b.js': {
      language: 'javascript',
      hash: 'ada19613f658c19a429de7f337c37729428e8a1d740df83b9d9b55b20727b6cc',
    },
    'tool.mjs': {
      language: 'javascript',
      hash: '96909e1dce85ca534fd8881f6c8369a8a87e06df5a4bf81ef44a72db195b0704',
    },
    'types.cts': {
      language: 'typescript',
      hash: 'e6f151fe9639dca86e4f4641774690e925251d5d7604c9b23dbc4008abcdc188',
    },
    'types.mts': {
      language: 'typescript',
      hash: '991a4a6fc3620f839fca687c2d83a01005b91a8e34c3b3a67929cdd9d34ff815',
    },
    'view.jsx': {
      language: 'javascript',
      hash: '0f4cb4d839bac55f41d2555b3166b085a217277cf3e8854182440077fa2f0fd0',
    },
  };
  const EXPECTED_PATHS = Object.keys(EXPECTED).sort();

  it('returns only supported files, sorted by relPath, with correct metadata', async () => {
    const files = await scanCodebase(join(root, 'walk'));
    expect(relPaths(files)).toEqual(EXPECTED_PATHS);
    for (const f of files) {
      const exp = EXPECTED[f.relPath];
      expect(exp, `unexpected file: ${f.relPath}`).toBeDefined();
      expect(f.language).toBe(exp.language);
      expect(f.hash).toBe(exp.hash);
      expect(f.absPath).toBe(join(root, 'walk', f.relPath));
      const content = await readFile(f.absPath);
      expect(f.size).toBe(content.length);
      expect(f.mtimeMs).toBe(statSync(f.absPath).mtimeMs);
      expect(f.relPath).not.toMatch(/\\/);
    }
    // deterministic: a second scan yields identical results
    expect(relPaths(await scanCodebase(join(root, 'walk')))).toEqual(
      EXPECTED_PATHS,
    );
  });

  it('rejects a missing root and a non-directory root', async () => {
    await expect(
      scanCodebase(join(root, 'walk', 'does-not-exist')),
    ).rejects.toThrow(/does not exist/);
    await expect(scanCodebase(join(root, 'walk', 'README'))).rejects.toThrow(
      /not a directory/,
    );
  });
});

describe('scanCodebase — ignore rules', () => {
  it('applies gitignore semantics: negation, last-match-wins, dir patterns, anchoring, globs', async () => {
    const files = await scanCodebase(join(root, 'ignore'));
    expect(relPaths(files)).toEqual([
      'keep.md', // `!keep.md` after `*.md` — last match wins
      'normal.ts',
      'other/src/generated.ts', // slash pattern is relative to the ignore file, not any level
      'specialAB.ts', // two chars do not match `special?.ts`
      'sub/anchored.ts', // `/anchored.ts` is anchored to the root
    ]);
  });

  it('overlays .katraignore on top of .gitignore (later patterns win)', async () => {
    const files = await scanCodebase(join(root, 'overlay'));
    expect(relPaths(files)).toEqual(['normal.ts', 'notes.ts']);
  });

  it('keeps files ignored when an ancestor directory matched (parent exclusion)', async () => {
    const files = await scanCodebase(join(root, 'parentex'));
    expect(relPaths(files)).toEqual(['top.md']);
  });

  it('re-includes a directory when a later negation matches the directory itself', async () => {
    const files = await scanCodebase(join(root, 'reincl'));
    expect(relPaths(files)).toEqual(['normal.ts', 'scratch/x.ts']);
  });
});

describe('scanCodebase — symlinks', () => {
  it('includes file symlinks inside root, rejects outside/broken targets, skips dir symlinks by default', async () => {
    const files = await scanCodebase(join(root, 'sym'));
    expect(relPaths(files)).toEqual([
      'linked.ts',
      'plain.ts',
      'real/inside.ts',
    ]);
    const linked = files.find((f) => f.relPath === 'linked.ts');
    expect(linked?.hash).toBe(sha256('inside content'));
  });

  it('follows dir symlinks only with followSymlinks: true, guarded against cycles', async () => {
    const files = await scanCodebase(join(root, 'sym'), {
      followSymlinks: true,
    });
    expect(relPaths(files)).toEqual([
      'dirlink/inside.ts',
      'linked.ts',
      'plain.ts',
      'real/inside.ts',
    ]);
    // cycle → root must not recurse forever or duplicate entries
    expect(relPaths(files).filter((p) => p.startsWith('cycle'))).toEqual([]);
  });
});

describe('classifyChanges — two-scan classification', () => {
  it('classifies added/modified/unchanged/deleted across two scans (mtime + hash paths)', async () => {
    const dir = join(root, 'classify');
    const first = await scanCodebase(dir);
    const manifest = {
      root: dir,
      updatedAt: new Date().toISOString(),
      files: Object.fromEntries(
        first.map((f) => [
          f.relPath,
          { mtimeMs: f.mtimeMs, size: f.size, hash: f.hash },
        ]),
      ),
    };

    // alpha.ts: untouched → unchanged (mtime-unchanged fast path)
    // bravo.ts: same size, same mtime, different content → modified (hash check)
    const bravo = join(dir, 'bravo.ts');
    const bravoMtime = manifest.files['bravo.ts'].mtimeMs;
    await writeFile(bravo, 'BRAVO');
    await utimes(bravo, new Date(bravoMtime), new Date(bravoMtime));
    // charlie.ts: different size + newer mtime + different content → modified
    const charlie = join(dir, 'charlie.ts');
    await writeFile(charlie, 'charlie-v2!');
    await utimes(
      charlie,
      new Date(manifest.files['charlie.ts'].mtimeMs + 5000),
      new Date(manifest.files['charlie.ts'].mtimeMs + 5000),
    );
    // delta.ts: removed → deleted
    await rm(join(dir, 'delta.ts'));
    // foxtrot.ts: new → added
    await writeFile(join(dir, 'foxtrot.ts'), 'foxtrot');

    const second = await scanCodebase(dir);
    const changes = classifyChanges(manifest, second);
    expect(changes).toEqual({
      added: ['foxtrot.ts'],
      modified: ['bravo.ts', 'charlie.ts'],
      deleted: ['delta.ts'],
      unchanged: ['alpha.ts', 'echo.ts'],
      total: 5,
    });
  });

  it('treats everything as added when there is no previous manifest', async () => {
    const files = await scanCodebase(join(root, 'classify'));
    const changes = classifyChanges(null, files);
    expect(changes.added.sort()).toEqual(relPaths(files).sort());
    expect(changes.modified).toEqual([]);
    expect(changes.deleted).toEqual([]);
    expect(changes.unchanged).toEqual([]);
    expect(changes.total).toBe(files.length);
  });
});
