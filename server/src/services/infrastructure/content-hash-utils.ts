/**
 * Shared utility for generating content hashes for episodic events.
 * Used by all event creators to ensure consistent hashing and
 * enable background processing.
 */
import crypto from 'crypto';

export function generateContentHash(eventData: {
  event_type: string;
  content: any;
  user_id: string;
  session_id: string;
}): string {
  const contentStr = JSON.stringify({
    type: eventData.event_type,
    user: eventData.user_id,
    session: eventData.session_id,
    content: typeof eventData.content === 'object'
      ? JSON.stringify(eventData.content)
      : String(eventData.content),
  });
  return crypto.createHash('sha256').update(contentStr).digest('hex').substring(0, 16);
}

export function generateIdempotencyKey(
  eventData: { event_type: string; user_id: string; session_id: string },
  contentHash: string
): string {
  return `${eventData.session_id}_${eventData.event_type}_${contentHash}`;
}

/**
 * Content-stable hash for semantic deduplication.
 *
 * Unlike generateContentHash (which folds in event_type/session/timestamp and is
 * therefore event-scoped), this hash depends ONLY on (user_id + normalised
 * content). Two store_memory calls with identical content for the same user
 * produce the same hash, enabling upsert-based dedup so re-storing the same
 * memory updates the existing document instead of creating a duplicate.
 */
export function stableContentHash(user_id: string, content: string): string {
  const normalised = `${user_id}::${content.trim()}`;
  return crypto.createHash('sha256').update(normalised).digest('hex').substring(0, 16);
}
