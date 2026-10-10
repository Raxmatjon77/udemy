import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.{ts,tsx}'],
    // The corpus includes 100k-char and pathological inputs with their own explicit time budgets;
    // the generous default only keeps a loaded CI box from failing on wall-clock noise.
    testTimeout: 30_000,
  },
});
