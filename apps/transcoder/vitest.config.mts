import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC instead of Vite's default TS transform so decorator metadata (Nest DI) is emitted.
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
    include: ['src/**/*.spec.ts'],
    setupFiles: ['src/testing/vitest.setup.ts'],
    env: { NODE_ENV: 'test' },
    // ffmpeg-based specs encode real (tiny) clips; the integration specs run a whole job.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
