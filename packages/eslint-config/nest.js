import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import base from './base.js';

/**
 * Enforces the modular-monolith rules from docs/architecture-plan.md:
 * - domain is pure (imports nothing from other layers)
 * - a module may only reach another module through its public facade (index.ts)
 */
export default [
  ...base,
  {
    languageOptions: { globals: globals.node },
    plugins: { boundaries },
    settings: {
      // Lets boundaries resolve extensionless TS imports ('../domain/course'); without it
      // imports can't be classified and the layer rules silently pass.
      'import/resolver': { node: { extensions: ['.ts', '.js'] } },
      'boundaries/elements': [
        { type: 'domain', pattern: 'src/modules/*/domain', capture: ['module'] },
        { type: 'application', pattern: 'src/modules/*/application', capture: ['module'] },
        { type: 'infrastructure', pattern: 'src/modules/*/infrastructure', capture: ['module'] },
        { type: 'presentation', pattern: 'src/modules/*/presentation', capture: ['module'] },
        {
          type: 'module-facade',
          pattern: 'src/modules/*/index.ts',
          mode: 'file',
          capture: ['module'],
        },
        { type: 'shared', pattern: 'src/shared' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'domain', allow: [['domain', { module: '${from.module}' }], 'shared'] },
            {
              from: 'application',
              allow: [
                ['domain', { module: '${from.module}' }],
                ['application', { module: '${from.module}' }],
                'module-facade',
                'shared',
              ],
            },
            {
              from: 'infrastructure',
              allow: [
                ['domain', { module: '${from.module}' }],
                ['application', { module: '${from.module}' }],
                ['infrastructure', { module: '${from.module}' }],
                'shared',
              ],
            },
            {
              from: 'presentation',
              allow: [
                ['application', { module: '${from.module}' }],
                ['domain', { module: '${from.module}' }],
                ['presentation', { module: '${from.module}' }],
                'shared',
              ],
            },
            {
              from: 'module-facade',
              allow: [
                ['application', { module: '${from.module}' }],
                ['domain', { module: '${from.module}' }],
                ['presentation', { module: '${from.module}' }],
                ['infrastructure', { module: '${from.module}' }],
              ],
            },
            { from: 'shared', allow: ['shared'] },
          ],
        },
      ],
    },
  },
];
