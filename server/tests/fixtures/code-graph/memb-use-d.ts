// F7 fixture: same-file return-type flow → typeSource 'return_flow' (INFERRED).
import { Store } from './memb-lib.js';
function makeStore(): Store { return new Store(); }
export function flow(): number { const s = makeStore(); return s.count(); }
