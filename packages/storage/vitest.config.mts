import { configDefaults, defineConfig } from 'vitest/config';

/**
 * `*.integration.spec.ts` talk to the running dev MinIO (src/testing/it-s3.ts) and run one file
 * at a time; unit specs stay parallel. 30 s timeouts match apps/api: the MinIO probe gives up at
 * 25 s with a precise message before vitest's anonymous "Hook timed out".
 */
const INTEGRATION_SPECS = ['src/**/*.integration.spec.ts'];

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          exclude: [...configDefaults.exclude, ...INTEGRATION_SPECS],
        },
      },
      {
        extends: true,
        test: { name: 'integration', include: INTEGRATION_SPECS, fileParallelism: false },
      },
    ],
  },
});
