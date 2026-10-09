import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

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
    include: ['src/**/*.spec.ts'],
    setupFiles: ['src/testing/vitest.setup.ts'],
    env: { NODE_ENV: 'test' },
  },
});
