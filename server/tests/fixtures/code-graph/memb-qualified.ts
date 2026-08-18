// F7 fixture: qualified and generic type annotations reduce to the last bare
// segment — `ns.Store<number>[]` → `Store`, `Map<string, number>` → `Map`.
export function qualified(): void {
  const a: ns.Store<number>[] = [];
  a.count();
  let m: Map<string, number>;
  m.get('k');
}
