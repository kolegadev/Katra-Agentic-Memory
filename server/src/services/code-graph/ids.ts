/**
 * Canonical node-ID normalization (Graphify `ids.py` semantics, see
 * CONTRACT.md §Goal): NFKC-normalize, replace runs of non-word characters
 * with `_`, collapse repeated `_`, strip leading/trailing `_`, casefold.
 *
 * Three producers of node IDs (extractor, graph builder, future semantic
 * layers) must agree on this recipe or one entity splits into ghost nodes,
 * so it lives here as the single source of truth.
 */

/** Normalize a single ID string to its canonical form (idempotent). */
export function normalizeId(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * Build a canonical node ID from one or more parts. Parts are joined with `_`
 * after stripping stray `_`/`.` from each part's edges (empty parts skipped);
 * the joined string then goes through {@link normalizeId}.
 */
export function makeId(...parts: string[]): string {
  return normalizeId(
    parts
      .filter((p) => p !== '')
      .map((p) => p.replace(/^[_.]+|[_.]+$/g, ''))
      .join('_'),
  );
}
