import base from '@udemy/eslint-config/base';
import globals from 'globals';

export default [
  ...base,
  { ignores: ['.output/**'] },
  {
    languageOptions: { globals: globals.node },
    rules: {
      // Playwright fixtures use `async ({}, use) => …` when they need no other fixture.
      'no-empty-pattern': 'off',
    },
  },
];
