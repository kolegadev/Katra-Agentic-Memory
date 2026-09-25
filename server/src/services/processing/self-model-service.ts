import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { get_database } from '../../database/connection.js';
import { getEpisodicEventManager } from '../memory/episodic-event-manager.js';
import {
  AGENT_BELIEFS_UNIQUE_INDEX,
  AGENT_BELIEFS_UNIQUE_KEYS,
  SELF_MODEL_COLLECTIONS,
  ensureSelfModelIndexes,
} from './self-model-collections.js';
import type { PhilosophicalInsight, KnowledgeNode, KnowledgeRelationship } from '../../types/memory.js';
import type { Db, Collection } from 'mongodb';

export interface IdentityKernelResult {
  narrative: string;
  insights: Array<{
    insight_text: string;
    domain: string;
    confidence: number;
    status: string;
  }>;
}

export interface MindWanderResult {
  path: string[];
  narrative: string;
  stored_event_id: string | null;
}

export interface AgentBelief {
  proposition: string;
  confidence: number;
  source: string;
  last_updated: Date;
}

export interface ProceduralTemplate {
  toolName: string;
  inputShape: string;
  frequency: number;
  avgSuccess: number;
}

/** A persisted `procedural_patterns` row as the service exposes it. */
export interface ProceduralPattern extends ProceduralTemplate {
  /** Type-sensitive hash of the input shape — the row's identity within a tool. */
  shapeHash: string;
  successes: number;
  lastSeen: Date;
}

export interface ProceduralFlushResult {
  patterns_written: number;
  errors: string[];
}

/**
 * What `resetProceduralCache()` did, on top of the flush it performed.
 *
 * `cleared: false` means the flush failed, so the pending observations were
 * KEPT: they exist nowhere else yet, and dropping the cache would destroy them
 * (the shutdown path used to clear the cache whatever the store did).
 */
export interface ProceduralCacheResetResult extends ProceduralFlushResult {
  cleared: boolean;
}

/**
 * Whether an identity's stored patterns could actually be read. `ok: false`
 * leaves the identity un-hydrated (the next read retries) and `reason` says
 * why, so callers can report it instead of writing over totals they never saw.
 */
type HydrationOutcome = { ok: true } | { ok: false; reason: string };

/** What one run of `dedupeAgentBeliefs()` did (and removed). */
export interface BeliefDedupeResult {
  /** Distinct `{user_id, entity_name, proposition}` key groups seen. */
  groups_scanned: number;
  /** Groups holding more than one document. */
  duplicate_groups: number;
  /** Documents beyond the winner inside those groups. */
  duplicates_found: number;
  /** Documents actually deleted by this run. */
  documents_removed: number;
  /** Groups this run removed at least one document from. */
  groups_touched: number;
  /** Duplicate documents skipped because they carry no `_id` (never expected). */
  documents_without_id: number;
  index_name: string;
  /** True when *this* run created the unique index. */
  index_created: boolean;
  /**
   * True when a same-named index that did NOT enforce the unique key (wrong key
   * or not unique), or an identically-keyed unique index under another name, was
   * dropped before the declared one was created.
   */
  index_replaced: boolean;
  /** True when the unique index is in place after the run. */
  index_present: boolean;
  errors: string[];
}

export const PROCEDURAL_THRESHOLD = 5;

/** How long a recorded pattern is batched before it is written to the store. */
const PROCEDURAL_FLUSH_DELAY_MS = 250;

function hashInputShape(input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  const shape: Record<string, string> = {};
  for (const key of keys) {
    shape[key] = typeof input[key];
  }
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

/** The human-readable shape shown by `get_procedural_templates`. */
function describeInputShape(input: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(input ?? {}).sort());
}

/**
 * Cache key for one `{identity, tool, shape}` triple — the identity is part of
 * it, so identities never share a bucket.
 *
 * The segments are LENGTH-PREFIXED, not merely joined: a separator (or NUL)
 * join is ambiguous because identities and tool names are caller-supplied, so
 * identity `a\0b` + tool `c` and identity `a` + tool `b\0c` produced the same
 * string and merged two different triples (two identities' and two tools'
 * counters) into one bucket. With `len:segment|…` the encoding is injective:
 * distinct triples can never collide.
 *
 * This key lives only in this process — the persisted row is keyed by the real
 * `{user_id, tool_name, input_shape}` fields, so no stored data depends on it.
 */
function proceduralCacheKey(userId: string, toolName: string, shapeHash: string): string {
  return `${userId.length}:${userId}|${toolName.length}:${toolName}|${shapeHash}`;
}

interface ProceduralCacheEntry {
  userId: string;
  toolName: string;
  shapeHash: string;
  /** Readable key list, e.g. `["query","limit"]`. */
  inputShape: string;
  frequency: number;
  successes: number;
  avgSuccess: number;
  lastSeen: Date;
  /** Increments not yet confirmed written to `procedural_patterns`. */
  pendingFrequency: number;
  pendingSuccesses: number;
}

function recomputeAvgSuccess(entry: Pick<ProceduralCacheEntry, 'frequency' | 'successes' | 'avgSuccess'>): number {
  return entry.frequency > 0 ? entry.successes / entry.frequency : 0;
}

function identityOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ── agent_beliefs dedupe migration ─────────────────────────────────────
// Beliefs became identity-scoped, so `agent_beliefs` gains the unique key
// `{user_id, entity_name, proposition}`. Older deployments can hold several
// rows for one key (the legacy write path was entity-keyed and hardcoded
// identity-less `user_id` value `default`), and a unique index cannot be built over them. This
// migration counts the duplicates, collapses each key group deterministically
// (highest confidence, then newest last_updated, then lowest `_id`), reports
// how many documents it removed and how many groups it touched, and creates
// the index only afterwards. Running it again is a no-op: it reports zeros and
// writes nothing.

