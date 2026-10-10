import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // tsconfig says `jsx: preserve` (Next compiles JSX); tests need the automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
      // Next aliases `server-only` to an empty module for server bundles; do the same in tests.
      'server-only': fileURLToPath(new URL('./src/test/empty-module.ts', import.meta.url)),
    },
  },
  test: {
    // jsdom component tests drive real timers, dnd and TanStack polling; under a full parallel
    // turbo run (or a shared CI runner) the 5 s default flaked. Assertions are unchanged.
    testTimeout: 20_000,
    // Pure modules run in node; component specs opt into jsdom with a
    // `// @vitest-environment jsdom` docblock.
    environment: 'node',
    include: ['src/**/*.spec.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
