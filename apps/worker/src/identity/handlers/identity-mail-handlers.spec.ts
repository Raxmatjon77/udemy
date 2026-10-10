import type { EventEnvelope } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { NonRetryableError } from '../../messaging';
import { IdentityLinks } from '../mail/identity-links';
import { type UserContact, UserContactReader } from '../../shared/mail/user-contact.reader';
import { IssueOneTimeToken } from '../one-time-tokens/issue-one-time-token';
import { deriveOneTimeToken } from '../one-time-tokens/one-time-token';
import {
  FAKE_TRX,
  fakeConfig,
  InMemoryOneTimeTokenStore,
  RecordingMailer,
  TEST_SECRET,
} from '../testing/identity-mail.fakes';
import { AccountExistsMailerHandler } from './account-exists-mailer.handler';
import { EmailVerificationMailerHandler } from './email-verification-mailer.handler';
import { PasswordResetMailerHandler } from './password-reset-mailer.handler';
import {
  PasswordChangedMailerHandler,
  SessionCompromiseMailerHandler,
} from './security-notice-mailer.handlers';

const USER = '0199c8a0-0000-7000-8000-000000000001';
const EVENT = '0199c8a0-0000-7000-8000-0000000000e1';
const NOW = new Date('2026-10-10T10:00:00.000Z');

function envelope(eventType: string, payload: unknown, version = 1): EventEnvelope {
  return {
    eventId: EVENT,
    eventType,
    aggregateType: 'identity.user',
    aggregateId: USER,
    occurredAt: NOW.toISOString(),
    version,
    payload,
  };
}

class FakeContacts extends UserContactReader {
  constructor(private readonly contact: UserContact | null) {
    super();
  }
  override async find(_trx: Transaction<DB>, _userId: string): Promise<UserContact | null> {
    return this.contact;
  }
}

describe('identity mail handlers', () => {
  let store: InMemoryOneTimeTokenStore;
  let mailer: RecordingMailer;
  let issuer: IssueOneTimeToken;
  const links = new IdentityLinks(fakeConfig());

  beforeEach(() => {
    store = new InMemoryOneTimeTokenStore(NOW);
    store.users.set(USER, { email: 'jane@example.com' });
    mailer = new RecordingMailer();
    issuer = new IssueOneTimeToken(store, fakeConfig());
  });

  const verificationEvent = (overrides: Record<string, unknown> = {}) =>
    envelope('EmailVerificationRequested', {
      userId: USER,
      email: 'jane@example.com',
      displayName: 'Jane',
      reason: 'SIGNUP',
      requestedAt: NOW.toISOString(),
      ...overrides,
    });

  describe('EmailVerificationMailerHandler', () => {
    it('issues the token and mails a fragment link with Message-ID <eventId@udemy.local>', async () => {
      const handler = new EmailVerificationMailerHandler(issuer, mailer, links);
      await handler.handle(verificationEvent(), FAKE_TRX);

      const raw = deriveOneTimeToken(TEST_SECRET, EVENT, 'EMAIL_VERIFICATION');
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]).toMatchObject({
        to: 'jane@example.com',
        messageId: `<${EVENT}@udemy.local>`,
      });
      expect(mailer.sent[0]?.text).toContain(`http://localhost:3000/verify-email#token=${raw}`);
      expect(store.rowFor(EVENT)?.purpose).toBe('EMAIL_VERIFICATION');
    });

    it('a redelivery sends the same link and Message-ID again', async () => {
      const handler = new EmailVerificationMailerHandler(issuer, mailer, links);
      await handler.handle(verificationEvent(), FAKE_TRX);
      await handler.handle(verificationEvent(), FAKE_TRX);

      expect(mailer.sent).toHaveLength(2);
      expect(mailer.sent[1]).toEqual(mailer.sent[0]);
      expect(store.rowFor(EVENT)?.invalidatedAt).toBeNull();
    });

    it('sends nothing when issuing is skipped (email changed)', async () => {
      store.users.set(USER, { email: 'other@example.com' });
      const handler = new EmailVerificationMailerHandler(issuer, mailer, links);
      await handler.handle(verificationEvent(), FAKE_TRX);
      expect(mailer.sent).toHaveLength(0);
    });

    it('dead-letters an unsupported version and a payload that breaks the contract', async () => {
      const handler = new EmailVerificationMailerHandler(issuer, mailer, links);
      await expect(
        handler.handle(envelope('EmailVerificationRequested', {}, 2), FAKE_TRX),
      ).rejects.toBeInstanceOf(NonRetryableError);
      await expect(
        handler.handle(verificationEvent({ email: 'nope' }), FAKE_TRX),
      ).rejects.toBeInstanceOf(ZodError);
    });
  });

  it('PasswordResetMailerHandler mails a /reset-password fragment link', async () => {
    const handler = new PasswordResetMailerHandler(issuer, mailer, links);
    await handler.handle(
      envelope('PasswordResetRequested', {
        userId: USER,
        email: 'jane@example.com',
        displayName: 'Jane',
        requestedAt: NOW.toISOString(),
      }),
      FAKE_TRX,
    );
    const raw = deriveOneTimeToken(TEST_SECRET, EVENT, 'PASSWORD_RESET');
    expect(mailer.sent[0]?.text).toContain(`http://localhost:3000/reset-password#token=${raw}`);
    expect(mailer.sent[0]?.subject).toBe('Reset your password');
    expect(store.rowFor(EVENT)?.purpose).toBe('PASSWORD_RESET');
  });

  it('AccountExistsMailerHandler mails "you already have an account"', async () => {
    const handler = new AccountExistsMailerHandler(mailer, links);
    await handler.handle(
      envelope('SignupAttemptedForExistingEmail', {
        userId: USER,
        email: 'jane@example.com',
        displayName: 'Jane',
        attemptedAt: NOW.toISOString(),
      }),
      FAKE_TRX,
    );
    expect(mailer.sent[0]).toMatchObject({
      to: 'jane@example.com',
      subject: 'You already have an account',
      messageId: `<${EVENT}@udemy.local>`,
    });
    expect(mailer.sent[0]?.text).toContain('http://localhost:3000/forgot-password');
  });

  it('PasswordChangedMailerHandler mails the current address; unknown users get nothing', async () => {
    const event = envelope('PasswordChanged', {
      userId: USER,
      via: 'CHANGE',
      changedAt: NOW.toISOString(),
    });
    await new PasswordChangedMailerHandler(
      new FakeContacts({ email: 'jane@example.com', displayName: 'Jane' }),
      mailer,
      links,
    ).handle(event, FAKE_TRX);
    await new PasswordChangedMailerHandler(new FakeContacts(null), mailer, links).handle(
      event,
      FAKE_TRX,
    );

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      to: 'jane@example.com',
      subject: 'Your password was changed',
    });
  });

  it('SessionCompromiseMailerHandler mails a security alert', async () => {
    await new SessionCompromiseMailerHandler(
      new FakeContacts({ email: 'jane@example.com', displayName: 'Jane' }),
      mailer,
      links,
    ).handle(
      envelope('SessionCompromiseDetected', {
        userId: USER,
        sessionId: EVENT,
        clientApp: 'student',
        detectedAt: NOW.toISOString(),
      }),
      FAKE_TRX,
    );
    expect(mailer.sent[0]?.subject).toBe('Security alert: a session was signed out');
  });
});
