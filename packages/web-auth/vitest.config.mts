import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Next aliases `server-only` to an empty module for server bundles; do the same in tests.
      'server-only': fileURLToPath(new URL('./src/internal/test-empty-module.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
