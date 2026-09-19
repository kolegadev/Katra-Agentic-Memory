// Facade + feature-flag gate for the long-horizon cognitive control plane.
// COGNITIVE_CONTROL_ENABLED = off | read | write (default off).
// When off (production default), none of this module is reachable via MCP.
// Part of the no-publish branch feat/cognitive-control-local.
import type { Db } from 'mongodb';
import { ensureMissionCognitionIndexes } from './collections.js';
import { MissionStateService } from './mission-state-service.js';
import { StateDeltaService } from './state-delta-service.js';
import { EpistemicLedgerService } from './epistemic-ledger-service.js';
import { BatonService } from './baton-service.js';
import { adoptLegacyMission } from './adapter.js';

export type CognitiveControlMode = 'off' | 'read' | 'write';

export function cognitiveControlMode(): CognitiveControlMode {
  const value = (process.env.COGNITIVE_CONTROL_ENABLED ?? 'off').toLowerCase();
  if (value === 'write') return 'write';
  if (value === 'read') return 'read';
  return 'off';
}

export interface MissionCognitionServices {
  missions: MissionStateService;
  deltas: StateDeltaService;
  ledger: EpistemicLedgerService;
  batons: BatonService;
  adoptLegacyMission: (legacyMissionId: string) => Promise<import('../../types/cognitive-control.js').MissionState>;
  ensureIndexes: () => Promise<void>;
}

let _services: MissionCognitionServices | null = null;

export function getMissionCognitionServices(db: Db): MissionCognitionServices {
  let services = _services;
  if (!services) {
    services = {
      missions: new MissionStateService(db),
      deltas: new StateDeltaService(db),
      ledger: new EpistemicLedgerService(db),
      batons: new BatonService(db),
      adoptLegacyMission: (missionId: string) => adoptLegacyMission(db, missionId),
      ensureIndexes: () => ensureMissionCognitionIndexes(db),
    };
    _services = services;
  }
  return services;
}
