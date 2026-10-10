/**
 * In-memory fakes for the users use-case unit tests (no Nest, no DB, no Redis). The
 * repository fakes model the SQL semantics the use cases rely on (conditional update on
 * status/version, one PENDING per applicant, `now()` from one clock); the facades of identity
 * and access are reduced to the methods users calls. The real adapters are covered by the
 * integration tests.
 */
import { randomUUID } from 'node:crypto';
import type {
  AccountStatus,
  AssignableRole,
  InstructorApplicationApprovedPayload,
  InstructorApplicationRejectedPayload,
  InstructorApplicationSubmittedPayload,
  InstructorApplicationWithdrawnPayload,
  Role,
} from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import type { AccessFacade, GrantRoleCommand, RoleChangeResult } from '../../../access';
import {
  AccountNotFound,
  AlreadyBanned,
  type BanRecord,
  type BanUserCommand,
  type ChangeDisplayNameCommand,
  type IdentityFacade,
  NotBanned,
  type ProvisionAccountCommand,
  type UnbanUserCommand,
  type UserSearchPage,
  type UserSearchParams,
  type UserSummary,
} from '../../../identity';
import type {
  ApplicationDecision,
  ApplicationSubmission,
  InstructorApplicationState,
} from '../../domain/instructor-application';
import type { ProfileChanges, ProfileState } from '../../domain/profile';
import { ApplicationAlreadyPending } from '../../domain/users.errors';
import { InstructorApplicationEventPublisher } from '../ports/instructor-application-event.publisher';
import {
  type ApplicationQueueFilter,
  type ApplicationQueueRow,
  type ApplyDecisionResult,
  InstructorApplicationRepository,
} from '../ports/instructor-application.repository';
import { ProfileRepository } from '../ports/profile.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { UserLock } from '../ports/user-lock';

/** The single clock of the fake database (`now()`). */
export class FakeClock {
  constructor(public now: Date = new Date('2026-10-10T10:00:00.000Z')) {}

