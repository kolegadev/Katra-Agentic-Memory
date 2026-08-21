import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // tests/fixtures/** holds code-graph scan fixtures (some intentionally
    // named *.test.ts to exercise Graphify's test-path preference) — they are
    // not test suites.
    exclude: ['node_modules', 'build', 'tests/fixtures/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**', 'src/mcp-server.ts', 'src/index.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 40,
        branches: 30,
        functions: 40,
        lines: 40,
      },
    },
  },
});
