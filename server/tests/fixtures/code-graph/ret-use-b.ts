// F8 control case: an explicitly annotated receiver is the F7 path —
// typeName resolves at extract time, no initializerCall is emitted.
import { Engine } from './ret-lib.js';

export function typed(): void {
  const e: Engine = new Engine();
  e.stop();
}
