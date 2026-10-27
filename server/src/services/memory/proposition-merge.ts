/**
 * Pure builders for the two proposition merges (episodic events and semantic
 * facts). Keeping them here makes the write path testable and guarantees that
 * store_event and createEvent apply the same rules.
 */
import { descriptionOf, type Proposition } from './proposition-key.js';

export interface EpisodicMergeEvent {
  user_id: string;
  event_type: string;
  session_id: string;
  shared_id?: string;
  content: unknown;
  timestamp?: Date;
}

export interface SemanticMergeFact {
  content: string;
  source: string;
  confidence: number;
  tags?: string[];
  shared_id?: string;
  metadata?: Record<string, any>;
}

/** Scope an episodic merge to the exact owner and shared scope. */
export function episodicPropositionFilter(
  event: Pick<EpisodicMergeEvent, 'user_id' | 'event_type' | 'shared_id'>,
  propositionKey: string,
): Record<string, unknown> {
  return {
    user_id: event.user_id,
    event_type: event.event_type,
    proposition_key: propositionKey,
    shared_id: event.shared_id ?? null,
  };
}

/**
 * Build the pipeline update and the merged event for a proposition repeat.
 * Provenance (session, shared scope, time) is carried on the variant and the
 * survivor; the latest strategy also refreshes the content hash, idempotency
 * key and processed flag so the new content is not considered processed.
 */
export function buildEpisodicMergeUpdate(
  prior: any,
  event: EpisodicMergeEvent,
  proposition: Proposition,
  contentHash: string,
  idempotencyKey: string,
  seen: Date,
): { update: any[]; merged: any } {
  const priorDescription = descriptionOf(prior?.content) || '';
  const incoming = descriptionOf(event.content) || '';
  const variants = Array.isArray(prior?.variants) ? prior.variants : [];
  const at = event.timestamp || seen;
  const update: any[] = [
    {
      $set: {
        occurrences: { $add: [{ $ifNull: ['$occurrences', 1] }, 1] },
        last_seen_at: at,
        session_id: { $ifNull: [event.session_id, '$session_id'] },
        shared_id: { $ifNull: ['$shared_id', event.shared_id ?? null] },
        'metadata.updated_at': seen,
        'metadata.last_accessed_at': seen,
      },
    },
  ];

  if (proposition.strategy === 'latest') {
    update.push({
      $set: {
        content: event.content,
        content_hash: contentHash,
        idempotency_key: idempotencyKey,
        'metadata.processed': false,
      },
    });
  } else if (incoming && incoming !== priorDescription &&
             !variants.some((v: any) => v && v.text === incoming)) {
    update.push({
      $set: {
        variants: {
          $slice: [
            {
              $concatArrays: [
                { $ifNull: ['$variants', []] },
                [{
                  text: incoming,
                  seen_at: at,
                  session_id: event.session_id,
                  shared_id: event.shared_id ?? null,
                }],
              ],
            },
            -5,
          ],
        },
      },
    });
  }

  const merged = {
    ...prior,
    occurrences: ((prior as any)?.occurrences || 1) + 1,
    last_seen_at: at,
    session_id: event.session_id || prior?.session_id,
    shared_id: event.shared_id ?? prior?.shared_id,
    ...(proposition.strategy === 'latest'
      ? {
          content: event.content,
          content_hash: contentHash,
          idempotency_key: idempotencyKey,
          metadata: { ...(prior?.metadata || {}), processed: false },
        }
      : {}),
  };
  return { update, merged };
}

/**
 * Scope a semantic merge to the exact owner and shared scope.
 *
 * Both `proposition_key` and `proposition_norm` are matched because the two
 * write paths have used both names: the deployed runtime wrote
 * `proposition_norm`, the branch writes `proposition_key`, and compaction has
 * historically written a hash to `proposition_key`. Matching either (with the
 * same plain normal form) lets old and new rows merge without waiting for a
 * backfill.
 */
export function semanticPropositionFilter(
  fact: Pick<SemanticMergeFact, 'shared_id'>,
  userId: string,
  propositionKey: string,
): Record<string, unknown> {
  return {
    user_id: userId,
    shared_id: fact.shared_id ?? null,
    $or: [
      { proposition_key: propositionKey },
      { proposition_norm: propositionKey },
    ],
  };
}

/** Merge a re-wording into the existing fact without dropping its fields. */
export function buildSemanticMergeUpdate(fact: SemanticMergeFact): any[] {
  const factTags = Array.isArray(fact.tags) ? fact.tags : [];
  return [
    {
      $set: {
        extraction_count: { $add: [{ $ifNull: ['$extraction_count', 1] }, 1] },
        updated_at: new Date(),
        variants: { $setUnion: [{ $ifNull: ['$variants', []] }, [fact.content]] },
        confidence: {
          $cond: [
            { $gt: [fact.confidence ?? 0, { $ifNull: ['$confidence', 0] }] },
            fact.confidence ?? 0,
            { $ifNull: ['$confidence', 0] },
          ],
        },
        source: {
          $cond: [
            { $or: [{ $eq: ['$source', null] }, { $eq: ['$source', 'unknown'] }] },
            fact.source,
            '$source',
          ],
        },
        tags: { $setUnion: [{ $ifNull: ['$tags', []] }, factTags] },
        metadata: { $mergeObjects: [{ $ifNull: ['$metadata', {}] }, fact.metadata || {}] },
      },
    },
  ];
}
