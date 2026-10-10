import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // One process per spec file, so process.cpuUsage() in the performance specs measures only that
    // file's work (see src/testing/cpu-time.ts).
    pool: 'forks',
    include: ['src/**/*.spec.{ts,tsx}'],
    // Pathological inputs have their own CPU-time ceilings; this only bounds a hung test.
    testTimeout: 30_000,
  },
});
