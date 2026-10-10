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
    // Ed25519 signing and the JWKS round trips are CPU-bound; under a full parallel turbo run the
    // 5 s default was too tight. Matches the api's budget.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