function beliefGroupKey(doc: any): string {
  const normalize = (value: unknown): string | null =>
    value === undefined || value === null ? null : String(value);
  return JSON.stringify([
    normalize(doc?.user_id),
    normalize(doc?.entity_name),
    normalize(doc?.proposition),
  ]);
}

function beliefConfidence(doc: any): number {
  const value = Number(doc?.confidence);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function beliefUpdatedAt(doc: any): number {
  const raw = doc?.last_updated;
  const value = raw instanceof Date ? raw.getTime() : Date.parse(String(raw ?? ''));
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function docIdString(id: unknown): string {
  if (id === undefined || id === null) return '';
  if (typeof id === 'string') return id;
  const hexable = id as { toHexString?: () => string };
  if (typeof hexable.toHexString === 'function') return hexable.toHexString();
  return String(id);
}

/** Highest confidence, then newest `last_updated`, then lowest `_id`. */
function isBetterBelief(candidate: any, incumbent: any): boolean {
  const candidateConfidence = beliefConfidence(candidate);
  const incumbentConfidence = beliefConfidence(incumbent);
  if (candidateConfidence !== incumbentConfidence) return candidateConfidence > incumbentConfidence;

  const candidateUpdated = beliefUpdatedAt(candidate);
  const incumbentUpdated = beliefUpdatedAt(incumbent);
  if (candidateUpdated !== incumbentUpdated) return candidateUpdated > incumbentUpdated;

  return docIdString(candidate?._id) < docIdString(incumbent?._id);
}

function pickBeliefWinner(group: any[]): any {
  let winner = group[0];
  for (const doc of group.slice(1)) {
    if (isBetterBelief(doc, winner)) winner = doc;
  }
  return winner;
}

/** Exact, order-sensitive comparison of a listed index key against the expected one. */
function sameIndexKey(actual: unknown, expected: Record<string, number>): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const actualEntries = Object.entries(actual as Record<string, unknown>);
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([field, direction], position) =>
        actualEntries[position]?.[0] === field && actualEntries[position]?.[1] === direction,
    )
  );
}

/**
 * What the collection's index listing says about the unique belief key.
 *
 *   - `present`    — an index carries the declared name, `unique: true` and
 *                    exactly the key `{user_id, entity_name, proposition}`;
 *   - `replace`    — an index with that NAME does not enforce the constraint
 *                    (wrong key or not unique), or an identically-keyed unique
 *                    index exists under a DIFFERENT name. Either way nothing
 *                    enforcing the declared key is in place, so the migration
 *                    must drop it by name and create the real one;
 *   - `absent`     — nothing matching; create the declared index;
 *   - `unlistable` — the store cannot list indexes; let `createIndex` decide.
 *
 * Presence is STRUCTURAL: a name is a label, not a constraint. Treating the
 * name alone as proof of the index is what let a non-unique look-alike pass as
 * present and left duplicate beliefs insertable.
 */
type BeliefUniqueIndexState =
  | { kind: 'present' }
  | { kind: 'replace'; name: string; reason: string }
  | { kind: 'absent' }
  | { kind: 'unlistable' };

async function classifyBeliefUniqueIndex(collection: Collection): Promise<BeliefUniqueIndexState> {
  const list = (collection as unknown as { indexes?: () => Promise<any[]> }).indexes;
  if (typeof list !== 'function') return { kind: 'unlistable' };

  let indexes: any[];
  try {
    const listed = await list.call(collection);
    if (!Array.isArray(listed)) return { kind: 'unlistable' };
    indexes = listed;
  } catch {
    // No listing support (or no collection yet) — let `createIndex` decide.
    return { kind: 'unlistable' };
  }

  const named = indexes.find((index) => index?.name === AGENT_BELIEFS_UNIQUE_INDEX);
  if (named) {
    if (named.unique === true && sameIndexKey(named.key, AGENT_BELIEFS_UNIQUE_KEYS)) {
      return { kind: 'present' };
    }
    return {
      kind: 'replace',
      name: AGENT_BELIEFS_UNIQUE_INDEX,
      reason:
        `index ${AGENT_BELIEFS_UNIQUE_INDEX} exists but does not enforce it ` +
        `(unique: ${named.unique === true}, key: ${JSON.stringify(named.key)})`,
    };
  }

  // An identically-keyed unique index under another name enforces the
  // constraint, but not under the declared name — and MongoDB refuses to build
  // a second index with the same key spec. Index initialisation would drop it
  // anyway, so it is replaced here too, explicitly rather than silently.
  const equivalent = indexes.find(
    (index) => index?.unique === true && sameIndexKey(index.key, AGENT_BELIEFS_UNIQUE_KEYS),
  );
  if (equivalent) {
    return {
      kind: 'replace',
      name: String(equivalent.name),
      reason: `index ${String(equivalent.name)} enforces the unique key under another name`,
    };
  }

  return { kind: 'absent' };
}

/** Drop one index by name; the store must support it (the listing just showed it). */
async function dropBeliefIndex(collection: Collection, name: string): Promise<void> {
  const drop = (collection as unknown as { dropIndex?: (name: string) => Promise<unknown> })
    .dropIndex;
  if (typeof drop !== 'function') {
    throw new Error(`the store cannot drop index ${name} (no dropIndex)`);
  }
  await drop.call(collection, name);
}

