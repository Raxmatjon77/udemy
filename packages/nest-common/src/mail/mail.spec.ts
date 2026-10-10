import { describe, expect, it } from 'vitest';
import { DependencyUnavailableError } from '../errors/dependency-unavailable.error';
import { mailEnvSchema } from './mail-env.schema';
import { eventMessageId, isValidMessageId } from './message-id';
import { SmtpMailer } from './smtp-mailer';

describe('eventMessageId', () => {
  it('builds <eventId@udemy.local>', () => {
    const id = eventMessageId('0199b0a4-0000-7000-8000-000000000001');

    expect(id).toBe('<0199b0a4-0000-7000-8000-000000000001@udemy.local>');
    expect(isValidMessageId(id)).toBe(true);
  });

  it('rejects ids that could break the header', () => {
    expect(() => eventMessageId('a>\r\nBcc: x@y')).toThrow(TypeError);
    expect(isValidMessageId('no-brackets@x')).toBe(false);
    expect(isValidMessageId('<a b@x>')).toBe(false);
  });
});

describe('mailEnvSchema', () => {
  it.each(['no-reply@udemy.local', 'Udemy Clone <no-reply@udemy.local>'])(
    'accepts MAIL_FROM %s',
    (from) => {
      expect(
        mailEnvSchema.safeParse({ SMTP_HOST: 'localhost', SMTP_PORT: '1025', MAIL_FROM: from })
          .success,
      ).toBe(true);
    },
  );

  it.each(['udemy', 'Udemy <>', '<a@b'])('rejects MAIL_FROM %s', (from) => {
    expect(
      mailEnvSchema.safeParse({ SMTP_HOST: 'localhost', SMTP_PORT: '1025', MAIL_FROM: from })
        .success,
    ).toBe(false);
  });
});

describe('SmtpMailer', () => {
  it('rejects a malformed messageId before talking to the server', async () => {
    const mailer = new SmtpMailer({ host: '127.0.0.1', port: 1, from: 'a@b.c', pool: false });

    await expect(
      mailer.send({ to: 'x@y.z', subject: 's', text: 't', messageId: 'not-an-id' }),
    ).rejects.toThrow(TypeError);
  });

  it('maps an unreachable server to DependencyUnavailableError', async () => {
    // Port 1 on loopback: nothing listens there, so the connection is refused at once.
    const mailer = new SmtpMailer({
      host: '127.0.0.1',
      port: 1,
      from: 'a@b.c',
      pool: false,
      connectionTimeoutMs: 1_000,
    });

    const error: unknown = await mailer
      .send({ to: 'x@y.z', subject: 's', text: 't' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DependencyUnavailableError);
    expect(error).toMatchObject({ dependency: 'smtp' });
    mailer.close();
  });
});
