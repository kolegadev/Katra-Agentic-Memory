import { get_database } from '../../database/connection.js';

export type DriveName = 'coherence' | 'novelty' | 'connection' | 'growth' | 'survival';

interface DriveConfig {
  target: number;
  depletionRate: number;
}

interface DriveState {
  current: number;
  target: number;
  strength: number;
  trend: 'rising' | 'falling' | 'stable';
  lastTick: Date;
}

export interface DriveSnapshot {
  drives: Record<DriveName, DriveState>;
  timestamp: Date;
}

export interface IncentiveSalienceParams {
  base?: number;
  valence?: number;
  trend?: number;
  novelty?: number;
  pe?: number;
  goal?: number;
}

export interface IncentiveSalienceResult {
  wanting: number;
  liking: number;
  divergence: number;
  components: {
    base: number;
    valence: number;
    trend: number;
    novelty: number;
    pe: number;
    goal: number;
  };
}

export interface SourceTrustRecord {
  sourceId: string;
  trustScore: number;
  corroborationCount: number;
  contradictionCount: number;
  lastUpdated: Date;
}

type TrustEventType = 'corroboration' | 'contradiction';

// ── ITER-11 (WS-5 item 3): bounded novelty replenishment ────────────────────

/** One coverage step: an unexplored archive keeps the novelty WANT alive. */
export const NOVELTY_COVERAGE_STEP = 0.02;
/** What one recorded `unnecessary_cost` outcome takes off the drive. */
export const NOVELTY_WASTE_STEP = 0.02;
/** What one recorded useful outcome adds — the same step the outcome channel uses. */
export const NOVELTY_USEFUL_STEP = 0.05;
/** The hard bound on ONE call's adjustment, in either direction. */
export const NOVELTY_REPLENISHMENT_BOUND = 0.1;

/** What the novelty drive is fed with (all read per identity + mission). */
export interface NoveltyReplenishmentInput {
  user_id: string;
  mission_id?: string | null;
  /** Archive cells occupied in that mission's descriptor space. */
  coverage_cells: number;
  /** The archive's coverage target for that space. */
  coverage_target: number;
  /** Useful outcomes recorded in the window (they replenish). */
  useful_outcomes: number;
  /** `unnecessary_cost` outcomes recorded in the window (they deplete). */
  wasted_outcomes: number;
}

/** The bounded adjustment that was applied, with the numbers behind it. */
export interface NoveltyReplenishment {
  user_id: string;
  mission_id: string | null;
  before: number;
  after: number;
  applied: number;
  coverage_component: number;
  waste_component: number;
  useful_component: number;
  bound: number;
  basis: string;
}

const DRIVE_CONFIGS: Record<DriveName, DriveConfig> = {
  coherence:  { target: 0.8,  depletionRate: 0.005 },
  novelty:    { target: 0.7,  depletionRate: 0.01 },
  connection: { target: 0.6,  depletionRate: 0.008 },
  growth:     { target: 0.5,  depletionRate: 0.003 },
  survival:   { target: 0.95, depletionRate: 0.002 },
};

export class MotivationalEngine {
  private static instance: MotivationalEngine;

  private drives: Record<DriveName, DriveState>;
  private previousDrives: Record<DriveName, number>;

  private constructor() {
    const now = new Date();
    this.drives = {
      coherence:  { current: 0.8,  target: 0.8,  strength: 0, trend: 'stable', lastTick: now },
      novelty:    { current: 0.7,  target: 0.7,  strength: 0, trend: 'stable', lastTick: now },
      connection: { current: 0.6,  target: 0.6,  strength: 0, trend: 'stable', lastTick: now },
      growth:     { current: 0.5,  target: 0.5,  strength: 0, trend: 'stable', lastTick: now },
      survival:   { current: 0.95, target: 0.95, strength: 0, trend: 'stable', lastTick: now },
    };
    this.previousDrives = { coherence: 0.8, novelty: 0.7, connection: 0.6, growth: 0.5, survival: 0.95 };
  }

  static get_instance(): MotivationalEngine {
    if (!MotivationalEngine.instance) {
      MotivationalEngine.instance = new MotivationalEngine();
    }
    return MotivationalEngine.instance;
  }

