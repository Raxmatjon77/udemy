import { configDefaults, defineConfig } from 'vitest/config';

/**
 * `*.integration.spec.ts` are the stripe-mock contract tests (src/testing/it-stripe-mock.mts) and
 * run one file at a time; unit specs stay parallel. The integration hook timeout covers a first
 * `docker run` that has to pull the stripe-mock image locally.
 */
const INTEGRATION_SPECS = ['src/**/*.integration.spec.ts'];

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test', STRIPE_SUPPRESS_NOTICES: 'true' },
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
        test: {
          name: 'integration',
          include: INTEGRATION_SPECS,
          fileParallelism: false,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
