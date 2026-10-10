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
    // The server env the BFF config reads (src/lib/env.ts) for route-handler specs; fake hosts,
    // MSW answers for them.
    env: {
      API_INTERNAL_URL: 'http://api.test',
      API_CLIENT_ID: 'instructor-bff',
      API_CLIENT_SECRET: 'test-secret',
      APP_ORIGIN: 'http://localhost:3001',
      JWT_ISSUER: 'http://api.test',
      JWT_AUDIENCE: 'udemy-api',
      JWKS_URL: 'http://api.test/.well-known/jwks.json',
      COOKIE_SECURE: 'true',
      MEDIA_PUBLIC_ORIGIN: 'http://127.0.0.1:9000',
      STUDENT_APP_ORIGIN: 'http://localhost:3000',
    },
  },
});
