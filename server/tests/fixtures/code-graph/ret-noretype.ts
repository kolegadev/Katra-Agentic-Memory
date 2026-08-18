// F8 fixture: noTypeFn declares NO return annotation → it never enters the
// return-type index → an initializerCall to it stays skipped (one-hop /
// no-annotation guard).
import { Engine } from './ret-lib.js';

export function noTypeFn() {
  return new Engine();
}

export function usesNoType(): void {
  const e = noTypeFn();
  e.stop();
}
