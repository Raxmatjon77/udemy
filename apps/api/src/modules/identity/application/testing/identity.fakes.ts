/**
 * In-memory fakes of the identity ports for unit tests of the use cases (no Nest, no DB, no
 * Redis). They model the SQL semantics the use cases rely on (unique email, one current token
 * per session, `now()` from one clock) closely enough to test the decisions; the real adapters
 * are covered by the integration tests.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ClientApp, Role } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import type { ClientContext, Principal } from '../../../../shared/auth';
import type { RateLimiter, RateLimitResult, RateLimitRule } from '../../../../shared/redis';
import { AccessFacade } from '../../../access';
import { AlreadyBanned } from '../../domain/identity.errors';
import { normalizePassword, type PlainPassword } from '../../domain/password/plain-password';
import type { SessionRevokeReason } from '../../domain/session';
import type { BanRecord, UserSummary } from '../dto';
import {
  AccessTokenIssuer,
  type AccessTokenSubject,
  type IssuedAccessToken,
} from '../ports/access-token-issuer';
import { IdentityEventPublisher } from '../ports/identity-event.publisher';
import { LoginEmailHasher } from '../ports/login-email.hasher';
import { PasswordHasher } from '../ports/password-hasher';
import { type GeneratedRefreshToken, RefreshTokenCodec } from '../ports/refresh-token.codec';
import { ResponseTimeFloor } from '../ports/response-time-floor';
import { type SecurityEvent, SecurityEventLog } from '../ports/security-event.log';
import {
  type ActiveSessionRow,
  type ChildToken,
  type CreatedSession,
  type LockedRefreshToken,
  type LockedSession,
  type NewRefreshToken,
  type NewSession,
  SessionRepository,
  type TokenOwner,
} from '../ports/session.repository';
import { SessionRevocationStore } from '../ports/session-revocation.store';
import { TransactionRunner } from '../ports/transaction-runner';
import {
  type AccountRecord,
  type InsertedAccount,
  type NewAccount,
  UserAccountRepository,
} from '../ports/user-account.repository';
import { UserBanRepository } from '../ports/user-ban.repository';
import { UserDirectory, type UserSearchFilter, type UserSearchRow } from '../ports/user-directory';

/** The single clock of the fake database (`now()`). */
export class FakeClock {
  constructor(public now: Date = new Date('2026-10-10T10:00:00.000Z')) {}

  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }
}

/** Stands in for a Kysely transaction: the fakes never look at it. */
export const FAKE_TRX = { isTransaction: true } as unknown as Transaction<DB>;

export class FakeTransactionRunner extends TransactionRunner {
  runs = 0;

  async run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    this.runs += 1;
    return work(FAKE_TRX);
  }
}

/* ---------------------------------------------------------------- accounts and bans */

interface StoredAccount {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

export class InMemoryIdentityStore {
  readonly accounts = new Map<string, StoredAccount>();
  readonly bans: BanRecord[] = [];

  constructor(readonly clock: FakeClock) {}

  isBanned(userId: string): boolean {
    return this.bans.some((b) => b.userId === userId && b.liftedAt === null);
  }

  record(account: StoredAccount): AccountRecord {
    return { ...account, banned: this.isBanned(account.id) };
  }

  /** Test setup helper. */
  addAccount(input: {
    email: string;
    passwordHash: string;
    displayName?: string;
    verified?: boolean;
  }): string {
    const id = randomUUID();
    this.accounts.set(id, {
      id,
      email: input.email,
      displayName: input.displayName ?? 'Test User',
      passwordHash: input.passwordHash,
      emailVerifiedAt: input.verified === true ? this.clock.now : null,
      createdAt: this.clock.now,
    });
    return id;
  }

  /** Test setup helper. */
  ban(userId: string, bannedBy: string = randomUUID(), reason = 'Spamming the forums'): BanRecord {
    const ban: BanRecord = {
      id: randomUUID(),
      userId,
      reason,
      bannedBy,
      bannedAt: this.clock.now,
      liftedAt: null,
      liftedBy: null,
      liftReason: null,
    };
    this.bans.push(ban);
    return ban;
  }
}

export class InMemoryUserAccounts extends UserAccountRepository {
  locks: { userId: string; mode: 'update' | 'share' }[] = [];

  constructor(private readonly store: InMemoryIdentityStore) {
    super();
  }

  async findByEmail(email: string): Promise<AccountRecord | null> {
    const lower = email.toLowerCase();
    const found = [...this.store.accounts.values()].find((a) => a.email.toLowerCase() === lower);
    return found === undefined ? null : this.store.record(found);
  }

