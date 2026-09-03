/**
 * Katra Vault — per-service driver registry (F7)
 *
 * Typed service drivers sit on top of the capability core: each op receives
 * a DriverContext (the capability's vaultHttp bound to one caller + secret)
 * plus op arguments, and returns the parsed upstream body — the secret never
 * appears in the op signature.
 *
 * Registering the same service twice replaces the previous driver (last
 * registration wins), which lets tests re-register a driver.
 */

import type { CapabilityInput, CapabilityResult } from '../capability.js';
import type { CallerIdentity } from '../../../utils/caller-identity.js';

export interface DriverContext {
  /** Approval-gated vaultHttp bound to `caller` + `secretId` for this
   *  driver's service. */
  vaultHttp(input: CapabilityInput): Promise<CapabilityResult>;
  caller: CallerIdentity;
  secretId: string;
}

export type DriverOp<A extends unknown[], R> = (
  ctx: DriverContext,
  ...args: A
) => Promise<R>;

export interface ServiceDriver {
  service: string;
  ops: Record<string, DriverOp<any[], any>>;
}

const registeredDrivers = new Map<string, ServiceDriver>();

export function registerDriver(driver: ServiceDriver): void {
  if (!driver || typeof driver.service !== 'string' || driver.service.length === 0) {
    throw new Error('vault: driver requires a non-empty service name');
  }
  if (!driver.ops || typeof driver.ops !== 'object') {
    throw new Error(`vault: driver '${driver.service}' requires an ops map`);
  }
  registeredDrivers.set(driver.service, driver);
}

export function getDriver(service: string): ServiceDriver | undefined {
  return registeredDrivers.get(service);
}
