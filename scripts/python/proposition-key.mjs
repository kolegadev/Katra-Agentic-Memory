// Shared proposition normalisation for the Python-side compaction scripts.
// MUST match server/src/services/memory/proposition-key.ts:
//   - order-sensitive (no sorting)
//   - negations (not/no) and one-character tokens (numerals) are retained
//   - the same stopword set
import { createHash } from 'node:crypto';

export const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'from',
  'by', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'that',
  'this', 'these', 'those', 'it', 'its', 'via', 'into', 'over', 'under', 'then',
  'than', 'which', 'who', 'whom', 'has', 'have', 'had', 'do', 'does', 'did',
  'so', 'if', 'when', 'while', 'after', 'before', 'about',
]);

export function normalizeProposition(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !STOPWORDS.has(w))
    .join(' ');
}

/** Episodic key: sha256(`<event_type>:<normalized>`).slice(0, 32). */
export function episodicPropositionKey(eventType, text) {
  const normalized = normalizeProposition(text);
  if (!normalized) return null;
  return createHash('sha256').update(`${eventType}:${normalized}`).digest('hex').slice(0, 32);
}

/**
 * Semantic key: the plain normalised proposition string, with the
 * "<kind>: " prefix stripped and a four-token floor. This is exactly what
 * propositionKeyOf() writes at runtime; the compaction must not hash it.
 */
export function semanticPropositionKey(content) {
  const raw = String(content || '');
  const withoutKind = raw.replace(/^[a-z_]{2,20}:\s*/i, '');
  const normalized = normalizeProposition(withoutKind);
  if (!normalized) return null;
  return normalized.split(' ').length >= 4 ? normalized : null;
}
