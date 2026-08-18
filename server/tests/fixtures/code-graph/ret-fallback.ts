// F8 gate-regression fixture (live shape): makeX() declares NO returnType
// anywhere → the F8 branch fails on the initializer lookup and must FALL
// THROUGH to the F6 ladder. `.start()` has candidates in a test file
// (start.test.ts) and a non-test file (ret-lib.ts) → test-path preference
// resolves to the NON-test method (INFERRED).
export function makeX() {
  return {};
}

export function useFallback(): void {
  const e = makeX();
  e.start();
}
