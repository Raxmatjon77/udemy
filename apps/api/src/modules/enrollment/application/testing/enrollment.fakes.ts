import { randomUUID } from 'node:crypto';
import type {
  EnrollmentGrantedPayload,
  EnrollmentRevokedPayload,
  PublicProfile,
} from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import { RateLimitedError } from '../../../../shared/errors';
import type { CatalogFacade, CourseSummary, PublishedCourseSummary } from '../../../catalog';
import type { IdentityFacade, UserSummary } from '../../../identity';
import type { UsersFacade } from '../../../users';
import type { Enrollment, EnrollmentTransition } from '../../domain/enrollment';
import { AdminEnrollmentAssembler } from '../admin-enrollment.assembler';
import { EnrollmentEntitlements } from '../enrollment-entitlements';
import { EnrollmentWriter } from '../enrollment-writer';
import { EnrollmentFacade } from '../enrollment.facade';
import { CoursePriceReader } from '../ports/course-price.reader';
import { EnrollmentEventPublisher } from '../ports/enrollment-event.publisher';
import {
  EnrollmentRepository,
  type GrantEnrollmentCommand,
  type GrantEnrollmentRecord,
  type MyLearningKeyset,
  type MyLearningRow,
  type RevokeEnrollmentCommand,
  type RevokeEnrollmentRecord,
} from '../ports/enrollment.repository';
import { FreeEnrollmentRateLimiter } from '../ports/free-enrollment-rate-limiter';
import { TransactionRunner } from '../ports/transaction-runner';
import { AdminGrantEnrollmentCommand } from '../use-cases/admin-grant-enrollment.command';
import { AdminListUserEnrollmentsQuery } from '../use-cases/admin-list-user-enrollments.query';
import { AdminRevokeEnrollmentCommand } from '../use-cases/admin-revoke-enrollment.command';
import { EnrollFreeCommand } from '../use-cases/enroll-free.command';
import { ListMyLearningQuery } from '../use-cases/list-my-learning.query';

/** Stands in for an open Kysely transaction (fakes never run SQL). */
export const FAKE_TRX = { isTransaction: true } as unknown as Transaction<DB>;

/** A strictly increasing clock with microsecond-distinct timestamps for keyset tests. */
class Clock {
  private t = Date.UTC(2026, 9, 1, 12, 0, 0);
  next(): Date {
    this.t += 1000;
    return new Date(this.t);
  }
}

function exactText(date: Date): string {
  return date.toISOString().replace('Z', '000Z');
}

/**
 * In-memory twin of the `@udemy/db` grant / revoke semantics (upsert, transition log, the
 * idempotent outcomes), so the application layer is tested without Postgres.
 */
export class InMemoryEnrollmentRepository extends EnrollmentRepository {
  readonly rows = new Map<string, Enrollment>();
  readonly transitions: EnrollmentTransition[] = [];
  readonly calls: string[] = [];
  private readonly clock = new Clock();

  find(userId: string, courseId: string): Enrollment | undefined {
    return [...this.rows.values()].find((e) => e.userId === userId && e.courseId === courseId);
  }

  private log(t: Omit<EnrollmentTransition, 'seq' | 'occurredAt'>, at: Date): void {
    const seq = this.transitions.filter((x) => x.enrollmentId === t.enrollmentId).length + 1;
    this.transitions.push({ ...t, seq, occurredAt: at });
  }

  grant(trx: Transaction<DB>, c: GrantEnrollmentCommand): Promise<GrantEnrollmentRecord> {
    this.calls.push('grant');
    if (!trx.isTransaction) throw new TypeError('grant needs a transaction');
    if ((c.source === 'ORDER') !== (c.orderLineId !== null)) {
      throw new RangeError('orderLineId is required for source ORDER and forbidden otherwise');
    }
    const existing = this.find(c.userId, c.courseId);
    if (existing?.status === 'ACTIVE') {
      return Promise.resolve({ outcome: 'ALREADY_ACTIVE', enrollment: existing });
    }
    const at = this.clock.next();
    const enrollment: Enrollment = {
      id: existing?.id ?? randomUUID(),
      userId: c.userId,
      courseId: c.courseId,
      status: 'ACTIVE',
      source: c.source,
      orderLineId: c.orderLineId,
      grantedAt: at,
      revokedAt: null,
      revokeReason: null,
    };
    this.rows.set(enrollment.id, enrollment);
    this.log(
      {
        enrollmentId: enrollment.id,
        action: existing === undefined ? 'GRANT' : 'REGRANT',
        source: c.source,
        orderLineId: c.orderLineId,
        revokeReason: null,
        refundId: null,
        reason: c.reason,
        actorId: c.actorId,
      },
      at,
    );
    return Promise.resolve({
      outcome: existing === undefined ? 'GRANTED' : 'REGRANTED',
      enrollment,
    });
  }

