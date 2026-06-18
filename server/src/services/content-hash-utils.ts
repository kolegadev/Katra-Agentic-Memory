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