  async findById(userId: string): Promise<AccountRecord | null> {
    const found = this.store.accounts.get(userId);
    return found === undefined ? null : this.store.record(found);
  }

  async insertIfAbsent(
    _trx: Transaction<DB>,
    account: NewAccount,
  ): Promise<InsertedAccount | null> {
    if ((await this.findByEmail(account.email)) !== null) return null;
    const id = this.store.addAccount({
      email: account.email,
      displayName: account.displayName,
      passwordHash: account.passwordHash,
      verified: account.emailVerified,
    });
    return { id, createdAt: this.store.clock.now };
  }

  async replacePasswordHash(_trx: Transaction<DB>, userId: string, hash: string): Promise<void> {
    const account = this.store.accounts.get(userId);
    if (account !== undefined) account.passwordHash = hash;
  }

  async updateDisplayName(
    _trx: Transaction<DB>,
    userId: string,
    displayName: string,
  ): Promise<{ changed: boolean; changedAt: Date } | null> {
    const account = this.store.accounts.get(userId);
    if (account === undefined) return null;
    const changed = account.displayName !== displayName;
    account.displayName = displayName;
    return { changed, changedAt: this.store.clock.now };
  }

  async lockUser(_trx: Transaction<DB>, userId: string): Promise<boolean> {
    this.locks.push({ userId, mode: 'update' });
    return this.store.accounts.has(userId);
  }

  async lockUserShared(_trx: Transaction<DB>, userId: string): Promise<boolean> {
    this.locks.push({ userId, mode: 'share' });
    return this.store.accounts.has(userId);
  }
}

export class InMemoryUserBans extends UserBanRepository {
  constructor(private readonly store: InMemoryIdentityStore) {
    super();
  }

  async findActive(userId: string): Promise<BanRecord | null> {
    return this.store.bans.find((b) => b.userId === userId && b.liftedAt === null) ?? null;
  }

  async list(userId: string): Promise<BanRecord[]> {
    return this.store.bans.filter((b) => b.userId === userId).reverse();
  }

  async insert(
    _trx: Transaction<DB>,
    ban: { userId: string; bannedBy: string; reason: string },
  ): Promise<BanRecord> {
    if (this.store.isBanned(ban.userId)) throw new AlreadyBanned();
    return this.store.ban(ban.userId, ban.bannedBy, ban.reason);
  }

  async lift(
    _trx: Transaction<DB>,
    lift: { userId: string; liftedBy: string; liftReason: string | null },
  ): Promise<BanRecord | null> {
    const index = this.store.bans.findIndex((b) => b.userId === lift.userId && b.liftedAt === null);
    const active = this.store.bans[index];
    if (active === undefined) return null;
    const lifted: BanRecord = {
      ...active,
      liftedAt: this.store.clock.now,
      liftedBy: lift.liftedBy,
      liftReason: lift.liftReason,
    };
    this.store.bans[index] = lifted;
    return lifted;
  }
}

export class InMemoryUserDirectory extends UserDirectory {
  lastFilter: UserSearchFilter | undefined;

  constructor(private readonly store: InMemoryIdentityStore) {
    super();
  }

  private summary(id: string): UserSummary | undefined {
    const a = this.store.accounts.get(id);
    if (a === undefined) return undefined;
    return {
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      emailVerified: a.emailVerifiedAt !== null,
      status: this.store.isBanned(a.id) ? 'BANNED' : 'ACTIVE',
      createdAt: a.createdAt,
    };
  }

  async findSummaries(userIds: readonly string[]): Promise<UserSummary[]> {
    return userIds.map((id) => this.summary(id)).filter((s) => s !== undefined);
  }

