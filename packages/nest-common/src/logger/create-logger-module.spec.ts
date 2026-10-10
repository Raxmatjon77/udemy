import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildPinoParams, LOG_REDACT_CENSOR, LOG_REDACT_PATHS } from './create-logger-module';

/** A pino logger with exactly the redaction config the apps use, writing into an array. */
function captureLogger(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
  const output: string[] = [];
  const logger = pino(
    { redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR } },
    { write: (line: string) => output.push(line) },
  );
  return {
    logger,
    lines: () => output.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const SECRETS = {
  password: 'pw-1',
  newPassword: 'pw-2',
  currentPassword: 'pw-3',
  token: 'tok-1',
  refreshToken: 'rt-1',
  accessToken: 'at-1',
};

describe('pino redaction', () => {
  it('is what buildPinoParams configures', () => {
    const params = buildPinoParams(
      { NODE_ENV: 'production', LOG_LEVEL: 'info' },
      { serviceName: 's' },
    );

    expect(params.pinoHttp).toMatchObject({
      redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
    });
  });

  it('redacts credential headers of a logged request', () => {
    const { logger, lines } = captureLogger();

    logger.info({
      req: {
        headers: {
          authorization: 'Bearer eyJ.secret',
          cookie: '__Host-udemy-student-rt=abc',
          'x-client-secret': 'bff-secret',
          'x-client-id': 'student-bff',
        },
      },
      res: { headers: { 'set-cookie': 'a=b' } },
    });

    const line = JSON.stringify(lines()[0]);
    for (const secret of ['eyJ.secret', '__Host-udemy-student-rt=abc', 'bff-secret', 'a=b']) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain('student-bff');
  });

  it.each([
    ['at the top level', (body: object) => body],
    ['in a logged body', (body: object) => ({ body })],
    ['in a logged request body', (body: object) => ({ req: { body } })],
  ])('redacts sensitive fields %s', (_where, wrap) => {
    const { logger, lines } = captureLogger();

    logger.info(wrap({ ...SECRETS, email: 'a@b.c' }), 'login');

    const line = JSON.stringify(lines()[0]);
    for (const secret of Object.values(SECRETS)) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain(LOG_REDACT_CENSOR);
    expect(line).toContain('a@b.c');
  });
});
