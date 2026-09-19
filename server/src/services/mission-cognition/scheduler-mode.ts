// Phase 6: scheduler-mode ladder — runtime state, kill switch, fail-closed parsing.
//
// COGNITIVE_SCHEDULER_MODE     = off | shadow | recommend | allocate_internal | allocate_gated
//                                 (default off). Parsed here, fails closed on unknown values.
//                                 `allocate_gated` is recognised by the TYPE but not enabled:
//                                 no externally-visible effect pathway exists to gate, so per
//                                 contract §4.6 the mode is not implemented and enabling it is
//                                 refused (see activation-service).
// COGNITIVE_ACTIVATION_KILL_SWITCH = unset | 1  — forced `off` regardless of every other flag.
//                                 Tested by actually setting it: schedulerMode() === 'off'.
//
// A runtime override lets set_scheduler_mode take effect without a rebuild; every runtime
// transition goes through ActivationService.setMode, which records it in the activation ledger
// BEFORE the override is applied. The override alone can never open a gate.
// Part of the no-publish branch feat/cognitive-control-local.
import type { SchedulerMode } from '../../types/cognitive-control.js';

export const SCHEDULER_MODE_LADDER: SchedulerMode[] = [
  'off',
  'shadow',
  'recommend',
  'allocate_internal',
  'allocate_gated',
];

/** Modes that Phase 6 actually implements (contract §4.6: allocate_gated stays unimplemented). */
export const IMPLEMENTED_MODES: SchedulerMode[] = ['off', 'shadow', 'recommend', 'allocate_internal'];

export function killSwitchActive(): boolean {
  return process.env.COGNITIVE_ACTIVATION_KILL_SWITCH === '1';
}

export function envSchedulerMode(): SchedulerMode {
  const value = (process.env.COGNITIVE_SCHEDULER_MODE ?? 'off').toLowerCase();
  if (killSwitchActive()) return 'off';
  if (value === 'shadow') return 'shadow';
  if (value === 'recommend') return 'recommend';
  if (value === 'allocate_internal') return 'allocate_internal';
  // Unknown values AND allocate_gated fail closed to off (never fail open).
  return 'off';
}

let runtimeMode: SchedulerMode | null = null;

export function schedulerMode(): SchedulerMode {
  if (killSwitchActive()) return 'off';
  if (runtimeMode !== null) return runtimeMode;
  return envSchedulerMode();
}

/**
 * Apply a runtime transition. Callers MUST have recorded the transition in the
 * activation ledger first (ActivationService.setMode does both). Exported for
 * tests only; never call directly from product code.
 */
export function setRuntimeSchedulerMode(mode: SchedulerMode): void {
  runtimeMode = mode;
}

/** Test helper: return to env-driven mode. */
export function resetRuntimeSchedulerMode(): void {
  runtimeMode = null;
}