  tick(ms = 1_000): Date {
    this.now = new Date(this.now.getTime() + ms);
    return this.now;
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

export class FakeUserLock extends UserLock {
  readonly locked: string[] = [];

  constructor(private readonly exists: (userId: string) => boolean) {
    super();
  }

  async lock(_trx: Transaction<DB>, userId: string): Promise<boolean> {
    this.locked.push(userId);
    return this.exists(userId);
  }
}

/* ---------------------------------------------------------------- users repositories */

export class FakeProfileRepository extends ProfileRepository {
  readonly rows = new Map<string, ProfileState>();
  findManyCalls = 0;

  async find(userId: string, _ex?: Executor): Promise<ProfileState | null> {
    return this.rows.get(userId) ?? null;
  }

  async findMany(userIds: readonly string[], _ex?: Executor): Promise<ProfileState[]> {
    this.findManyCalls += 1;
    return userIds.flatMap((id) => {
      const row = this.rows.get(id);
      return row === undefined ? [] : [row];
    });
  }

  async upsert(
    _trx: Transaction<DB>,
    userId: string,
    changes: ProfileChanges,
  ): Promise<ProfileState> {
    const current = this.rows.get(userId) ?? {
      userId,
      headline: null,
      bio: null,
      avatarMediaId: null,
    };
    const next: ProfileState = {
      ...current,
      ...(changes.headline === undefined ? {} : { headline: changes.headline }),
      ...(changes.bio === undefined ? {} : { bio: changes.bio }),
    };
    this.rows.set(userId, next);
    return next;
  }
}

type MutableApplication = {
  -readonly [K in keyof InstructorApplicationState]: InstructorApplicationState[K];
};

export class FakeInstructorApplicationRepository extends InstructorApplicationRepository {
  readonly rows = new Map<string, MutableApplication>();
  /** Set to simulate a concurrent writer between the read and the conditional update. */
  beforeApply: ((id: string) => void) | undefined;
  listByStatusCalls = 0;

  constructor(private readonly clock: FakeClock) {
    super();
  }

  /** Seeds an application directly (any status). */
  seed(
    applicantId: string,
    overrides: Partial<InstructorApplicationState> = {},
  ): InstructorApplicationState {
    const submittedAt = overrides.submittedAt ?? this.clock.tick();
    const row: MutableApplication = {
      id: randomUUID(),
      applicantId,
      status: 'PENDING',
      motivation: 'm'.repeat(120),
      expertise: 'TypeScript',
      experienceLevel: 'PROFESSIONAL',
      portfolioUrl: null,
      submittedAt,
      version: 1,
      transitions: [
        {
          fromStatus: null,
          toStatus: 'PENDING',
          actorId: applicantId,
          reason: null,
          occurredAt: submittedAt,
        },
      ],
      ...overrides,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async findById(id: string, _ex?: Executor): Promise<InstructorApplicationState | null> {
    const row = this.rows.get(id);
    return row === undefined ? null : { ...row, transitions: [...row.transitions] };
  }

  async findApplicantId(id: string, _ex?: Executor): Promise<string | null> {
    return this.rows.get(id)?.applicantId ?? null;
  }

  async hasPending(applicantId: string, _ex?: Executor): Promise<boolean> {
    return [...this.rows.values()].some(
      (r) => r.applicantId === applicantId && r.status === 'PENDING',
    );
  }

  async listByApplicant(
    applicantId: string,
    _ex?: Executor,
  ): Promise<InstructorApplicationState[]> {
    return [...this.rows.values()]
      .filter((r) => r.applicantId === applicantId)
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
  }

  async listByStatus(
    filter: ApplicationQueueFilter,
    _ex?: Executor,
  ): Promise<ApplicationQueueRow[]> {
    this.listByStatusCalls += 1;
    const keyOf = (r: InstructorApplicationState): string =>
      `${r.submittedAt.toISOString().replace('Z', '000Z')}|${r.id}`;
    const after =
      filter.after === undefined ? undefined : `${filter.after.submittedAt}|${filter.after.id}`;
    return [...this.rows.values()]
      .filter((r) => r.status === filter.status)
      .sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
      .filter((r) => after === undefined || keyOf(r) > after)
      .slice(0, filter.take)
      .map((application) => ({
        application,
        keyset: {
          submittedAt: application.submittedAt.toISOString().replace('Z', '000Z'),
          id: application.id,
        },
      }));
  }

  async insert(_trx: Transaction<DB>, submission: ApplicationSubmission): Promise<{ id: string }> {
    if (await this.hasPending(submission.applicantId)) throw new ApplicationAlreadyPending();
    const row = this.seed(submission.applicantId, {
      motivation: submission.motivation,
      expertise: submission.expertise,
      experienceLevel: submission.experienceLevel,
      portfolioUrl: submission.portfolioUrl,
    });
    return { id: row.id };
  }

  async applyDecision(
    _trx: Transaction<DB>,
    decision: ApplicationDecision,
    expectedVersion: number | undefined,
  ): Promise<ApplyDecisionResult> {
    this.beforeApply?.(decision.applicationId);
    const row = this.rows.get(decision.applicationId);
    if (row === undefined || row.status !== decision.fromStatus) return { applied: false };
    if (expectedVersion !== undefined && row.version !== expectedVersion) return { applied: false };
    row.status = decision.toStatus;
    row.version += 1;
    return { applied: true, version: row.version };
  }

  async insertTransition(
    _trx: Transaction<DB>,
    decision: ApplicationDecision,
  ): Promise<{ occurredAt: Date }> {
    const row = this.rows.get(decision.applicationId);
    if (row === undefined) throw new Error('no such application');
    const occurredAt = this.clock.tick();
    row.transitions = [
      ...row.transitions,
      {
        fromStatus: decision.fromStatus,
        toStatus: decision.toStatus,
        actorId: decision.actorId,
        reason: decision.reason,
        occurredAt,
      },
    ];
    return { occurredAt };
  }
}

export type RecordedEvent =
  | { type: 'submitted'; payload: InstructorApplicationSubmittedPayload }
  | { type: 'approved'; payload: InstructorApplicationApprovedPayload }
  | { type: 'rejected'; payload: InstructorApplicationRejectedPayload }
  | { type: 'withdrawn'; payload: InstructorApplicationWithdrawnPayload };

export class FakeEventPublisher extends InstructorApplicationEventPublisher {
  readonly events: RecordedEvent[] = [];

  async submitted(
    _trx: Transaction<DB>,
    payload: InstructorApplicationSubmittedPayload,
  ): Promise<void> {
    this.events.push({ type: 'submitted', payload });
  }

  async approved(
    _trx: Transaction<DB>,
    payload: InstructorApplicationApprovedPayload,
  ): Promise<void> {
    this.events.push({ type: 'approved', payload });
  }

  async rejected(
    _trx: Transaction<DB>,
    payload: InstructorApplicationRejectedPayload,
  ): Promise<void> {
    this.events.push({ type: 'rejected', payload });
  }

  async withdrawn(
    _trx: Transaction<DB>,
    payload: InstructorApplicationWithdrawnPayload,
  ): Promise<void> {
    this.events.push({ type: 'withdrawn', payload });
  }
}

/* ---------------------------------------------------------------- other modules' facades */

interface FakeAccount {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  createdAt: Date;
  sessions: number;
  bans: BanRecord[];
}

/** The IdentityFacade methods the users module calls, over an in-memory account table. */
export class FakeIdentity {
  readonly accounts = new Map<string, FakeAccount>();
  readonly calls: string[] = [];

  constructor(private readonly clock: FakeClock) {}

  add(overrides: Partial<FakeAccount> = {}): FakeAccount {
    const id = overrides.id ?? randomUUID();
    const account: FakeAccount = {
      id,
      email: `${id}@example.test`,
      displayName: 'Test User',
      emailVerified: true,
      createdAt: this.clock.tick(),
      sessions: 0,
      bans: [],
      ...overrides,
    };
    this.accounts.set(id, account);
    return account;
  }

  private status(account: FakeAccount): AccountStatus {
    return account.bans.some((b) => b.liftedAt === null) ? 'BANNED' : 'ACTIVE';
  }

  private summary(account: FakeAccount): UserSummary {
    return {
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      emailVerified: account.emailVerified,
      status: this.status(account),
      createdAt: account.createdAt,
    };
  }

  async getUserSummary(userId: string, _ex?: Executor): Promise<UserSummary | null> {
    this.calls.push('getUserSummary');
    const account = this.accounts.get(userId);
    return account === undefined ? null : this.summary(account);
  }

  async getUserSummaries(userIds: readonly string[], _ex?: Executor): Promise<UserSummary[]> {
    this.calls.push('getUserSummaries');
    return [...new Set(userIds)].flatMap((id) => {
      const account = this.accounts.get(id);
      return account === undefined ? [] : [this.summary(account)];
    });
  }

  async searchUsers(params: UserSearchParams): Promise<UserSearchPage> {
    this.calls.push('searchUsers');
    const items = [...this.accounts.values()]
      .filter((a) => params.idIn === undefined || params.idIn.includes(a.id))
      .filter((a) => params.status === undefined || this.status(a) === params.status)
      .filter(
        (a) =>
          params.q === undefined || a.displayName.includes(params.q) || a.email.includes(params.q),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, params.limit)
      .map((a) => this.summary(a));
    return { items, nextCursor: null };
  }

  async isEmailVerified(userId: string, _ex?: Executor): Promise<boolean> {
    return this.accounts.get(userId)?.emailVerified ?? false;
  }

  async getAccountStatus(userId: string, _ex?: Executor): Promise<{ status: AccountStatus }> {
    const account = this.accounts.get(userId);
    if (account === undefined) throw new AccountNotFound();
    return { status: this.status(account) };
  }

  async listBans(userId: string): Promise<BanRecord[]> {
    return [...(this.accounts.get(userId)?.bans ?? [])].reverse();
  }

  async countActiveSessions(userId: string): Promise<number> {
    return this.accounts.get(userId)?.sessions ?? 0;
  }

  async changeDisplayName(_trx: Transaction<DB>, cmd: ChangeDisplayNameCommand): Promise<void> {
    this.calls.push('changeDisplayName');
    const account = this.accounts.get(cmd.userId);
    if (account === undefined) throw new AccountNotFound();
    account.displayName = cmd.displayName.trim();
  }

  async banUser(_trx: Transaction<DB>, cmd: BanUserCommand): Promise<BanRecord> {
    this.calls.push('banUser');
    const account = this.accounts.get(cmd.userId);
    if (account === undefined) throw new AccountNotFound();
    if (this.status(account) === 'BANNED') throw new AlreadyBanned();
    const ban: BanRecord = {
      id: randomUUID(),
      userId: cmd.userId,
      reason: cmd.reason,
      bannedBy: cmd.actorId,
      bannedAt: this.clock.tick(),
      liftedAt: null,
      liftedBy: null,
      liftReason: null,
    };
    account.bans.push(ban);
    account.sessions = 0;
    return ban;
  }

  async unbanUser(_trx: Transaction<DB>, cmd: UnbanUserCommand): Promise<BanRecord> {
    this.calls.push('unbanUser');
    const account = this.accounts.get(cmd.userId);
    if (account === undefined) throw new AccountNotFound();
    const index = account.bans.findIndex((b) => b.liftedAt === null);
    const active = account.bans[index];
    if (active === undefined) throw new NotBanned();
    const lifted: BanRecord = {
      ...active,
      liftedAt: this.clock.tick(),
      liftedBy: cmd.actorId,
      liftReason: cmd.reason ?? null,
    };
    account.bans[index] = lifted;
    return lifted;
  }

  async provisionAccount(
    _trx: Transaction<DB>,
    cmd: ProvisionAccountCommand,
  ): Promise<{ userId: string; created: boolean }> {
    this.calls.push('provisionAccount');
    const existing = [...this.accounts.values()].find((a) => a.email === cmd.email);
    if (existing !== undefined) return { userId: existing.id, created: false };
    const account = this.add({
      email: cmd.email,
      displayName: cmd.displayName,
      emailVerified: true,
    });
    return { userId: account.id, created: true };
  }

  asFacade(): IdentityFacade {
    return this as unknown as IdentityFacade;
  }
}

/** The AccessFacade methods the users module calls, over an in-memory user_roles table. */
export class FakeAccess {
  readonly roles = new Map<string, Set<AssignableRole>>();
  readonly grants: GrantRoleCommand[] = [];
  readonly calls: string[] = [];

  private held(userId: string): Role[] {
    const explicit = this.roles.get(userId) ?? new Set<AssignableRole>();
    return ['STUDENT', ...(['INSTRUCTOR', 'ADMIN'] as const).filter((r) => explicit.has(r))];
  }

  give(userId: string, role: AssignableRole): void {
    const set = this.roles.get(userId) ?? new Set<AssignableRole>();
    set.add(role);
    this.roles.set(userId, set);
  }

  async getRoles(userId: string, _ex?: Executor): Promise<Role[]> {
    this.calls.push('getRoles');
    return this.held(userId);
  }

  async getRolesForUsers(userIds: readonly string[], _ex?: Executor): Promise<Map<string, Role[]>> {
    this.calls.push('getRolesForUsers');
    return new Map([...new Set(userIds)].map((id) => [id, this.held(id)]));
  }

  async listUserIdsWithRole(role: AssignableRole, _ex?: Executor): Promise<string[]> {
    this.calls.push('listUserIdsWithRole');
    return [...this.roles].filter(([, set]) => set.has(role)).map(([id]) => id);
  }

  async hasRole(userId: string, role: Role, _ex?: Executor): Promise<boolean> {
    this.calls.push(`hasRole:${role}`);
    return this.held(userId).includes(role);
  }

  async grantRole(_trx: Transaction<DB>, cmd: GrantRoleCommand): Promise<RoleChangeResult> {
    this.grants.push(cmd);
    if (cmd.role === 'STUDENT') throw new Error('STUDENT is implicit');
    const had = this.held(cmd.userId).includes(cmd.role);
    this.give(cmd.userId, cmd.role);
    return { changed: !had };
  }

  asFacade(): AccessFacade {
    return this as unknown as AccessFacade;
  }
}