  /** Newest first by (createdAt, id); `pattern` is matched literally without the `%`s. */
  async search(filter: UserSearchFilter): Promise<UserSearchRow[]> {
    this.lastFilter = filter;
    const needle = filter.pattern?.slice(1, -1).replace(/\\(.)/g, '$1').toLowerCase();
    return [...this.store.accounts.values()]
      .map((a) => this.summary(a.id))
      .filter((s): s is UserSummary => s !== undefined)
      .filter(
        (s) =>
          needle === undefined ||
          s.displayName.toLowerCase().includes(needle) ||
          s.email.toLowerCase().includes(needle),
      )
      .filter((s) => filter.status === undefined || s.status === filter.status)
      .filter((s) => filter.idIn === undefined || filter.idIn.includes(s.id))
      .map((summary) => ({
        summary,
        keyset: {
          createdAt: `${summary.createdAt.toISOString().slice(0, -1)}000Z`,
          id: summary.id,
        },
      }))
      .sort(
        (a, b) =>
          b.keyset.createdAt.localeCompare(a.keyset.createdAt) ||
          b.keyset.id.localeCompare(a.keyset.id),
      )
      .filter(
        (row) =>
          filter.after === undefined ||
          row.keyset.createdAt < filter.after.createdAt ||
          (row.keyset.createdAt === filter.after.createdAt && row.keyset.id < filter.after.id),
      )
      .slice(0, filter.take);
  }
}

/* ---------------------------------------------------------------- sessions */

export interface StoredSession {
  id: string;
  userId: string;
  clientApp: ClientApp;
  userAgent: string | null;
  createdIp: string;
  lastIp: string;
  createdAt: Date;
  lastUsedAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  revokeReason: SessionRevokeReason | null;
}

export interface StoredToken {
  id: string;
  sessionId: string;
  tokenHash: Buffer;
  parentId: string | null;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export class InMemorySessions extends SessionRepository {
  readonly sessions = new Map<string, StoredSession>();
  readonly tokens = new Map<string, StoredToken>();
  /** When set, the next insertRefreshToken throws it once (concurrency simulation). */
  failNextTokenInsert: Error | undefined;

  constructor(private readonly clock: FakeClock) {
    super();
  }

  private get now(): Date {
    return this.clock.now;
  }

  async createSession(_trx: Transaction<DB>, s: NewSession): Promise<CreatedSession> {
    const id = randomUUID();
    const absoluteExpiresAt = new Date(this.now.getTime() + s.absoluteTtlSeconds * 1000);
    this.sessions.set(id, {
      id,
      userId: s.userId,
      clientApp: s.app,
      userAgent: s.userAgent,
      createdIp: s.ip,
      lastIp: s.ip,
      createdAt: this.now,
      lastUsedAt: this.now,
      absoluteExpiresAt,
      revokedAt: null,
      revokeReason: null,
    });
    return { id, absoluteExpiresAt };
  }

  async insertRefreshToken(
    _trx: Transaction<DB>,
    t: NewRefreshToken,
  ): Promise<{ id: string; expiresAt: Date }> {
    if (this.failNextTokenInsert !== undefined) {
      const error = this.failNextTokenInsert;
      this.failNextTokenInsert = undefined;
      throw error;
    }
    const session = this.sessions.get(t.sessionId);
    if (session === undefined) throw new Error('no session');
    const current = [...this.tokens.values()].find(
      (x) => x.sessionId === t.sessionId && x.consumedAt === null,
    );
    if (current !== undefined) throw new Error('refresh_tokens_session_id_current_uq');
    const id = randomUUID();
    const expiresAt = new Date(
      Math.min(this.now.getTime() + t.idleTtlSeconds * 1000, session.absoluteExpiresAt.getTime()),
    );
    this.tokens.set(id, {
      id,
      sessionId: t.sessionId,
      tokenHash: t.tokenHash,
      parentId: t.parentId,
      issuedAt: this.now,
      expiresAt,
      consumedAt: null,
    });
    return { id, expiresAt };
  }

  tokenByHash(hash: Buffer): StoredToken | undefined {
    return [...this.tokens.values()].find((t) => t.tokenHash.equals(hash));
  }

  async lockTokenByHash(_trx: Transaction<DB>, hash: Buffer): Promise<LockedRefreshToken | null> {
    const t = this.tokenByHash(hash);
    return t === undefined
      ? null
      : {
          id: t.id,
          sessionId: t.sessionId,
          expiresAt: t.expiresAt,
          consumedAt: t.consumedAt,
          now: this.now,
        };
  }

  async lockSession(_trx: Transaction<DB>, sessionId: string): Promise<LockedSession | null> {
    const s = this.sessions.get(sessionId);
    return s === undefined
      ? null
      : {
          id: s.id,
          userId: s.userId,
          clientApp: s.clientApp,
          absoluteExpiresAt: s.absoluteExpiresAt,
          revokedAt: s.revokedAt,
        };
  }

  async findChild(_trx: Transaction<DB>, tokenId: string): Promise<ChildToken | null> {
    const child = [...this.tokens.values()].find((t) => t.parentId === tokenId);
    return child === undefined
      ? null
      : { id: child.id, consumedAt: child.consumedAt, expiresAt: child.expiresAt };
  }

  async consumeToken(_trx: Transaction<DB>, tokenId: string): Promise<void> {
    const t = this.tokens.get(tokenId);
    if (t !== undefined && t.consumedAt === null) t.consumedAt = this.now;
  }

  async touchSession(_trx: Transaction<DB>, sessionId: string, ip: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s !== undefined) {
      s.lastUsedAt = this.now;
      s.lastIp = ip;
    }
  }

