import base from '@udemy/eslint-config/base';

export default [
  { ignores: ['dist/**', 'src/generated/**'] },
  ...base,
  // CLI scripts legitimately print to stdout.
  { files: ['src/cli/**'], rules: { 'no-console': 'off' } },
];
