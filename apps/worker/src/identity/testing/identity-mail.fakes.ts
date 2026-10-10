import type { DB, Transaction } from '@udemy/db';
import { Mailer, type MailMessage, type MailSendResult } from '@udemy/nest-common/mail';
import type { WorkerConfigService } from '../../shared/config';
import type { WorkerEnv } from '../../shared/config/worker-env.schema';
import type { OneTimeTokenPurpose } from '../one-time-tokens/one-time-token';
import {
  type LockedTokenOwner,
  type NewOneTimeToken,
  OneTimeTokenStore,
  type StoredOneTimeToken,
} from '../one-time-tokens/one-time-token.store';

/** Stands in for the handler's transaction: the fakes never look at it. */
export const FAKE_TRX = { isTransaction: true } as unknown as Transaction<DB>;

export const TEST_SECRET = 'unit-test-email-token-secret-0123456789abcdef';

/** The subset of the worker env the mail code (identity and users mailers) reads. */
export function fakeConfig(overrides: Partial<WorkerEnv> = {}): WorkerConfigService {
  const env: Partial<WorkerEnv> = {
    EMAIL_TOKEN_SECRET: TEST_SECRET,
    STUDENT_APP_ORIGIN: 'http://localhost:3000',
    INSTRUCTOR_APP_ORIGIN: 'http://localhost:3001',
    MAIL_FROM: 'Udemy Clone <no-reply@udemy.local>',
    ...overrides,
  };
  return {
    get: <K extends keyof WorkerEnv>(key: K): WorkerEnv[K] => {
      const value = env[key];
      if (value === undefined) throw new Error(`fakeConfig: ${String(key)} not set`);
      return value as WorkerEnv[K];
    },
  } as WorkerConfigService;
}

export interface FakeTokenRow extends NewOneTimeToken {
  consumedAt: Date | null;
  invalidatedAt: Date | null;
}

/**
 * `identity.users` + `identity.one_time_tokens` in memory, with the constraints IssueOneTimeToken
 * relies on: UNIQUE(source_event_id) as the ON CONFLICT target, UNIQUE(token_hash), and the
 * partial UNIQUE (user_id, purpose) over live rows (a violation throws like Postgres would).
 */
export class InMemoryOneTimeTokenStore extends OneTimeTokenStore {
  readonly users = new Map<string, { email: string }>();
  readonly rows: FakeTokenRow[] = [];
  locks: string[] = [];

  constructor(public now: Date = new Date('2026-10-10T10:00:00.000Z')) {
    super();
  }

  async lockOwner(_trx: Transaction<DB>, userId: string): Promise<LockedTokenOwner | null> {
    this.locks.push(userId);
    const user = this.users.get(userId);
    return user === undefined ? null : { email: user.email, now: this.now };
  }

  async hasNewerRequest(
    _trx: Transaction<DB>,
    userId: string,
    purpose: OneTimeTokenPurpose,
    requestedAt: Date,
  ): Promise<boolean> {
    return this.rows.some(
      (r) =>
        r.userId === userId &&
        r.purpose === purpose &&
        r.requestedAt.getTime() > requestedAt.getTime(),
    );
  }

  async invalidateOthers(
    _trx: Transaction<DB>,
    userId: string,
    purpose: OneTimeTokenPurpose,
    sourceEventId: string,
  ): Promise<number> {
    let count = 0;
    for (const r of this.rows) {
      if (
        r.userId === userId &&
        r.purpose === purpose &&
        r.consumedAt === null &&
        r.invalidatedAt === null &&
        r.sourceEventId !== sourceEventId
      ) {
        r.invalidatedAt = this.now;
        count += 1;
      }
    }
    return count;
  }

  async insertIfAbsent(_trx: Transaction<DB>, token: NewOneTimeToken): Promise<void> {
    if (this.rows.some((r) => r.sourceEventId === token.sourceEventId)) return; // DO NOTHING
    if (this.rows.some((r) => r.tokenHash.equals(token.tokenHash))) {
      throw new Error('one_time_tokens_token_hash_uq');
    }
    const live = this.rows.some(
      (r) =>
        r.userId === token.userId &&
        r.purpose === token.purpose &&
        r.consumedAt === null &&
        r.invalidatedAt === null,
    );
    if (live) throw new Error('one_time_tokens_user_id_purpose_live_uq');
    this.rows.push({ ...token, consumedAt: null, invalidatedAt: null });
  }

  async findBySourceEvent(
    _trx: Transaction<DB>,
    sourceEventId: string,
  ): Promise<StoredOneTimeToken | null> {
    const row = this.rows.find((r) => r.sourceEventId === sourceEventId);
    return row === undefined
      ? null
      : { tokenHash: row.tokenHash, live: row.consumedAt === null && row.invalidatedAt === null };
  }

  rowFor(sourceEventId: string): FakeTokenRow | undefined {
    return this.rows.find((r) => r.sourceEventId === sourceEventId);
  }
}

export class RecordingMailer extends Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<MailSendResult> {
    this.sent.push(message);
    const to = typeof message.to === 'string' ? [message.to] : [...message.to];
    return { messageId: message.messageId ?? '<generated@test>', accepted: to, rejected: [] };
  }
}
