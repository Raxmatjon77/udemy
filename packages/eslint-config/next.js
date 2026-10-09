import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import base from './base.js';

/**
 * Flat config for the Next.js apps (and @udemy/ui, which only ships to them).
 *
 * Why the plugins directly instead of `eslint-config-next`:
 * eslint-config-next@16 also pulls in eslint-plugin-react, eslint-plugin-import and
 * eslint-plugin-jsx-a11y, whose peer ranges stop at ESLint 9 (Next's own upgrade guide says
 * "eslint-config-next@16 requires ESLint 9"). We are on ESLint 10, so we compose only the
 * pieces that support it: @next/eslint-plugin-next (no eslint peer) and
 * eslint-plugin-react-hooks@7 (peer includes ^10). typescript-eslint comes from ./base.js.
 * Revisit jsx-a11y once it declares ESLint 10 support.
 */
export default [
  ...base,
  { ignores: ['.next/**', 'out/**', 'build/**', 'next-env.d.ts'] },
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
    languageOptions: {
      // Server components, route handlers and config files run on Node; client components in the browser.
      globals: { ...globals.browser, ...globals.node },
    },
  },
  nextPlugin.configs.recommended,
  nextPlugin.configs['core-web-vitals'],
  {
    rules: {
      // Pages Router only (scans a pages/ dir we don't have; it logs a warning in @udemy/ui).
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
  // Classic rules-of-hooks/exhaustive-deps plus the React Compiler-powered rules.
  reactHooks.configs.flat.recommended,
];