  private revoke(s: StoredSession | undefined, reason: SessionRevokeReason): boolean {
    if (s === undefined || s.revokedAt !== null) return false;
    s.revokedAt = this.now;
    s.revokeReason = reason;
    return true;
  }

  async revokeSession(
    _trx: Transaction<DB>,
    sessionId: string,
    reason: SessionRevokeReason,
  ): Promise<boolean> {
    return this.revoke(this.sessions.get(sessionId), reason);
  }

  async revokeOwnSession(
    _trx: Transaction<DB>,
    userId: string,
    sessionId: string,
    reason: SessionRevokeReason,
  ): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    return s !== undefined && s.userId === userId && this.revoke(s, reason);
  }

  async revokeAllForUser(
    _trx: Transaction<DB>,
    userId: string,
    reason: SessionRevokeReason,
  ): Promise<string[]> {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId && this.revoke(s, reason))
      .map((s) => s.id);
  }

  async findTokenOwner(_ex: Executor, hash: Buffer): Promise<TokenOwner | null> {
    const t = this.tokenByHash(hash);
    const s = t === undefined ? undefined : this.sessions.get(t.sessionId);
    return s === undefined ? null : { sessionId: s.id, userId: s.userId, clientApp: s.clientApp };
  }

  private active(userId: string): StoredSession[] {
    const now = this.now.getTime();
    return [...this.sessions.values()].filter((s) => {
      const current = [...this.tokens.values()].find(
        (t) => t.sessionId === s.id && t.consumedAt === null,
      );
      return (
        s.userId === userId &&
        s.revokedAt === null &&
        s.absoluteExpiresAt.getTime() > now &&
        current !== undefined &&
        current.expiresAt.getTime() > now
      );
    });
  }

  async listActive(userId: string): Promise<ActiveSessionRow[]> {
    return this.active(userId).map((s) => ({
      id: s.id,
      app: s.clientApp,
      userAgent: s.userAgent,
      lastIp: s.lastIp,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
    }));
  }

  async countActive(userId: string): Promise<number> {
    return this.active(userId).length;
  }
}

/* ---------------------------------------------------------------- logs, events, redis */

export class RecordingSecurityLog extends SecurityEventLog {
  readonly events: SecurityEvent[] = [];

  async record(event: SecurityEvent): Promise<void> {
    this.events.push(event);
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

export interface PublishedEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export class RecordingEventPublisher extends IdentityEventPublisher {
  readonly published: PublishedEvent[] = [];

  private push(type: string, payload: object): Promise<void> {
    this.published.push({ type, payload: { ...payload } });
    return Promise.resolve();
  }

  types(): string[] {
    return this.published.map((e) => e.type);
  }

  userRegistered(_t: Transaction<DB>, p: object): Promise<void> {
    return this.push('UserRegistered', p);
  }
  emailVerificationRequested(_t: Transaction<DB>, p: object): Promise<void> {
    return this.push('EmailVerificationRequested', p);
  }
  signupAttemptedForExistingEmail(_t: Transaction<DB>, p: object): Promise<void> {
    return this.push('SignupAttemptedForExistingEmail', p);
  }
  sessionCompromiseDetected(_t: Transaction<DB>, p: object): Promise<void> {
    return this.push('SessionCompromiseDetected', p);
  }
  displayNameChanged(_t: Transaction<DB>, p: object): Promise<void> {
    return this.push('DisplayNameChanged', p);
  }
  userBanned(_t: Transaction<DB>, p: object): Promise<void> {
    return this.push('UserBanned', p);
  }
  userUnbanned(_t: Transaction<DB>, p: object): Promise<void> {
    return this.push('UserUnbanned', p);
  }
}

export class FakeRevocations extends SessionRevocationStore {
  readonly revoked = new Set<string>();
  /** When true, every call throws (Redis down). */
  down = false;

  private check(): void {
    if (this.down) throw new Error('Redis down');
  }

  async revoke(sessionId: string): Promise<void> {
    this.check();
    this.revoked.add(sessionId);
  }

  async revokeMany(sessionIds: readonly string[]): Promise<void> {
    this.check();
    for (const id of sessionIds) this.revoked.add(id);
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    this.check();
    return this.revoked.has(sessionId);
  }
}

/** Fixed-window counters with the RateLimiter's public contract (no expiry). */
export class InMemoryRateLimiter {
  readonly counts = new Map<string, number>();

  async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { count, ttlMs: rule.windowMs, limited: count > rule.limit };
  }

  async peek(key: string, rule: Pick<RateLimitRule, 'limit'>): Promise<RateLimitResult> {
    const count = this.counts.get(key) ?? 0;
    return { count, ttlMs: count === 0 ? 0 : 60_000, limited: count >= rule.limit };
  }

  async reset(key: string): Promise<void> {
    this.counts.delete(key);
  }

  asRateLimiter(): RateLimiter {
    return this as unknown as RateLimiter;
  }

  countOf(prefix: string): number {
    let total = 0;
    for (const [key, n] of this.counts) if (key.startsWith(prefix)) total += n;
    return total;
  }
}

/* ---------------------------------------------------------------- crypto and tokens */

/** Plain-text "hashes"; normalises like the real hasher. */
export class FakePasswordHasher extends PasswordHasher {
  dummyVerifies = 0;
  hashes = 0;
  /** Stored hashes with this marker report needsRehash. */
  static readonly OUTDATED = '$argon2id$old$';

