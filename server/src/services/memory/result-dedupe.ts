/**
 * Collapse near-identical results before returning a page.
 *
 * Why (2026-10-23): `search_memories` has always collapsed identical snippets,
 * but `vector_search` never did. With the store holding paraphrase variants of
 * the same proposition, a semantic query returned three rewordings of one
 * insight in the top three slots, which reads as three recollections and is
 * actually one.
 *
 * The key is the proposition when the row has one (`proposition_key`, written
 * by add_semantic_fact since 2026-10-22; older callers may pass
 * `proposition_norm`), and a normalised content prefix otherwise, so old rows
 * and new rows collapse against the same rule.
 *
 * This is a presentation fix, not a data fix: it changes which rows a page
 * shows, never what is stored.
 */

export interface DedupeCandidate {
  proposition_norm?: string | null;
  proposition_key?: string | null;
  content?: string | null;
}

/**
 * Normalise a content prefix for comparison: lowercase, punctuation to space,
 * collapse whitespace, keep the first `width` characters.
 */
export function contentPrefixKey(content: string | null | undefined, width = 80): string {
  const normalised = String(content ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalised.slice(0, width);
}

/** The identity used to decide whether two results are the same proposition. */
export function nearDuplicateKey(item: DedupeCandidate, width = 80): string {
  const proposition = String(item.proposition_norm || item.proposition_key || '').trim();
  if (proposition) return `p:${proposition}`;
  const prefix = contentPrefixKey(item.content, width);
  return `c:${prefix}`;
}

/**
 * Keep the first (highest-ranked) result per proposition, up to `limit`.
 * Input order is preserved, so the caller must sort before calling.
 */
export function collapseNearDuplicates<T extends DedupeCandidate>(
  items: T[],
  limit: number,
  width = 80,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = nearDuplicateKey(item, width);
    // An empty key means no content at all; those rows cannot be distinguished,
    // so collapse them rather than flooding the page with blanks.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
