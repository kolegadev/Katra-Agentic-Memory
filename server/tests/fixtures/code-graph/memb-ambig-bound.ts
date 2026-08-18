// F7 fixture: ambiguous type name `Dup` (exported by TWO fixture files)
// IMPORT-BOUND to memb-ambig-class-a.ts → the typed receiver resolves to the
// imported file's class method via the F7 import-evidence branch.
import { Dup } from './memb-ambig-class-a.js';
export function boundCall(d: Dup): void { d.ping(); }
