// F8 fixture: `const e = makeEngine()` where makeEngine lives in ret-lib.ts
// (import-bound) → e.start() resolves to ret-lib's Engine.start() via the
// cross-file return-type index (INFERRED).
import { makeEngine } from './ret-lib.js';

export function boot(): void {
  const e = makeEngine();
  e.start();
}
