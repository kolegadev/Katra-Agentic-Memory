// Cognitive Baton service (Phase 2) — immutable, expiring context packets.
// Batons are issued against a mission version; any later accepted delta
// invalidates them (invariant #11). Blindness policy withholds incumbent
// material for challenge/explore episodes (invariant #10). Secret material is
// rejected at serialization (invariant #6) — only capability references travel.
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { BATON_TTL_SECONDS, COLLECTIONS } from './collections.js';
import { SCHEMA_IDS, validateAgainst } from './schema-registry.js';
import { emitMissionEvent } from './event-rail.js';
import { MissionStateService } from './mission-state-service.js';
import { EpistemicLedgerService } from './epistemic-ledger-service.js';
import type { CognitiveBaton, CognitiveBatonDraft, EntryType } from '../../types/cognitive-control.js';

/** Broad secret-shape scan; capability references must never carry values. */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/i,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT-shaped
  /api[_-]?key["']?\s*[:=]\s*["'][A-Za-z0-9+/=]{16,}/i,
];

export function assertNoSecretMaterial(serialized: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error('secret-bearing material rejected from baton serialization');
    }
  }
}

const WITHHELD_ON_BLIND: EntryType[] = ['decision', 'claim', 'assumption', 'hypothesis'];

export class BatonService {
  private missions: MissionStateService;
  private ledger: EpistemicLedgerService;

  constructor(private readonly db: Db) {
    this.missions = new MissionStateService(db);
    this.ledger = new EpistemicLedgerService(db);
  }

  private batons() {
    return this.db.collection<CognitiveBaton & { _id?: unknown; _expires_at?: Date }>(COLLECTIONS.cognitiveBatons);
  }

  /** Compile a baton from the mission state + referenced ledger entries. */
  async compileBaton(draft: CognitiveBatonDraft): Promise<CognitiveBaton> {
    const state = await this.missions.getMissionState(draft.mission_id, draft.mission_version);
    if (!state) throw new Error(`mission state not found: ${draft.mission_id} v${draft.mission_version}`);
    const blind = draft.blindness?.enabled === true;
    const withheld = new Set(draft.blindness?.withheld_classes ?? []);
    // Semantic blindness classes (schema enum) map onto incumbent entry types.
    const withholdIncumbent = blind && (
      withheld.has('incumbent_conclusion') || withheld.has('incumbent_rationale')
      || withheld.has('leading_labels') || withheld.has('peer_hypotheses')
    );

    const context: CognitiveBaton['context'] = {};
    for (const refId of (state.ledger_refs ?? []).slice(0, 40)) {
      const entry = await this.ledger.getEntry(refId);
      if (!entry) continue;
      if (withholdIncumbent && WITHHELD_ON_BLIND.includes(entry.entry_type)) continue; // invariant #10
      const key = `${entry.entry_type}s` as keyof NonNullable<CognitiveBaton['context']>;
      (context[key] ??= []).push(`${entry.entry_id}: ${entry.statement.slice(0, 200)}`);
    }

    const now = new Date().toISOString();
    const baton: CognitiveBaton = {
      ...draft,
      baton_id: draft.baton_id ?? randomUUID(),
      issued_at: now,
      context,
      capabilities: draft.capabilities ?? [], // opaque refs only
      mission_version: state.version,
    };
    const check = validateAgainst(SCHEMA_IDS.cognitiveBaton, baton);
    if (!check.valid) throw new Error(`baton invalid: ${check.errors.join('; ')}`);
    assertNoSecretMaterial(JSON.stringify(baton));
    return baton;
  }

  async issueBaton(draft: CognitiveBatonDraft): Promise<CognitiveBaton> {
    const baton = await this.compileBaton(draft);
    await this.batons().insertOne({
      ...baton,
      _expires_at: new Date(Date.parse(baton.expires_at) || Date.now() + BATON_TTL_SECONDS * 1000),
    });
    await this.db.collection(COLLECTIONS.missionStates).updateOne(
      { mission_id: baton.mission_id },
      { $push: { active_baton_ids: baton.baton_id } } as any,
    );
    await emitMissionEvent(this.db, {
      mission_id: baton.mission_id,
      event_type: 'baton.issued',
      baton_id: baton.baton_id,
      version: baton.mission_version,
      summary: `${baton.mode} baton for ${baton.recipient_id}`,
    });
    return baton;
  }

  async getBaton(batonId: string, recipientId?: string): Promise<CognitiveBaton | null> {
    const baton = await this.batons().findOne({ baton_id: batonId }, { projection: { _id: 0, _expires_at: 0 } });
    if (!baton) return null;
    if (baton.revoked) return null;
    if (Date.parse(baton.expires_at) < Date.now()) {
      await emitMissionEvent(this.db, {
        mission_id: baton.mission_id,
        event_type: 'baton.expired',
        baton_id: baton.baton_id,
        summary: `baton expired for ${baton.recipient_id}`,
      });
      return null;
    }
    if (recipientId && baton.recipient_id !== recipientId) return null; // recipient-bound
    return baton;
  }

  /** Any baton issued before `sinceVersion` is stale (invariant #11). */
  async invalidateBatonsForMission(missionId: string, sinceVersion: number): Promise<number> {
    const result = await this.batons().updateMany(
      { mission_id: missionId, mission_version: { $lt: sinceVersion }, revoked: { $ne: true } },
      { $set: { revoked: true, revoked_at: new Date().toISOString() } },
    );
    if (result.matchedCount > 0) {
      await emitMissionEvent(this.db, {
        mission_id: missionId,
        event_type: 'baton.expired',
        version: sinceVersion,
        summary: `${result.matchedCount} stale baton(s) invalidated`,
      });
    }
    return result.matchedCount;
  }
}