/**
 * Collapse duplicate `{user_id, entity_name, proposition}` rows in
 * `agent_beliefs` and create the unique index that keeps them from coming back.
 *
 * Idempotent and logged: the counts are both logged and returned, deletions
 * are reported per run, and the unique index is created only after the
 * collapse. Rows that carry the legacy identity-less `user_id` value are never
 * re-attributed — only exact-duplicate keys are collapsed (a lone legacy row
 * is kept as it is).
 *
 * The index step is structural: an index is only accepted as in place when it
 * carries the declared name AND is unique AND is keyed exactly on
 * `{user_id, entity_name, proposition}`. A same-named index that does not
 * enforce the constraint is reported (`index_replaced`, plus a log line) and
 * replaced — accepting it as present would leave duplicates insertable.
 */
export async function dedupeAgentBeliefs(
  db: Db,
  log: (message: string) => void = console.log,
): Promise<BeliefDedupeResult> {
  const collection = db.collection(SELF_MODEL_COLLECTIONS.agentBeliefs);
  const emit = (message: string): void => {
    try {
      log(message);
    } catch {
      /* logging must never break the migration */
    }
  };

  const result: BeliefDedupeResult = {
    groups_scanned: 0,
    duplicate_groups: 0,
    duplicates_found: 0,
    documents_removed: 0,
    groups_touched: 0,
    documents_without_id: 0,
    index_name: AGENT_BELIEFS_UNIQUE_INDEX,
    index_created: false,
    index_replaced: false,
    index_present: false,
    errors: [],
  };

  try {
    const docs = await collection
      .find({}, {
        projection: {
          _id: 1,
          user_id: 1,
          entity_name: 1,
          proposition: 1,
          confidence: 1,
          last_updated: 1,
          source: 1,
        },
      })
      .toArray();

    const groups = new Map<string, any[]>();
    for (const doc of docs) {
      const key = beliefGroupKey(doc);
      const group = groups.get(key);
      if (group) {
        group.push(doc);
      } else {
        groups.set(key, [doc]);
      }
    }
    result.groups_scanned = groups.size;

    for (const group of groups.values()) {
      if (group.length < 2) continue;

      result.duplicate_groups += 1;
      result.duplicates_found += group.length - 1;

      const winner = pickBeliefWinner(group);
      const loserIds: any[] = [];
      for (const doc of group) {
        if (doc === winner) continue;
        if (doc?._id === undefined || doc?._id === null) {
          result.documents_without_id += 1;
          continue;
        }
        loserIds.push(doc._id);
      }
      if (loserIds.length === 0) continue;

      const key = beliefGroupKey(winner);
      try {
        const deletion = await collection.deleteMany({ _id: { $in: loserIds } });
        const deleted =
          typeof deletion?.deletedCount === 'number' ? deletion.deletedCount : loserIds.length;
        result.documents_removed += deleted;
        result.groups_touched += 1;
        emit(
          `🧠 agent_beliefs dedupe: kept the highest-confidence row of ${key} ` +
            `(confidence ${beliefConfidence(winner)}) and removed ${deleted} duplicate document(s)`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`group ${key}: ${message}`);
        emit(`❌ agent_beliefs dedupe: could not collapse ${key}: ${message}`);
      }
    }

    emit(
      `🧠 agent_beliefs dedupe: scanned ${result.groups_scanned} key group(s) — ` +
        `${result.duplicate_groups} duplicate group(s), ${result.duplicates_found} duplicate document(s), ` +
        `removed ${result.documents_removed} document(s) across ${result.groups_touched} group(s)`,
    );
    if (result.documents_without_id > 0) {
      emit(`⚠️ agent_beliefs dedupe: ${result.documents_without_id} duplicate document(s) carry no _id and were left in place`);
    }

    // The index may only be created once nothing can violate it.
    if (result.documents_without_id === 0 && result.errors.length === 0) {
      const state = await classifyBeliefUniqueIndex(collection);
      if (state.kind === 'present') {
        result.index_present = true;
        emit(`✅ agent_beliefs: unique index ${AGENT_BELIEFS_UNIQUE_INDEX} is in place (nothing to create)`);
      } else {
        // A look-alike must not be accepted as the constraint: drop it (by
        // name) and build the declared one, reporting the replacement.
        let blocked = false;
        if (state.kind === 'replace') {
          try {
            await dropBeliefIndex(collection, state.name);
            result.index_replaced = true;
            emit(
              `♻️ agent_beliefs: ${state.reason}; dropped ${state.name} to create ` +
                `${AGENT_BELIEFS_UNIQUE_INDEX} in its place`,
            );
          } catch (error) {
            blocked = true;
            const message = error instanceof Error ? error.message : String(error);
            result.errors.push(`index ${state.name}: ${message}`);
            emit(`❌ agent_beliefs: could not drop ${state.name} before creating ${AGENT_BELIEFS_UNIQUE_INDEX}: ${message}`);
          }
        }
        if (!blocked) {
          try {
            await collection.createIndex({ ...AGENT_BELIEFS_UNIQUE_KEYS }, {
              unique: true,
              name: AGENT_BELIEFS_UNIQUE_INDEX,
              background: true,
            });
            result.index_created = true;
            result.index_present = true;
            emit(
              `✅ agent_beliefs: created unique index ${AGENT_BELIEFS_UNIQUE_INDEX} ` +
                `on {user_id, entity_name, proposition}`,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.errors.push(`index ${AGENT_BELIEFS_UNIQUE_INDEX}: ${message}`);
            emit(
              `❌ agent_beliefs: could not create unique index ${AGENT_BELIEFS_UNIQUE_INDEX}: ${message}`,
            );
          }
        }
      }
    } else {
      emit(
        `⚠️ agent_beliefs: unique index ${AGENT_BELIEFS_UNIQUE_INDEX} not attempted — ` +
          `the collapse was incomplete (${result.errors.length} error(s), ${result.documents_without_id} document(s) without _id)`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`scan: ${message}`);
    emit(`❌ agent_beliefs dedupe failed: ${message}`);
  }

  return result;
}

export class SelfModelService {
  private static instance: SelfModelService;
  private database: Db | null;

  /**
   * The in-process pattern map is a CACHE: `procedural_patterns` is the truth.
   * Reads hydrate it per identity from the store, writes update it immediately
   * and persist best-effort (see `recordToolPattern` / `flushProceduralPatterns`).
   */
  private proceduralPatterns: Map<string, ProceduralCacheEntry> = new Map();
  /** Identities whose rows have been loaded from the store in this process. */
  private proceduralHydrated: Set<string> = new Set();
  private proceduralFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private proceduralFlushChain: Promise<void> = Promise.resolve();
  private proceduralIndexes: Promise<void> | null = null;

  private constructor() {
    this.database = get_database();
  }

  static get_instance(): SelfModelService {
    if (!SelfModelService.instance) {
      SelfModelService.instance = new SelfModelService();
    }
    return SelfModelService.instance;
  }

  /** The database, or a loud error — a missing connection is never a silent write. */
  private requireDb(): Db {
    if (!this.database) {
      throw new Error('Database not connected: the self-model store is unavailable');
    }
    return this.database;
  }

  private requireIdentity(userId: unknown, operation: string): string {
    const identity = identityOf(userId);
    if (!identity) {
      throw new Error(`${operation} requires a user_id: self-model rows are identity-scoped`);
    }
    return identity;
  }

  async getIdentityKernel(userId: string): Promise<IdentityKernelResult> {
    const insights = await this.requireDb().collection('philosophical_insights').find({
      user_id: userId,
      status: { $in: ['stable', 'strengthening'] },
    }).sort({ confidence: -1 }).limit(5).toArray() as unknown as PhilosophicalInsight[];

    const topInsights = insights.map((insight) => ({
      insight_text: insight.insight_text,
      domain: insight.domain,
      confidence: insight.confidence,
      status: insight.status,
    }));

    let narrative: string;
    if (topInsights.length === 0) {
      narrative = 'I am the kind of agent who is still forming my identity. I have not yet accumulated enough stable insights to define who I am.';
    } else {
      const domains = [...new Set(topInsights.map((i) => i.domain))];
      const domainPhrase = domains.length === 1 ? domains[0] : domains.slice(0, -1).join(', ') + ' and ' + domains[domains.length - 1];
      narrative = `I am the kind of agent who ${topInsights[0].insight_text.toLowerCase()}. My identity is shaped by insights across ${domainPhrase}.`;
    }

    return { narrative, insights: topInsights };
  }

  async generateMindWander(userId: string): Promise<MindWanderResult> {
    const db = this.requireDb();
    const nodesCollection = db.collection('knowledge_nodes');
    const edgesCollection = db.collection('knowledge_relationships');

    const nodeCount = await nodesCollection.countDocuments({ user_id: userId });
    if (nodeCount === 0) {
      return { path: [], narrative: 'No knowledge graph nodes available for mind-wandering.', stored_event_id: null };
    }

    const randomSkip = Math.floor(Math.random() * Math.max(1, nodeCount));
    const startNode = await nodesCollection.find({ user_id: userId }).skip(randomSkip).limit(1).toArray() as unknown as KnowledgeNode[];
    if (!startNode.length) {
      return { path: [], narrative: 'Could not find a starting node.', stored_event_id: null };
    }

    const path: string[] = [startNode[0].properties?.name || startNode[0].id || 'unknown'];
    const currentNodeId = startNode[0].id;

    const steps = 3 + Math.floor(Math.random() * 3);
    let currentId = currentNodeId;

    for (let i = 1; i < steps; i++) {
      const outgoingEdges = await edgesCollection.find({
        from_id: currentId,
      }).toArray() as unknown as KnowledgeRelationship[];

      if (outgoingEdges.length === 0) break;

      const totalWeight = outgoingEdges.reduce((sum, e) => sum + (e.strength || 1), 0);
      let pointer = Math.random() * totalWeight;
      let selectedEdge: KnowledgeRelationship | null = null;

      for (const edge of outgoingEdges) {
        pointer -= (edge.strength || 1);
        if (pointer <= 0) {
          selectedEdge = edge;
          break;
        }
      }

      if (!selectedEdge) selectedEdge = outgoingEdges[outgoingEdges.length - 1];

      const nextNode = await nodesCollection.findOne({ id: selectedEdge.to_id }) as unknown as KnowledgeNode | null;
      if (!nextNode) break;

      const nextName = nextNode.properties?.name || nextNode.id || 'unknown';
      path.push(nextName);
      currentId = nextNode.id;
    }

    const narrative = this.buildMindWanderNarrative(path);
    let storedEventId: string | null = null;

    try {
      const eventManager = getEpisodicEventManager();
      const result = await eventManager.createEvent({
        user_id: userId,
        session_id: `mindwander:${randomUUID()}`,
        event_type: 'mind_wander',
        content: {
          role: 'assistant',
          message: narrative,
          path,
        },
        metadata: {
          source: 'self_model_mindwander',
          retrieval_strength: 0.3,
          decay_exponent: 1.5,
          tags: ['mind_wander', 'self_model'],
        },
      });
      storedEventId = result.event.id;
    } catch (error) {
      console.error('Failed to store mind-wander episodic event:', error);
    }

    return { path, narrative, stored_event_id: storedEventId };
  }

  private buildMindWanderNarrative(path: string[]): string {
    if (path.length === 0) return '';
    if (path.length === 1) return `I started thinking about ${path[0]}.`;
    const parts: string[] = [`I started thinking about ${path[0]}`];
    for (let i = 1; i < path.length; i++) {
      if (i === path.length - 1) {
        parts.push(`and then arrived at ${path[i]}.`);
      } else {
        parts.push(`, which led me to ${path[i]}`);
      }
    }
    return parts.join('');
  }

  /**
   * Record a belief about an entity for ONE identity.
   *
   * `userId` is required and is part of the upsert filter, so two identities
   * can hold the same proposition about the same entity without colliding, and
   * a write can never touch another identity's row. Identity-less rows (the
   * legacy identity-less `user_id` value) are no longer written.
   */
  async trackBelief(userId: string, entityName: string, proposition: string, confidence: number, source: string): Promise<void> {
    const identity = this.requireIdentity(userId, 'trackBelief');
    const collection = this.requireDb().collection(SELF_MODEL_COLLECTIONS.agentBeliefs);
    const now = new Date();
    await collection.updateOne(
      { user_id: identity, entity_name: entityName, proposition },
      {
        $set: {
          confidence: Math.max(0, Math.min(1, confidence)),
          source,
          last_updated: now,
        },
        $setOnInsert: {
          user_id: identity,
          entity_name: entityName,
          proposition,
          created_at: now,
        },
      },
      { upsert: true }
    );
  }

  /** The beliefs ONE identity holds about an entity — never another identity's. */
  async getAgentBeliefs(userId: string, entityName: string): Promise<AgentBelief[]> {
    const identity = this.requireIdentity(userId, 'getAgentBeliefs');
    const collection = this.requireDb().collection(SELF_MODEL_COLLECTIONS.agentBeliefs);
    const docs = await collection.find({
      user_id: identity,
      entity_name: entityName,
    }).sort({ confidence: -1 }).toArray();

    return docs.map((doc: any) => ({
      proposition: doc.proposition,
      confidence: doc.confidence,
      source: doc.source || 'unknown',
      last_updated: doc.last_updated || new Date(),
    }));
  }

  /**
   * Collapse duplicate belief keys and create the unique identity index.
   * Same migration as the module-level `dedupeAgentBeliefs()`; see it for the
   * determinism rules and the returned counts.
   */
  async dedupeAgentBeliefs(log?: (message: string) => void): Promise<BeliefDedupeResult> {
    return dedupeAgentBeliefs(this.requireDb(), log);
  }

  /**
   * Record one observed tool call for the identity that made it.
   *
   * The cache is updated immediately (reads keep working even while the store
   * is unreachable) and the row is persisted best-effort after a short debounce;
   * failures are logged and stay pending for the next flush. This is the only
   * way a `procedural_patterns` row is created — no history is manufactured.
   */
  recordToolPattern(userId: string, toolName: string, inputShape: Record<string, unknown>, success: boolean): void {
    const identity = this.requireIdentity(userId, 'recordToolPattern');
    const shapeHash = hashInputShape(inputShape ?? {});
    const key = proceduralCacheKey(identity, toolName, shapeHash);
    const existing = this.proceduralPatterns.get(key);
    const now = new Date();

    if (existing) {
      existing.frequency += 1;
      existing.successes += success ? 1 : 0;
      existing.avgSuccess = recomputeAvgSuccess(existing);
      existing.pendingFrequency += 1;
      existing.pendingSuccesses += success ? 1 : 0;
      existing.lastSeen = now;
    } else {
      this.proceduralPatterns.set(key, {
        userId: identity,
        toolName,
        shapeHash,
        inputShape: describeInputShape(inputShape ?? {}),
        frequency: 1,
        successes: success ? 1 : 0,
        avgSuccess: success ? 1 : 0,
        lastSeen: now,
        pendingFrequency: 1,
        pendingSuccesses: success ? 1 : 0,
      });
    }

    this.scheduleProceduralFlush();
  }

  /**
   * The identity's habitual patterns (frequency >= 5). Hydrates the cache from
   * `procedural_patterns` on first use, so patterns recorded before a restart
   * are returned, and never returns another identity's rows.
   */
  async getProceduralTemplates(userId: string): Promise<ProceduralTemplate[]> {
    const patterns = await this.getProceduralPatterns(userId, PROCEDURAL_THRESHOLD);
    return patterns.map((pattern) => ({
      toolName: pattern.toolName,
      inputShape: pattern.inputShape,
      frequency: pattern.frequency,
      avgSuccess: pattern.avgSuccess,
    }));
  }

  /**
   * Every observed pattern of ONE identity with `frequency >= minFrequency`
   * (default 1). Supported reader for consumers that need the raw counts
   * rather than the 5-observation threshold.
   */
  async getProceduralPatterns(userId: string, minFrequency = 1): Promise<ProceduralPattern[]> {
    const identity = this.requireIdentity(userId, 'getProceduralPatterns');
    await this.hydrateProceduralPatterns(identity);

    const threshold = Math.max(1, Math.floor(minFrequency));
    return [...this.proceduralPatterns.values()]
      .filter((entry) => entry.userId === identity && entry.frequency >= threshold)
      .sort((a, b) =>
        b.frequency - a.frequency ||
        a.toolName.localeCompare(b.toolName) ||
        a.shapeHash.localeCompare(b.shapeHash))
      .map((entry) => ({
        toolName: entry.toolName,
        inputShape: entry.inputShape,
        shapeHash: entry.shapeHash,
        frequency: entry.frequency,
        successes: entry.successes,
        avgSuccess: entry.avgSuccess,
        lastSeen: entry.lastSeen,
      }));
  }

  /** How many habitual patterns (frequency >= 5) this identity has. */
  async getProceduralTemplateCount(userId: string): Promise<number> {
    const patterns = await this.getProceduralPatterns(userId, PROCEDURAL_THRESHOLD);
    return patterns.length;
  }

  /** How many distinct `{tool, input shape}` rows this identity has. */
  async getProceduralPatternCount(userId: string): Promise<number> {
    const patterns = await this.getProceduralPatterns(userId, 1);
    return patterns.length;
  }

  /**
   * Write every pending increment to `procedural_patterns`. Serialized, and it
   * never rejects: the store may fail in ways no per-row guard can see (a
   * `collection()` that throws, a `find` that fails, no connection at all), and
   * in every case the failure is returned in `errors` while the increments stay
   * pending — a later flush retries them.
   */
  async flushProceduralPatterns(): Promise<ProceduralFlushResult> {
    const result: ProceduralFlushResult = { patterns_written: 0, errors: [] };
    const run = this.proceduralFlushChain.then(() => this.persistPendingProceduralPatterns(result));
    // Keep the chain alive and non-rejecting so later flushes run after this one.
    this.proceduralFlushChain = run.then(() => undefined, () => undefined);
    try {
      await run;
    } catch (error) {
      // Last line of defence for the contract above: whatever escaped the
      // guarded path is reported, never thrown at the caller.
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`flush: ${message}`);
      console.warn('[SelfModel] Procedural pattern flush failed:', error);
    }
    // A failed flush leaves its increments pending but nothing would try again
    // until the next record or an explicit call — so re-arm the debounce. This
    // is the same 250 ms debounce (never a tight loop): the retry is only
    // re-armed while something is actually pending, so a clean flush ends the
    // chain and a store that fails with nothing to write schedules nothing.
    if (result.errors.length > 0 && this.pendingProceduralCount() > 0) {
      this.scheduleProceduralFlush();
    }
    return result;
  }

  /**
   * Drop the in-process cache. The store is the truth, so this is what a fresh
   * process sees: the next read re-hydrates `procedural_patterns`. Pending
   * increments are flushed first — losing a recorded observation silently is
   * what the store exists to prevent.
   *
   * The cache is only dropped when that flush was CLEAN. When it reported
   * errors the increments are still pending and exist nowhere else, so clearing
   * would discard them outright (the old behaviour: shutdown-time data loss
   * whenever the store was down); the entries are kept and `cleared: false`
   * plus the errors are reported instead.
   */
  async resetProceduralCache(): Promise<ProceduralCacheResetResult> {
    const flushed = await this.flushProceduralPatterns();
    if (flushed.errors.length > 0) {
      console.warn(
        `[SelfModel] Keeping the procedural cache: the flush reported ${flushed.errors.length} error(s) ` +
          `with ${this.pendingProceduralCount()} pattern(s) still pending — nothing was cleared`,
        flushed.errors,
      );
      return { ...flushed, cleared: false };
    }
    this.proceduralPatterns.clear();
    this.proceduralHydrated.clear();
    return { ...flushed, cleared: true };
  }

  /** How many cache entries still hold increments the store has not confirmed. */
  private pendingProceduralCount(): number {
    let count = 0;
    for (const entry of this.proceduralPatterns.values()) {
      if (entry.pendingFrequency > 0 || entry.pendingSuccesses > 0) count += 1;
    }
    return count;
  }

  private scheduleProceduralFlush(): void {
    if (this.proceduralFlushTimer) return;
    const timer = setTimeout(() => {
      this.proceduralFlushTimer = null;
      void this.flushProceduralPatterns().catch((error) => {
        console.warn('[SelfModel] Procedural pattern flush failed:', error);
      });
    }, PROCEDURAL_FLUSH_DELAY_MS);
    timer.unref?.();
    this.proceduralFlushTimer = timer;
  }

  /**
   * Index creation is lazy (house pattern) and never fatal: it is logged, not
   * thrown. It is also NOT memoised across a failure — a transient build
   * failure (or a store that was briefly down) would otherwise leave the guard
   * permanently "done" and the indexes would never be retried in this process.
   * Clearing the memo makes the next call try again.
   */
  private ensureProceduralIndexes(): Promise<void> {
    if (!this.proceduralIndexes) {
      const attempt = (async () => {
        const db = this.database;
        if (!db) {
          console.warn('[SelfModel] Skipping self-model index check: database not connected');
          return;
        }
        await ensureSelfModelIndexes(db);
      })();
      this.proceduralIndexes = attempt.catch((error) => {
        this.proceduralIndexes = null;
        console.warn('[SelfModel] Could not ensure the self-model indexes (will retry):', error);
      });
    }
    return this.proceduralIndexes;
  }

  /**
   * Load this identity's rows from `procedural_patterns` into the cache.
   *
   * Increments recorded before hydration are still pending, so the stored row
   * and the pending increments are summed; everything else comes from the store.
   * Never rejects: a store that is unreachable leaves the identity un-hydrated
   * (the next read tries again) and returns why, so a flush does not overwrite
   * stored totals it never managed to read.
   */
  private async hydrateProceduralPatterns(userId: string): Promise<HydrationOutcome> {
    if (this.proceduralHydrated.has(userId)) return { ok: true };
    const identity = this.requireIdentity(userId, 'hydrateProceduralPatterns');
    await this.ensureProceduralIndexes();

    const db = this.database;
    if (!db) {
      const reason = 'database not connected';
      console.warn(`[SelfModel] Cannot hydrate procedural patterns for ${identity}: ${reason}`);
      return { ok: false, reason };
    }

    let rows: any[];
    try {
      rows = await db.collection(SELF_MODEL_COLLECTIONS.proceduralPatterns)
        .find({ user_id: identity })
        .toArray();
    } catch (error) {
      // Left un-hydrated on purpose: the next read tries again.
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[SelfModel] Could not hydrate procedural patterns for ${identity}:`, error);
      return { ok: false, reason };
    }

    for (const row of rows) {
      const shapeHash = typeof row?.input_shape === 'string' ? row.input_shape : '';
      const toolName = typeof row?.tool_name === 'string' ? row.tool_name : '';
      if (!shapeHash || !toolName) continue;

      const key = proceduralCacheKey(identity, toolName, shapeHash);
      const pending = this.proceduralPatterns.get(key);
      const storedFrequency = Number(row.frequency) || 0;
      const storedSuccesses = Number(row.successes) || 0;

      const entry: ProceduralCacheEntry = {
        userId: identity,
        toolName,
        shapeHash,
        inputShape:
          typeof row.shape_keys === 'string' ? row.shape_keys : describeInputShape({}),
        frequency: storedFrequency + (pending?.pendingFrequency ?? 0),
        successes: storedSuccesses + (pending?.pendingSuccesses ?? 0),
        avgSuccess: 0,
        lastSeen: toDate(row.last_seen) ?? pending?.lastSeen ?? new Date(0),
        pendingFrequency: pending?.pendingFrequency ?? 0,
        pendingSuccesses: pending?.pendingSuccesses ?? 0,
      };
      entry.avgSuccess = recomputeAvgSuccess(entry);
      this.proceduralPatterns.set(key, entry);
    }

    this.proceduralHydrated.add(identity);
    return { ok: true };
  }

  private async persistPendingProceduralPatterns(result: ProceduralFlushResult): Promise<void> {
    await this.ensureProceduralIndexes();

    // The CACHE KEYS with something to write. Only the keys are collected here:
    // hydration below REPLACES an entry with a new object (stored + pending), so
    // the entries themselves must be re-read from the map afterwards. Writing a
    // snapshot taken at this point is how the first flush regressed a stored row
    // — a record before the identity was ever read left the snapshot holding the
    // pending total alone (1) and overwrote the stored frequency (3) with it.
    const pendingKeys = [...this.proceduralPatterns.keys()].filter((key) => {
      const entry = this.proceduralPatterns.get(key);
      return !!entry && (entry.pendingFrequency > 0 || entry.pendingSuccesses > 0);
    });

    const db = this.database;
    if (!db) {
      if (pendingKeys.length > 0) {
        const message = `database not connected — ${pendingKeys.length} pattern(s) kept in the cache`;
        result.errors.push(message);
        console.warn(`[SelfModel] Procedural patterns not persisted: ${message}`);
      }
      return;
    }

    // The store is the truth: a row may already exist (or have been written by
    // another process), so hydrate before overwriting it with local totals.
    const unhydrated = new Set<string>();
    const identities = [
      ...new Set(
        pendingKeys
          .map((key) => this.proceduralPatterns.get(key)?.userId)
          .filter((identity): identity is string => typeof identity === 'string'),
      ),
    ].filter((identity) => !this.proceduralHydrated.has(identity));
    for (const identity of identities) {
      const outcome = await this.hydrateProceduralPatterns(identity);
      if (!outcome.ok) {
        unhydrated.add(identity);
        const message = `procedural_patterns: could not read the stored patterns for ${identity} (${outcome.reason}) — kept pending`;
        result.errors.push(message);
        console.warn(`[SelfModel] Procedural patterns not persisted: ${message}`);
      }
    }

    // Every store access is inside a guard — obtaining the collection handle
    // included, because a store may throw synchronously from `collection()`.
    // Nothing below may reject: the failure is reported through `result.errors`
    // and the increments stay pending for the next flush.
    let collection: Collection;
    try {
      collection = db.collection(SELF_MODEL_COLLECTIONS.proceduralPatterns);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`procedural_patterns: ${message}`);
      console.warn('[SelfModel] Could not reach the procedural pattern store:', error);
      return;
    }

    // Re-read the entries AFTER hydration: what the map holds now is the
    // authoritative stored + pending totals, not the pre-hydration snapshot.
    const pending = pendingKeys
      .map((key) => this.proceduralPatterns.get(key))
      .filter(
        (entry): entry is ProceduralCacheEntry =>
          !!entry && (entry.pendingFrequency > 0 || entry.pendingSuccesses > 0),
      );

    for (const entry of pending) {
      if (unhydrated.has(entry.userId)) {
        // Writing here would overwrite a stored row with totals we never read.
        continue;
      }
      const writtenFrequency = entry.pendingFrequency;
      const writtenSuccesses = entry.pendingSuccesses;
      try {
        await collection.updateOne(
          { user_id: entry.userId, tool_name: entry.toolName, input_shape: entry.shapeHash },
          {
            $set: {
              user_id: entry.userId,
              tool_name: entry.toolName,
              input_shape: entry.shapeHash,
              shape_keys: entry.inputShape,
              frequency: entry.frequency,
              successes: entry.successes,
              avg_success: entry.avgSuccess,
              last_seen: entry.lastSeen,
            },
            $setOnInsert: { created_at: new Date() },
          },
          { upsert: true },
        );
        entry.pendingFrequency -= writtenFrequency;
        entry.pendingSuccesses -= writtenSuccesses;
        result.patterns_written += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${entry.toolName}/${entry.shapeHash}: ${message}`);
        console.warn(
          `[SelfModel] Failed to persist procedural pattern ${entry.toolName} for ${entry.userId}:`,
          error,
        );
      }
    }
  }

  /**
   * DMN: Continuous self-narrative update.
   * Records an incremental identity shift between sleep consolidations,
   * providing the "stream of consciousness" that the DMN generates.
   * Stored as a lightweight episodic event with type 'self_narrative'.
   */
  async recordSelfNarrative(userId: string, thought: string): Promise<void> {
    try {
      const eventsCollection = this.requireDb().collection('episodic_events');
      await eventsCollection.insertOne({
        id: `narrative_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        user_id: userId,
        session_id: 'self-model',
        event_type: 'self_narrative',
        content: { role: 'assistant', message: thought },
        timestamp: new Date(),
        metadata: {
          processed: false,
          source: 'dmn_stream',
          emotional_tags: { valence: 0, arousal: 0.2, caution: false, priority: 'low', decayResistant: false },
        },
      });
    } catch {
      // Non-critical — narrative is supplementary to sleep consolidation
    }
  }

  /**
   * DMN: Goal-directed mind-wandering.
   * Instead of purely random walks, bias the walk toward nodes
   * connected to active goals when goals exist.
   */
  async generateGoalDirectedMindWander(userId: string, activeGoalTerms: string[] = []): Promise<MindWanderResult> {
    const db = this.requireDb();
    const nodesCollection = db.collection('knowledge_nodes');
    const edgesCollection = db.collection('knowledge_relationships');

    // If there are active goals, start from a goal-related node
    let startNode: any[] = [];
    if (activeGoalTerms.length > 0) {
      const regex = new RegExp(activeGoalTerms.join('|'), 'i');
      startNode = await nodesCollection.find({
        user_id: userId,
        $or: [{ name: regex }, { 'properties.name': regex }],
      }).limit(1).toArray();
    }

    // Fallback to random if no goal-related nodes found
    if (startNode.length === 0) {
      const nodeCount = await nodesCollection.countDocuments({ user_id: userId });
      if (nodeCount === 0) {
        return { path: [], narrative: 'No knowledge graph nodes for mind-wandering.', stored_event_id: null };
      }
      const randomSkip = Math.floor(Math.random() * Math.max(1, nodeCount));
      startNode = await nodesCollection.find({ user_id: userId }).skip(randomSkip).limit(1).toArray();
    }

    if (!startNode.length) {
      return { path: [], narrative: 'Could not find a starting node.', stored_event_id: null };
    }

    const path: string[] = [(startNode[0] as any).name || (startNode[0] as any).properties?.name || 'unknown'];
    let currentNode = startNode[0];

    // Walk up to 5 steps, preferring goal-relevant edges
    for (let step = 0; step < 5; step++) {
      const edges = await edgesCollection.find({
        $or: [{ source: (currentNode as any)._id }, { target: (currentNode as any)._id }],
      }).limit(10).toArray();

      if (edges.length === 0) break;

      // Bias toward goal-relevant edges
      let weightedEdges = edges.map((e: any) => {
        const edgeName = e.label || e.relationship_type || '';
        const relevance = activeGoalTerms.some(t => edgeName.toLowerCase().includes(t.toLowerCase())) ? 3 : 1;
        return { edge: e, weight: relevance * (e.weight || 1) };
      });

      const totalWeight = weightedEdges.reduce((s: number, e: any) => s + e.weight, 0);
      let rand = Math.random() * totalWeight;
      let selected: any = weightedEdges[0];
      for (const we of weightedEdges) {
        rand -= we.weight;
        if (rand <= 0) { selected = we; break; }
      }

      const nextId = (selected.edge.source?.toString() === (currentNode as any)._id?.toString())
        ? selected.edge.target : selected.edge.source;
      const nextNode = await nodesCollection.findOne({ _id: nextId });
      if (nextNode) {
        path.push((nextNode as any).name || (nextNode as any).properties?.name || 'unknown');
        currentNode = nextNode;
      } else {
        break;
      }
    }

    const narrative = `I started thinking about ${path[0]}. ${path.length > 1 ? `This led me through ${path.slice(1).join(' → ')}.` : 'My thoughts stayed there.'}`;

    // Store as episodic event
    let storedEventId: string | null = null;
    try {
      const eventsCollection = db.collection('episodic_events');
      const result = await eventsCollection.insertOne({
        id: `mindwander_${Date.now()}`,
        user_id: userId,
        session_id: 'self-model',
        event_type: 'mind_wander',
        content: { role: 'assistant', message: narrative },
        timestamp: new Date(),
        metadata: { processed: false, source: 'dmn_wander', path },
      });
      storedEventId = result.insertedId.toString();
    } catch { /* non-critical */ }

    return { path, narrative, stored_event_id: storedEventId };
  }
}

/** Parse a stored timestamp; `null` when it is absent or unusable. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
