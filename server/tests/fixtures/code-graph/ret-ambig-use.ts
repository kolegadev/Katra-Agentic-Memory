// F8 fixture: makeIt() is called WITHOUT importing either declaring file →
// the initializer's return type is ambiguous → x.goA() must be skipped
// (god-node guard, skippedAmbiguous).
export function useAmbiguous(): void {
  const x = makeIt();
  x.goA();
}
