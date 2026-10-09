import nest from '@udemy/eslint-config/nest';

export default [
  ...nest,
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'nestjs-pino',
              message: 'Import logger helpers from @udemy/nest-common (single nestjs-pino copy).',
            },
          ],
        },
      ],
    },
  },
];
