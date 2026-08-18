// F8-gate regression fixture: a TEST-file declaration of a method-named
// symbol (`.start()`). The filename matches the `*.test.*` convention, so
// Graphify's test-path preference (isTestPath / preferNonTest) must keep
// real NON-test callers of start() resolving to non-test candidates instead
// of skipping on the ambiguity this fixture introduces.
export class Shutdown {
  start(): void {}
}