  tick(now?: Date): DriveSnapshot {
    const tickTime = now || new Date();
    for (const name of Object.keys(DRIVE_CONFIGS) as DriveName[]) {
      const config = DRIVE_CONFIGS[name];
      const drive = this.drives[name];
      const hoursElapsed = (tickTime.getTime() - drive.lastTick.getTime()) / (1000 * 60 * 60);
      if (hoursElapsed > 0) {
        const prev = drive.current;
        drive.current = Math.max(0, drive.current - config.depletionRate * hoursElapsed);
        drive.strength = Math.max(0, 1 - drive.current / drive.target);
        drive.lastTick = tickTime;
        if (drive.current < prev - 0.001) {
          drive.trend = 'falling';
        } else if (drive.current > prev + 0.001) {
          drive.trend = 'rising';
        } else {
          drive.trend = 'stable';
        }
        this.previousDrives[name] = prev;
      }
    }
    return { drives: { ...this.drives }, timestamp: tickTime };
  }

  replenishDrive(driveName: DriveName, amount: number): void {
    const drive = this.drives[driveName];
    if (!drive) return;
    const prev = drive.current;
    drive.current = Math.max(0, drive.current + amount);
    drive.strength = Math.max(0, 1 - drive.current / drive.target);
    if (drive.current > prev + 0.001) {
      drive.trend = 'rising';
    } else if (drive.current < prev - 0.001) {
      drive.trend = 'falling';
    } else {
      drive.trend = 'stable';
    }
  }

  depleteDrive(driveName: DriveName, amount: number): void {
    const drive = this.drives[driveName];
    if (!drive) return;
    const prev = drive.current;
    drive.current = Math.max(0, drive.current - amount);
    drive.strength = Math.max(0, 1 - drive.current / drive.target);
    if (drive.current < prev - 0.001) {
      drive.trend = 'falling';
    } else if (drive.current > prev + 0.001) {
      drive.trend = 'rising';
    } else {
      drive.trend = 'stable';
    }
  }

  getDriveState(): Record<DriveName, DriveState> {
    return { ...this.drives };
  }

  getDominantDrive(): DriveName {
    let maxStrength = -1;
    let dominant: DriveName = 'coherence';
    for (const name of Object.keys(this.drives) as DriveName[]) {
      if (this.drives[name].strength > maxStrength) {
        maxStrength = this.drives[name].strength;
        dominant = name;
      }
    }
    return dominant;
  }

  /**
   * Receive consolidation results and adjust drive states accordingly.
   * Called by ConsolidationOutputBus after each memory profile build.
   *
   * Mapping:
   *  - Rich knowledge evolution (multiple entities, deep expertise) -> replenish coherence + connection
   *  - New interests or unfamiliar entities -> replenish novelty
   *  - Growth signals (increasing knowledge depth) -> replenish growth
   *  - Stagnation or empty analysis -> deplete coherence (alarm signal)
   */
  receiveConsolidationResult(result: {
    expertiseCount: number;
    interestCount: number;
    entityCount: number;
    knowledgeEvolution?: { trend?: string; depth_change?: number } | null;
    activityPatterns?: { total_conversations?: number }[] | null;
    communicationStyle?: { formality?: string } | null;
    memoryStats?: Record<string, number> | null;
  }): void {
    // Coherence: rewarded by meaningful analysis output, penalised by emptiness
    if (result.expertiseCount > 0 && result.entityCount > 0) {
      this.replenishDrive('coherence', 0.03 * Math.min(result.entityCount, 10));
    } else if (result.expertiseCount === 0 && result.entityCount === 0) {
      this.depleteDrive('coherence', 0.05);
    }

    // Novelty: new interests or unfamiliar entities
    if (result.interestCount > 0) {
      this.replenishDrive('novelty', 0.02 * Math.min(result.interestCount, 5));
    }
    if (result.entityCount > 5) {
      this.replenishDrive('novelty', 0.01);
    }

    // Connection: communication style variety + social signal
    if (result.communicationStyle?.formality) {
      this.replenishDrive('connection', 0.01);
    }

    // Growth: knowledge depth is increasing
    if (result.knowledgeEvolution?.trend === 'deepening') {
      this.replenishDrive('growth', 0.03);
    } else if (result.knowledgeEvolution?.trend === 'stable') {
      this.replenishDrive('growth', 0.005);
    }

    // Survival: memory stats health — if consolidation ran, survival is validated
    if (result.memoryStats) {
      this.replenishDrive('survival', 0.01);
    }
  }

