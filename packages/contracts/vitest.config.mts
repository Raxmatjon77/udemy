import { defineConfig } from 'vitest/config';

// No decorators here, so Vite's default TS transform is enough (the apps need SWC for Nest DI).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
