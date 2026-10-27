/**
 * Extraction deltas — distil only what is new in a session.
 *
 * Why this exists (2026-10-22): the background processor extracts every
 * conversation event independently, but a session that re-writes a growing
 * transcript hands the extractor the same prefix on every turn. The same facts
 * were therefore re-derived, re-stored and merged again and again — measured at
 * 946,688 rows for 437,026 propositions before the first pass, and still
 * forming after it.
 *
 * The rule: a session has a cursor. If the new text starts with exactly the
 * prefix the cursor already consumed and is longer, only the suffix is new and
 * only the suffix is extracted. If it is shorter or the prefix changed (an
 * edited transcript, a different document), extract the whole thing and reset.
 *
 * This is the same idea as caching an LLM prefix instead of re-sending it: pay
 * once for the invariant, pay again only for the delta.
 */
import { createHash } from 'crypto';

export interface ExtractionCursor {
  prefix_hash: string;
  /**
   * How many characters the hash covers. Stored because a text shorter than
   * the window would otherwise hash its whole self, and then any growth would
   * look like a different document — the bug this field exists to prevent.
   */
  prefix_chars?: number;
  content_length: number;
  updated_at?: Date;
}

export interface DeltaPlan {
  /** `full` = nothing consumed yet or content changed; `delta` = suffix only;
   *  `skip` = this text is already covered (or too little is new to matter). */
  mode: 'full' | 'delta' | 'skip';
  text: string;
  reason: string;
}

/** How much of the text identifies "the same document, continued". */
const PREFIX_CHARS = 2048;

export function prefixHash(text: string, chars: number = PREFIX_CHARS): string {
  const width = Math.max(0, Math.min(chars, text.length));
  return createHash('sha256').update(text.slice(0, width)).digest('hex').slice(0, 32);
}

/**
 * Decide what to extract for `text`, given what this session already consumed.
 * `minDeltaChars` keeps us from spending an LLM call on a trailing newline or a
 * one-word append.
 */
export function planExtractionDelta(
  text: string,
  cursor: ExtractionCursor | null | undefined,
  minDeltaChars = 50,
): DeltaPlan {
  if (!text || !text.trim()) return { mode: 'skip', text: '', reason: 'empty' };
  if (!cursor || !cursor.prefix_hash) return { mode: 'full', text, reason: 'no_cursor' };

  const width = cursor.prefix_chars ?? PREFIX_CHARS;
  if (prefixHash(text, width) !== cursor.prefix_hash) {
    return { mode: 'full', text, reason: 'prefix_changed' };
  }

  if (text.length <= cursor.content_length) {
    // Same document, no longer than what was consumed: nothing new.
    return { mode: 'skip', text: '', reason: 'already_extracted' };
  }

  const delta = text.slice(cursor.content_length).trim();
  if (delta.length < minDeltaChars) {
    return { mode: 'skip', text: '', reason: 'delta_too_small' };
  }
  return { mode: 'delta', text: delta, reason: 'new_suffix' };
}

/** The cursor to store once `text` has been consumed in full. */
export function nextCursor(text: string, at: Date = new Date()): ExtractionCursor {
  const chars = Math.min(PREFIX_CHARS, text.length);
  return {
    prefix_hash: prefixHash(text, chars),
    prefix_chars: chars,
    content_length: text.length,
    updated_at: at,
  };
}
