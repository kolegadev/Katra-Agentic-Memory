// Phase 5 assumption-dependency traversal (criteria 5-7): transitive
// DEPENDENTS of an entry through depends_on. Cycle-safe, depth-bounded,
// reports the bound it applied. Deterministic. No model calls.
// Part of the no-publish branch feat/cognitive-control-local.
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import type { DependencyTrace } from '../../types/cognitive-control.js';

const MAX_DEPTH = 8;

export async function traceAssumptionDependencies(
  db: Db,
  missionId: string,
  entryId: string,
  depthBound: number = MAX_DEPTH,
): Promise<DependencyTrace> {
  const all = await db
    .collection(COLLECTIONS.epistemicEntries)
    .find({ mission_id: missionId }, { projection: { _id: 0, entry_id: 1, depends_on: 1 } })
    .toArray() as unknown as Array<{ entry_id: string; depends_on?: string[] }>;

  const dependentsOf = new Map<string, string[]>();
  for (const e of all) {
    for (const dep of e.depends_on ?? []) {
      const list = dependentsOf.get(dep) ?? [];
      list.push(e.entry_id);
      dependentsOf.set(dep, list);
    }
  }

  const visited = new Set<string>();
  const inPath = new Set<string>();
  let cycleDetected = false;
  const result: string[] = [];

  const walk = (id: string, depth: number): void => {
    if (depth > depthBound) {
      cycleDetected = true; // depth bound applied — report it honestly
      return;
    }
    if (inPath.has(id)) {
      cycleDetected = true;
      return;
    }
    if (visited.has(id)) return;
    inPath.add(id);
    for (const next of dependentsOf.get(id) ?? []) {
      walk(next, depth + 1);
    }
    inPath.delete(id);
    visited.add(id);
    if (id !== entryId) result.push(id);
  };
  walk(entryId, 0);

  return { root_entry_id: entryId, dependents: result, depth_bound_applied: depthBound, cycle_detected: cycleDetected };
}
