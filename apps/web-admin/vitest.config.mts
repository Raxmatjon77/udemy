import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
      // Next aliases `server-only` to an empty module for server bundles; do the same in tests.
      'server-only': fileURLToPath(new URL('./src/test/empty-module.ts', import.meta.url)),
    },
  },
  // tsconfig says `jsx: preserve` (Next compiles JSX itself); tests need the React 17+ runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // jsdom component tests drive real timers, dnd and TanStack polling; under a full parallel
    // turbo run (or a shared CI runner) the 5 s default flaked. Assertions are unchanged.
    testTimeout: 20_000,
    // Plain Node by default; component tests (`*.spec.tsx`) opt into jsdom with a docblock.
    environment: 'node',
    include: ['src/**/*.spec.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
