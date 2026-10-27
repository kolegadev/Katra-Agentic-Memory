/**
 * Proposition keys — the delta-capture rule for distilled episodic events.
 *
 * Why this exists (2026-10-21, John + Lilly): the episodic store re-derives the
 * same propositions whenever a session is re-read. Each copy carries a fresh
 * `extracted_at`, and the content hash hashes the WHOLE payload, so it never
 * matches: the rows accumulate as near-clones — same meaning, new timestamp,
 * often a paraphrase ("Get from Satori …" then "Obtain from Satori …").
 *
 * Measured on 2026-10-21 before this rule: the description-bearing event types
 * held 946,688 rows that collapse to 437,026 propositions — 53.8% redundant —
 * and 90% of sampled `decision` rows had a high-overlap neighbour. Near
 * duplicates are the worst case for retrieval: lexically and semantically the
 * candidates are all almost the same, so a search returns a wall of clones
 * instead of a set of distinct recollections.
 *
 * The rule: a distilled event's identity is its proposition, not its bytes.
 * Normalise the description (case, punctuation, stopwords) while preserving
 * negation, numerals and token order, hash that, and treat a repeat as an
 * OCCURRENCE of the same event — incrementing a counter and recording a
 * variant — instead of inserting a new row. Volatile fields are deliberately
 * excluded, because they are exactly what made every copy unique.
 *
 * This is the episodic equivalent of caching a prefix instead of re-sending the
 * whole context: store the delta, keep one record of the invariant.
 */
import { createHash } from 'crypto';

/**
 * Event types that carry a proposition worth merging. Everything else is a raw
 * observation whose repetition is itself meaningful (a health sample, a message,
 * a watcher tick) and must never be collapsed.
 */
const RAW_EVENT_TYPES = new Set([
  'conversation',
  'agent_message',
  'user_communication',
  'machine_health',
  'gas_law_watcher_cycle',
  'heartbeat_action',
  'executive_action',
  'action',
  'tool_call',
  'system',
]);

/**
 * Words that carry no propositional content. Kept small and generic on purpose:
 * removing too much would merge distinct facts, which is worse than keeping a
 * duplicate. Negations (`not`, `no`) are deliberately NOT stopwords: "did not
 * fail" and "did fail" are different propositions.
 */
export const PROPOSITION_STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'from',
  'by', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'that',
  'this', 'these', 'those', 'it', 'its', 'via', 'into', 'over', 'under', 'then',
  'than', 'which', 'who', 'whom', 'has', 'have', 'had', 'do', 'does', 'did',
  'so', 'if', 'when', 'while', 'after', 'before', 'about',
]);

export interface Proposition {
  key: string;
  normalized: string;
  tokens: number;
  /**
   * Which copy survives the merge. Prose propositions keep the FIRST wording
   * (it is the original statement of the fact). Structured decisions keep the
   * LATEST, because their rationale carries the current evidence.
   */
  strategy: 'first' | 'latest';
}

/** Extract the description an event's proposition is built from. */
export function descriptionOf(content: unknown): string | null {
  if (!content) return null;
  if (typeof content === 'string') return content.trim() || null;
  if (typeof content !== 'object') return null;
  const c = content as Record<string, unknown>;
  for (const field of ['description', 'summary', 'message'] as const) {
    const v = c[field];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Order-sensitive normal form: lowercased, punctuation stripped, stopwords
 * dropped, token order preserved. Negations (`not`, `no`) and one-character
 * tokens (numerals such as `1`) are retained: "did not fail" and "did fail"
 * must not share a key, and "version 1" and "version 2" must not either. The
 * cost is that a re-wording which reorders the tokens no longer merges; that is
 * the safer failure — a duplicate is better than a false merge.
 */
export function normalizeProposition(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !PROPOSITION_STOPWORDS.has(w))
    .join(' ');
}

/**
 * Return the proposition for an event, or null when it should not be merged.
 * A minimum of four content tokens is required: short descriptions ("done",
 * "retry later") are too generic to be treated as the same proposition.
 */
export function propositionOf(
  eventType: string,
  content: unknown,
  minTokens = 4,
): Proposition | null {
  if (RAW_EVENT_TYPES.has(eventType)) return null;

  // Structured decisions identify themselves by subject and action, not by
  // prose: `gas_law_train_decision` records the same cell decision every cycle
  // with refreshed evidence (107,266 rows -> 413 decisions, measured
  // 2026-10-21). The newest rationale is the current truth, so keep the latest.
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    const cell = c.cell_id ?? c.cell_name;
    const action = c.action;
    if (cell !== undefined && typeof action === 'string' && action.trim()) {
      const normalized = `cell:${String(cell)}|action:${action.trim().toLowerCase()}`;
      return {
        key: createHash('sha256').update(`${eventType}:${normalized}`).digest('hex').slice(0, 32),
        normalized,
        tokens: 3,
        strategy: 'latest',
      };
    }
  }

  const description = descriptionOf(content);
  if (!description || description.length < 12) return null;
  const normalized = normalizeProposition(description);
  const tokens = normalized ? normalized.split(' ').length : 0;
  if (tokens < minTokens) return null;
  return {
    key: createHash('sha256').update(`${eventType}:${normalized}`).digest('hex').slice(0, 32),
    normalized,
    tokens,
    strategy: 'first',
  };
}

/** True when an event type is one the merge rule may collapse. */
/**
 * Proposition key for a semantic fact's text, or null when the text is too
 * short to identify a proposition.
 *
 * Four content tokens is the floor: below it two different facts look the same
 * ("done", "retry later", "ok"), and merging those is worse than keeping a
 * duplicate. Above the floor, a re-wording of the same proposition normalises
 * to the same key and is recorded as an occurrence instead of a new row.
 */
export function propositionKeyOf(content: string | null | undefined): string | null {
  const raw = String(content || '');
  // Semantic-fact contents are written as "<kind>: <value>" (see
  // dispatch-service). The kind is metadata, not part of the proposition:
  // without stripping it the same sentence stored as `insight: X`,
  // `fact: X` and `preference: X` keys three ways, and that proliferation
  // was itself one of the duplicate patterns (measured 2026-10-22).
  const withoutKind = raw.replace(/^[a-z_]{2,20}:\s*/i, '');
  const normalized = normalizeProposition(withoutKind);
  if (!normalized) return null;
  return normalized.split(' ').length >= 4 ? normalized : null;
}

export function isMergeableEventType(eventType: string): boolean {
  return !RAW_EVENT_TYPES.has(eventType);
}
