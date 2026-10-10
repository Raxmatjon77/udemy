import { defineConfig } from 'vitest/config';

// No decorators here, so Vite's default TS transform is enough (the apps need SWC for Nest DI).
// `*.spec.mts` are the ESM specs of the `@udemy/contracts/testing` subpath (src/testing).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.mts'],
  },
});