  static hashOf(password: string): string {
    return `$argon2id$fake$${normalizePassword(password)}`;
  }

  async hash(password: PlainPassword): Promise<string> {
    this.hashes += 1;
    return `$argon2id$fake$${password.value}`;
  }

  async verify(encodedHash: string, password: string): Promise<boolean> {
    const plain = normalizePassword(password);
    return (
      encodedHash === `$argon2id$fake$${plain}` ||
      encodedHash === `${FakePasswordHasher.OUTDATED}${plain}`
    );
  }

  async rehashVerified(password: string): Promise<string> {
    this.hashes += 1;
    return FakePasswordHasher.hashOf(password);
  }

  needsRehash(encodedHash: string): boolean {
    return encodedHash.startsWith(FakePasswordHasher.OUTDATED);
  }

  async dummyVerify(): Promise<false> {
    this.dummyVerifies += 1;
    return false;
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export class FakeRefreshTokenCodec extends RefreshTokenCodec {
  private counter = 0;

  generate(): GeneratedRefreshToken {
    this.counter += 1;
    const token = `rt-${this.counter}-${randomUUID()}`;
    return { token, hash: this.hash(token) };
  }

  hash(token: string): Buffer {
    return sha256(`pepper:${token}`);
  }
}

export class FakeLoginEmailHasher extends LoginEmailHasher {
  hash(normalizedEmail: string): Buffer {
    return sha256(`email:${normalizedEmail}`);
  }
}

export class FakeAccessTokenIssuer extends AccessTokenIssuer {
  readonly issued: AccessTokenSubject[] = [];

  constructor(private readonly clock: FakeClock) {
    super();
  }

  async issue(subject: AccessTokenSubject): Promise<IssuedAccessToken> {
    this.issued.push(subject);
    return {
      token: `at.${subject.userId}.${subject.sessionId}.${subject.app}.${subject.roles.join('+')}`,
      tokenId: randomUUID(),
      issuedAt: this.clock.now,
      expiresAt: new Date(this.clock.now.getTime() + 15 * 60_000),
      kid: 'ed25519-2026-10',
    };
  }
}

export class RecordingResponseFloor extends ResponseTimeFloor {
  readonly floors: number[] = [];

  async run<T>(minimumMs: number, work: () => Promise<T>): Promise<T> {
    this.floors.push(minimumMs);
    return work();
  }
}

/* ---------------------------------------------------------------- access */

/** A real AccessFacade (real permission policy) over an in-memory role table. */
export function fakeAccessFacade(roles: Map<string, Role[]>): AccessFacade {
  type Repo = ConstructorParameters<typeof AccessFacade>[0];
  type Events = ConstructorParameters<typeof AccessFacade>[1];
  const repo = {
    findRoles: async (userId: string) => (roles.get(userId) ?? []).filter((r) => r !== 'STUDENT'),
  } as unknown as Repo;
  return new AccessFacade(repo, {} as Events);
}

/* ---------------------------------------------------------------- request context */

export function clientOf(app: ClientApp, ip = '203.0.113.7'): ClientContext {
  return {
    clientId: `${app}-bff`,
    app,
    ip,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  };
}

export function principalOf(
  userId: string,
  sessionId: string,
  app: ClientApp = 'student',
): Principal {
  return {
    userId,
    sessionId,
    app,
    roles: ['STUDENT'],
    permissions: new Set(),
    tokenId: randomUUID(),
  };
}