  revoke(trx: Transaction<DB>, c: RevokeEnrollmentCommand): Promise<RevokeEnrollmentRecord> {
    this.calls.push('revoke');
    if (!trx.isTransaction) throw new TypeError('revoke needs a transaction');
    if ((c.cause === 'REFUND') !== (c.refundId !== null)) {
      throw new RangeError('refundId is required for revokeReason REFUND and forbidden otherwise');
    }
    const existing = this.find(c.userId, c.courseId);
    if (existing === undefined) return Promise.resolve({ outcome: 'NOT_FOUND', enrollment: null });
    if (existing.status !== 'ACTIVE') {
      return Promise.resolve({ outcome: 'ALREADY_REVOKED', enrollment: existing });
    }
    const at = this.clock.next();
    const revoked: Enrollment = {
      ...existing,
      status: 'REVOKED',
      revokedAt: at,
      revokeReason: c.cause,
    };
    this.rows.set(revoked.id, revoked);
    this.log(
      {
        enrollmentId: revoked.id,
        action: 'REVOKE',
        source: null,
        orderLineId: null,
        revokeReason: c.cause,
        refundId: c.refundId,
        reason: c.reason,
        actorId: c.actorId,
      },
      at,
    );
    return Promise.resolve({ outcome: 'REVOKED', enrollment: revoked });
  }

  findById(enrollmentId: string): Promise<Enrollment | null> {
    return Promise.resolve(this.rows.get(enrollmentId) ?? null);
  }

  findActive(userId: string, courseId: string): Promise<Enrollment | null> {
    this.calls.push('findActive');
    const row = this.find(userId, courseId);
    return Promise.resolve(row?.status === 'ACTIVE' ? row : null);
  }

  hasActive(userId: string, courseId: string): Promise<boolean> {
    this.calls.push('hasActive');
    return Promise.resolve(this.find(userId, courseId)?.status === 'ACTIVE');
  }

  findActiveCourseIds(userId: string, courseIds: readonly string[] | undefined): Promise<string[]> {
    this.calls.push('findActiveCourseIds');
    return Promise.resolve(
      [...this.rows.values()]
        .filter((e) => e.userId === userId && e.status === 'ACTIVE')
        .filter((e) => courseIds === undefined || courseIds.includes(e.courseId))
        .map((e) => e.courseId),
    );
  }

  private newestFirst(rows: Enrollment[]): Enrollment[] {
    return rows.sort(
      (a, b) => b.grantedAt.getTime() - a.grantedAt.getTime() || (a.id < b.id ? 1 : -1),
    );
  }

  listActivePage(
    userId: string,
    after: MyLearningKeyset | null,
    limit: number,
  ): Promise<MyLearningRow[]> {
    const rows = this.newestFirst(
      [...this.rows.values()].filter((e) => e.userId === userId && e.status === 'ACTIVE'),
    )
      .map((enrollment) => ({
        enrollment,
        keyset: { grantedAt: exactText(enrollment.grantedAt), id: enrollment.id },
      }))
      .filter(
        (r) =>
          after === null ||
          r.keyset.grantedAt < after.grantedAt ||
          (r.keyset.grantedAt === after.grantedAt && r.keyset.id < after.id),
      );
    return Promise.resolve(rows.slice(0, limit));
  }

  listByUser(userId: string): Promise<Enrollment[]> {
    return Promise.resolve(
      this.newestFirst([...this.rows.values()].filter((e) => e.userId === userId)),
    );
  }

  listTransitions(enrollmentIds: readonly string[]): Promise<EnrollmentTransition[]> {
    return Promise.resolve(this.transitions.filter((t) => enrollmentIds.includes(t.enrollmentId)));
  }
}

export type RecordedEvent =
  | { readonly type: 'granted'; readonly payload: EnrollmentGrantedPayload }
  | { readonly type: 'revoked'; readonly payload: EnrollmentRevokedPayload };

export class RecordingEventPublisher extends EnrollmentEventPublisher {
  readonly events: RecordedEvent[] = [];

  granted(trx: Transaction<DB>, payload: EnrollmentGrantedPayload): Promise<void> {
    if (!trx.isTransaction) throw new TypeError('events need the caller transaction');
    this.events.push({ type: 'granted', payload });
    return Promise.resolve();
  }

  revoked(trx: Transaction<DB>, payload: EnrollmentRevokedPayload): Promise<void> {
    if (!trx.isTransaction) throw new TypeError('events need the caller transaction');
    this.events.push({ type: 'revoked', payload });
    return Promise.resolve();
  }
}

export class FakeTransactionRunner extends TransactionRunner {
  runs = 0;

  async run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    this.runs += 1;
    return work(FAKE_TRX);
  }
}

export class FakeFreeEnrollmentRateLimiter extends FreeEnrollmentRateLimiter {
  readonly hits: string[] = [];
  limit = Number.POSITIVE_INFINITY;

  hitFreeEnrollment(userId: string): Promise<void> {
    this.hits.push(userId);
    if (this.hits.filter((u) => u === userId).length > this.limit) {
      return Promise.reject(new RateLimitedError('Too many enrollments.', { retryAfterMs: 1000 }));
    }
    return Promise.resolve();
  }
}

