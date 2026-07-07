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