  /**
   * ITER-11 (WS-5 item 3 · brief §6.1 item 3): feed archive COVERAGE and
   * useful-outcome novelty into the novelty drive, bounded and deterministic.
   *
   * One call applies three clamped components to the novelty drive:
   *
   *   coverage  — an unexplored descriptor space keeps the want alive, so a
   *               coverage ratio below 1 DEPLETES the drive by
   *               `NOVELTY_COVERAGE_STEP × unexplored_share` (and a saturated
   *               archive adds nothing);
   *   waste     — `unnecessary_cost` outcomes deplete it too (cost without
   *               value is not novelty satisfied);
   *   useful    — useful outcomes REPLENISH it, mirroring the outcome channel's
   *               own reward.
   *
   * The TOTAL is clamped to ±`NOVELTY_REPLENISHMENT_BOUND`, so no single call
   * — however hostile its inputs — can move the drive by more than the bound.
   *
   * THE PER-IDENTITY LIMIT, stated plainly: this engine is a PROCESS-WIDE
   * singleton (`DRIVE_CONFIGS` and `this.drives` are shared), so the adjustment
   * lands on the shared novelty drive even though the inputs are read per
   * identity and mission. The returned record carries the identity they came
   * from, which is as far as per-identity guarding can honestly go without
   * re-keying every drive in the process — a change this iteration does not
   * make. Two identities' cycles in one process therefore move one drive.
   */
  applyNoveltyReplenishment(input: NoveltyReplenishmentInput): NoveltyReplenishment {
    const before = this.drives.novelty.current;
    const target = Math.max(0, Number(input?.coverage_target) || 0);
    const cells = Math.max(0, Number(input?.coverage_cells) || 0);
    const coverageRatio = target > 0 ? Math.min(1, cells / target) : 1;
    const unexplored = Math.max(0, 1 - coverageRatio);
    const useful = Math.max(0, Math.floor(Number(input?.useful_outcomes) || 0));
    const wasted = Math.max(0, Math.floor(Number(input?.wasted_outcomes) || 0));

    const coverageComponent = Number((-(NOVELTY_COVERAGE_STEP * unexplored)).toFixed(6));
    const wasteComponent = Number((-(NOVELTY_WASTE_STEP * Math.min(wasted, 5))).toFixed(6));
    const usefulComponent = Number((NOVELTY_USEFUL_STEP * Math.min(useful, 5)).toFixed(6));
    const raw = coverageComponent + wasteComponent + usefulComponent;
    const applied = Number(
      Math.max(-NOVELTY_REPLENISHMENT_BOUND, Math.min(NOVELTY_REPLENISHMENT_BOUND, raw)).toFixed(6),
    );
    if (applied !== 0) this.replenishDrive('novelty', applied);
    const after = this.drives.novelty.current;

    return {
      user_id: String(input?.user_id ?? ''),
      mission_id: typeof input?.mission_id === 'string' && input.mission_id.length > 0 ? input.mission_id : null,
      before: Number(before.toFixed(6)),
      after: Number(after.toFixed(6)),
      applied,
      coverage_component: coverageComponent,
      waste_component: wasteComponent,
      useful_component: usefulComponent,
      bound: NOVELTY_REPLENISHMENT_BOUND,
      basis:
        `novelty drive ${Number(before.toFixed(6))} → ${Number(after.toFixed(6))} (applied ${applied}, bound ±${NOVELTY_REPLENISHMENT_BOUND}) ` +
        `from coverage ${cells}/${target} (unexplored ${Number(unexplored.toFixed(6))}, ${coverageComponent}), ` +
        `${wasted} unnecessary_cost outcome(s) (${wasteComponent}) and ${useful} useful outcome(s) (${usefulComponent}); ` +
        'the engine is a process-wide singleton, so the adjustment lands on the SHARED novelty drive and the identity ' +
        'is recorded on this result rather than keyed into the drive',
    };
  }