export class FakeCoursePriceReader extends CoursePriceReader {
  readonly prices = new Map<string, string>();

  findPriceAmount(courseId: string, _ex?: Executor): Promise<string | null> {
    return Promise.resolve(this.prices.get(courseId) ?? null);
  }
}

export interface FakeCourse {
  readonly id: string;
  readonly ownerId: string;
  readonly status: 'PUBLISHED' | 'ARCHIVED';
  readonly title: string;
  readonly slug: string;
}

/** The two `CatalogFacade` reads enrollment uses. */
export class FakeCatalog {
  readonly courses = new Map<string, FakeCourse>();
  readonly summaryCalls: string[][] = [];

  add(overrides: Partial<FakeCourse> = {}): FakeCourse {
    const id = overrides.id ?? randomUUID();
    const course: FakeCourse = {
      id,
      ownerId: overrides.ownerId ?? randomUUID(),
      status: overrides.status ?? 'PUBLISHED',
      title: overrides.title ?? `Course ${id.slice(0, 4)}`,
      slug: overrides.slug ?? `course-${id.slice(0, 8)}`,
    };
    this.courses.set(id, course);
    return course;
  }

  getPublishedCourse(courseId: string): Promise<PublishedCourseSummary | null> {
    const c = this.courses.get(courseId);
    return Promise.resolve(
      c === undefined
        ? null
        : {
            id: c.id,
            slug: c.slug,
            ownerId: c.ownerId,
            status: c.status,
            liveRevisionId: randomUUID(),
            firstPublishedAt: new Date(),
          },
    );
  }

  getCourseSummaries(courseIds: readonly string[]): Promise<CourseSummary[]> {
    this.summaryCalls.push([...courseIds]);
    if (new Set(courseIds).size > 100) return Promise.reject(new RangeError('too many ids'));
    return Promise.resolve(
      [...new Set(courseIds)].flatMap((id) => {
        const c = this.courses.get(id);
        return c === undefined
          ? []
          : [
              {
                id: c.id,
                slug: c.slug,
                ownerId: c.ownerId,
                status: c.status,
                liveRevisionId: randomUUID(),
                title: c.title,
                hasThumbnail: true,
              },
            ];
      }),
    );
  }
}

/** `UsersFacade.getPublicProfiles` (banned users have none) and `IdentityFacade.getUserSummary`. */
export class FakePeople {
  readonly users = new Map<string, { displayName: string; banned: boolean }>();

  add(displayName = 'Someone', banned = false): string {
    const id = randomUUID();
    this.users.set(id, { displayName, banned });
    return id;
  }

  getPublicProfiles(userIds: readonly string[]): Promise<PublicProfile[]> {
    return Promise.resolve(
      userIds.flatMap((id) => {
        const u = this.users.get(id);
        return u === undefined || u.banned
          ? []
          : [
              {
                id,
                displayName: u.displayName,
                headline: null,
                bio: null,
                avatarUrl: null,
                isInstructor: true,
              },
            ];
      }),
    );
  }

  getUserSummary(userId: string): Promise<UserSummary | null> {
    const u = this.users.get(userId);
    return Promise.resolve(
      u === undefined
        ? null
        : {
            id: userId,
            email: `${userId}@example.test`,
            displayName: u.displayName,
            emailVerified: true,
            status: u.banned ? 'BANNED' : 'ACTIVE',
            createdAt: new Date(),
          },
    );
  }
}

/** Every enrollment use case wired to in-memory fakes (no Nest, no DB). */
export function createEnrollmentHarness() {
  const repo = new InMemoryEnrollmentRepository();
  const events = new RecordingEventPublisher();
  const tx = new FakeTransactionRunner();
  const rateLimiter = new FakeFreeEnrollmentRateLimiter();
  const prices = new FakeCoursePriceReader();
  const catalog = new FakeCatalog();
  const people = new FakePeople();
  const catalogFacade = catalog as unknown as CatalogFacade;
  const identity = people as unknown as IdentityFacade;
  const users = people as unknown as UsersFacade;

  const writer = new EnrollmentWriter(repo, events);
  const assembler = new AdminEnrollmentAssembler(repo, catalogFacade);
  return {
    repo,
    events,
    tx,
    rateLimiter,
    prices,
    catalog,
    people,
    writer,
    facade: new EnrollmentFacade(writer, repo),
    entitlements: new EnrollmentEntitlements(repo),
    enrollFree: new EnrollFreeCommand(rateLimiter, catalogFacade, prices, writer, tx),
    myLearning: new ListMyLearningQuery(repo, catalogFacade, users),
    adminList: new AdminListUserEnrollmentsQuery(identity, repo, assembler),
    adminGrant: new AdminGrantEnrollmentCommand(identity, catalogFacade, writer, assembler, tx),
    adminRevoke: new AdminRevokeEnrollmentCommand(repo, writer, assembler, tx),
  };
}

export type EnrollmentHarness = ReturnType<typeof createEnrollmentHarness>;
