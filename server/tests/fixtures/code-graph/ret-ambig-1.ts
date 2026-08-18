// F8 fixture: makeIt() is declared in TWO files with DIFFERENT return types
// (EngineA here, EngineB in ret-ambig-2.ts) — an unimported initializer call
// is ambiguous and must be skipped; import evidence disambiguates.
export class EngineA {
  goA(): void {}
}

export function makeIt(): EngineA {
  return new EngineA();
}
