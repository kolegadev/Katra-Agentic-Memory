/**
 * Lazy, cached, safe loader for tree-sitter WASM grammars (F2).
 *
 * `Parser.init()` runs exactly once (module-level promise, so concurrent
 * callers never double-init) and each grammar is loaded at most once into a
 * `Map` cache. WASM paths are resolved through
 * `createRequire(import.meta.url)` so they work identically from `src/`, the
 * esbuild output, and vitest.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Language, Parser } from 'web-tree-sitter';

/** Grammar kinds supported by the F2 extractor. */
export type GrammarKind = 'javascript' | 'typescript' | 'tsx' | 'python';

const require = createRequire(import.meta.url);

/** Package + WASM filename for each grammar kind. */
const GRAMMAR_WASM: Record<GrammarKind, [string, string]> = {
  javascript: ['tree-sitter-javascript', 'tree-sitter-javascript.wasm'],
  typescript: ['tree-sitter-typescript', 'tree-sitter-typescript.wasm'],
  tsx: ['tree-sitter-typescript', 'tree-sitter-tsx.wasm'],
  python: ['tree-sitter-python', 'tree-sitter-python.wasm'],
};

/** Resolve a grammar package's WASM file, tolerating restrictive `exports` maps. */
function resolveWasm([pkg, wasmFile]: [string, string]): string {
  try {
    return require.resolve(`${pkg}/${wasmFile}`);
  } catch {
    const pkgJson = require.resolve(`${pkg}/package.json`);
    return join(dirname(pkgJson), wasmFile);
  }
}

let initPromise: Promise<void> | null = null;

/** Await the one-time `Parser.init()`; the module-level promise prevents double-init. */
function ensureParserInit(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

const grammarCache = new Map<GrammarKind, Promise<Language>>();

/**
 * Load (and cache) the tree-sitter language for `kind`. Concurrent calls for
 * the same kind share one load; a load failure rejects every waiter and the
 * failed entry is not cached, so a later call retries.
 */
export function loadGrammar(kind: GrammarKind): Promise<Language> {
  let pending = grammarCache.get(kind);
  if (!pending) {
    pending = ensureParserInit().then(() =>
      Language.load(resolveWasm(GRAMMAR_WASM[kind])),
    );
    pending.catch(() => {
      if (grammarCache.get(kind) === pending) grammarCache.delete(kind);
    });
    grammarCache.set(kind, pending);
  }
  return pending;
}
