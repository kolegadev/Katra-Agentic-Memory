// F8 fixture: the ambiguous initializer makeIt() IMPORT-BOUND to
// ret-ambig-1.ts → its return type EngineA is disambiguated by the import →
// x.goA() resolves to EngineA.goA() (INFERRED), never EngineB.
import { makeIt } from './ret-ambig-1.js';

export function bound(): void {
  const x = makeIt();
  x.goA();
}