  getDriveDeficits(): Record<DriveName, number> {
    const deficits: Record<string, number> = {};
    for (const name of Object.keys(this.drives) as DriveName[]) {
      const drive = this.drives[name];
      deficits[name] = parseFloat(Math.max(0, Math.min(1, 1 - drive.current / drive.target)).toFixed(4));
    }
    return deficits as Record<DriveName, number>;
  }

  getAverageDeficit(): number {
    const deficits = this.getDriveDeficits();
    const values = Object.values(deficits);
    return parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4));
  }

  computeIncentiveSalience(params: IncentiveSalienceParams): IncentiveSalienceResult {
    const base = params.base ?? 0.5;
    const valence = params.valence ?? 0;
    const trend = params.trend ?? 0;
    const novelty = params.novelty ?? 0;
    const pe = params.pe ?? 0;
    const goal = params.goal ?? 0;

    const wanting = Math.max(0, Math.min(1,
      base + 0.25 * valence + 0.15 * trend + 0.10 * novelty + 0.20 * pe + 0.30 * goal
    ));

    const liking = valence;
    const divergence = Math.abs(wanting - liking);

    return {
      wanting: parseFloat(wanting.toFixed(4)),
      liking: parseFloat(liking.toFixed(4)),
      divergence: parseFloat(divergence.toFixed(4)),
      components: { base, valence, trend, novelty, pe, goal },
    };
  }

  async getSourceTrust(sourceId: string): Promise<SourceTrustRecord> {
    const db = get_database();
    const record = await db.collection('source_trust_records').findOne({ source_id: sourceId });
    if (!record) {
      return {
        sourceId,
        trustScore: 0.5,
        corroborationCount: 0,
        contradictionCount: 0,
        lastUpdated: new Date(),
      };
    }
    return {
      sourceId: record.source_id,
      trustScore: record.trust_score,
      corroborationCount: record.corroboration_count || 0,
      contradictionCount: record.contradiction_count || 0,
      lastUpdated: record.last_updated,
    };
  }

  async updateSourceTrust(sourceId: string, event: TrustEventType): Promise<SourceTrustRecord> {
    const db = get_database();
    const existing = await db.collection('source_trust_records').findOne({ source_id: sourceId });

    let trustScore = existing ? existing.trust_score : 0.5;
    let corroborationCount = existing ? (existing.corroboration_count || 0) : 0;
    let contradictionCount = existing ? (existing.contradiction_count || 0) : 0;

    if (event === 'corroboration') {
      trustScore = Math.min(1, trustScore + 0.02);
      corroborationCount += 1;
    } else {
      trustScore = Math.max(0, trustScore - 0.15);
      contradictionCount += 1;
    }

    const now = new Date();
    await db.collection('source_trust_records').updateOne(
      { source_id: sourceId },
      {
        $set: {
          trust_score: parseFloat(trustScore.toFixed(4)),
          corroboration_count: corroborationCount,
          contradiction_count: contradictionCount,
          last_updated: now,
        },
        $setOnInsert: { source_id: sourceId },
      },
      { upsert: true }
    );

    return {
      sourceId,
      trustScore: parseFloat(trustScore.toFixed(4)),
      corroborationCount,
      contradictionCount,
      lastUpdated: now,
    };
  }

  async applyTrustDecay(): Promise<void> {
    const db = get_database();
    const records = await db.collection('source_trust_records').find({}).toArray();
    const now = new Date();
    for (const record of records) {
      const lastUpdated = record.last_updated ? new Date(record.last_updated) : now;
      const daysElapsed = (now.getTime() - lastUpdated.getTime()) / (24 * 60 * 60 * 1000);
      if (daysElapsed > 0) {
        const decay = 0.01 * daysElapsed;
        const newScore = Math.max(0, record.trust_score - decay);
        await db.collection('source_trust_records').updateOne(
          { source_id: record.source_id },
          { $set: { trust_score: parseFloat(newScore.toFixed(4)), last_updated: now } }
        );
      }
    }
  }
}
