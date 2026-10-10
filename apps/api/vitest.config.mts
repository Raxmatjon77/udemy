import swc from 'unplugin-swc';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Specs that talk to the real Postgres/Redis (src/testing/integration.ts) or boot the whole
 * AppModule. They run one file at a time; everything else stays parallel.
 */
const INFRA_SPECS = ['src/**/*.integration.spec.ts', 'src/**/*.e2e.spec.ts'];

export default defineConfig({
  // Vite's default TS transform (oxc) cannot emit decorator metadata, which Nest's DI needs
  // (`design:paramtypes`). SWC can, so tests see the same metadata as the tsc build.
  plugins: [
    swc.vite({
      tsconfigFile: false,
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    environment: 'node',
    setupFiles: ['src/testing/vitest.setup.ts'],
    env: { NODE_ENV: 'test' },
    // Measured under a full parallel `turbo run lint typecheck test build` on this machine: unit
    // files that boot a Nest testing module took up to 3.5 s (vitest's 5 s default is too tight
    // when the host is 3-6x slower than idle), and connecting to Postgres/Redis through Docker
    // Desktop took up to ~25 s. The integration probes give up at 25 s (PROBE_TIMEOUT_MS) with a
    // precise message, so 30 s keeps that message ahead of vitest's anonymous "Hook timed out".
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          exclude: [...configDefaults.exclude, ...INFRA_SPECS],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: INFRA_SPECS,
          // One file at a time (vitest schedules them after the parallel unit files): files no
          // longer pile connection setup, Argon2 and Nest boots onto a loaded Docker VM at once,
          // and a file can never observe another file's in-flight writes or locks.
          fileParallelism: false,
        },
      },
    ],
  },
});
