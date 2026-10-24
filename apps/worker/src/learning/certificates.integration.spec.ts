import type { EventEnvelope } from '@udemy/contracts';
import {
  type DB,
  type Kysely,
  revokeEnrollment,
  grantEnrollment,
  sql,
  transitionCertificate,
} from '@udemy/db';
import {
  createActiveEnrollment,
  createCourseCompletion,
  createUser,
  deleteTestData,
  skipUnlessMigrated,
  useIntegrationDb,
} from '@udemy/db/testing';
import type { ObjectStorage } from '@udemy/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeConfig } from '../identity/testing/identity-mail.fakes';
import { IdempotentEventProcessor } from '../messaging/idempotency/idempotent-event-processor';
import type { RegisteredEventHandler } from '../messaging/event-handler.interface';
import { cleanupPhase5, phase5Envelope, registered, seedCourse } from '../testing/phase5-fixtures';
import { CertificatePdfPublisher } from './certificates/certificate-pdf.publisher';
import { CertificateIssuerHandler } from './handlers/certificate-issuer.handler';
import {
  CertificateReinstaterHandler,
  CertificateRevokerHandler,
} from './handlers/certificate-revoker.handlers';
import { CertificateSourceReader } from './persistence/certificate-source.reader';

/**
 * learning.certificate-issuer / certificate-revoker against the dev Postgres with the real
 * idempotent processor (claim + handler writes in one transaction, after-commit PDF render).
 * S3 is a recording fake (no MinIO needed). Redelivery idempotency: a redelivered event is a
 * duplicate claim; a re-emitted one (new event id, same facts) writes nothing new.
 *
 * WRITTEN IN CODE-ONLY MODE (P5-T15): never run yet.
 */
describe('certificates (integration: Postgres)', () => {
  const pg = useIntegrationDb();
  const userIds: string[] = [];
  const categoryIds: string[] = [];
  const eventIds: string[] = [];
  const certificateIds: string[] = [];
  const puts: { key: string; bytes: number }[] = [];
  let processor: IdempotentEventProcessor;
  let issuer: RegisteredEventHandler;
  let revoker: RegisteredEventHandler;
  let reinstater: RegisteredEventHandler;

  beforeAll(() => {
    if (pg.unavailableReason !== undefined) return;
    const storage = {
      putObject: async (input: { key: string; body: Buffer }) => {
        puts.push({ key: input.key, bytes: input.body.length });
        return { etag: undefined };
      },
    } as unknown as ObjectStorage;
    const publisher = new CertificatePdfPublisher(pg.db, storage, fakeConfig());
    issuer = registered(
      'learning.progress',
      'CourseCompleted',
      'learning.certificate-issuer',
      new CertificateIssuerHandler(new CertificateSourceReader(), publisher),
    );
    revoker = registered(
      'enrollment.enrollment',
      'EnrollmentRevoked',
      'learning.certificate-revoker.enrollment-revoked',
      new CertificateRevokerHandler(),
    );
    reinstater = registered(
      'enrollment.enrollment',
      'EnrollmentGranted',
      'learning.certificate-revoker.enrollment-granted',
      new CertificateReinstaterHandler(),
    );
    processor = new IdempotentEventProcessor(pg.db);
  });

  afterAll(async () => {
    if (pg.unavailableReason !== undefined) return;
    await cleanupPhase5(pg.db, { eventIds, aggregateIds: certificateIds });
    await deleteTestData(pg.db, userIds, categoryIds);
  });

  function track(envelope: EventEnvelope): EventEnvelope {
    eventIds.push(envelope.eventId);
    return envelope;
  }

  async function seed(): Promise<{
    db: Kysely<DB>;
    ownerId: string;
    userId: string;
    courseId: string;
  }> {
    const db = pg.db;
    const ownerId = await createUser(db);
    const userId = await createUser(db);
    userIds.push(ownerId, userId);
    const course = await seedCourse(db, ownerId);
    categoryIds.push(...course.categoryIds);
    await db.transaction().execute(async (trx) => {
      await createActiveEnrollment(trx, { userId, courseId: course.courseId });
      await createCourseCompletion(trx, { userId, courseId: course.courseId });
    });
    return { db, ownerId, userId, courseId: course.courseId };
  }

  const completed = (userId: string, courseId: string) =>
    track(
      phase5Envelope('CourseCompleted', 'learning.progress', userId, {
        userId,
        courseId,
        revisionId: courseId,
        lectureCount: 1,
        completedAt: new Date().toISOString(),
      }),
    );

  const revokedEvent = (userId: string, courseId: string, actorId: string) =>
    track(
      phase5Envelope('EnrollmentRevoked', 'enrollment.enrollment', userId, {
        enrollmentId: userId,
        userId,
        courseId,
        reason: 'ADMIN',
        refundId: null,
        actorId,
        revokedAt: new Date().toISOString(),
      }),
    );

  const regrantEvent = (userId: string, courseId: string) =>
    track(
      phase5Envelope('EnrollmentGranted', 'enrollment.enrollment', userId, {
        enrollmentId: userId,
        userId,
        courseId,
        source: 'FREE',
        orderLineId: null,
        regrant: true,
        grantedAt: new Date().toISOString(),
      }),
    );

  async function certificate(db: Kysely<DB>, userId: string, courseId: string) {
    const row = await db
      .selectFrom('learning.certificates')
      .selectAll()
      .where('userId', '=', userId)
      .where('courseId', '=', courseId)
      .executeTakeFirst();
    if (row !== undefined && !certificateIds.includes(row.id)) certificateIds.push(row.id);
    return row;
  }

  async function transitions(db: Kysely<DB>, certificateId: string) {
    return db
      .selectFrom('learning.certificateTransitions')
      .select(['seq', 'action', 'cause', 'toStatus'])
      .where('certificateId', '=', certificateId)
      .orderBy('seq')
      .execute();
  }

  async function outboxTypes(db: Kysely<DB>, certificateId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('outbox.events')
      .select('type')
      .where('aggregateId', '=', certificateId)
      .orderBy('id') // uuidv7: insertion order, also within one transaction
      .execute();
    return rows.map((r) => r.type);
  }

  it('CourseCompleted issues once: a redelivery is a duplicate, a re-emit writes nothing new', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const { db, userId, courseId } = await seed();
    const first = completed(userId, courseId);

    await expect(processor.process(issuer, first)).resolves.toBe('processed');
    await expect(processor.process(issuer, first)).resolves.toBe('duplicate');
    await expect(processor.process(issuer, completed(userId, courseId))).resolves.toBe('processed');

    const cert = await certificate(db, userId, courseId);
    expect(cert).toMatchObject({
      status: 'ACTIVE',
      recipientName: 'IT db user',
      courseTitle: 'Integration course',
    });
    expect(cert?.publicCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await transitions(db, cert!.id)).toEqual([
      { seq: 1, action: 'ISSUE', cause: 'COURSE_COMPLETED', toStatus: 'ACTIVE' },
    ]);
    expect(await outboxTypes(db, cert!.id)).toEqual(['CertificateIssued.v1']);
    // after commit: rendered once at the deterministic key, then recorded
    expect(cert?.pdfObjectKey).toBe(`certificates/${cert!.id}/v1.pdf`);
    expect(cert?.pdfRenderedAt).not.toBeNull();
    expect(puts.filter((p) => p.key === cert?.pdfObjectKey)).toHaveLength(1);
  }, 30_000);

  it('issues and revokes at once when the enrollment is already revoked', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const { db, ownerId, userId, courseId } = await seed();
    await db.transaction().execute((trx) =>
      revokeEnrollment(trx, {
        userId,
        courseId,
        revokeReason: 'ADMIN',
        actorId: ownerId,
        reason: 'integration test revoke',
      }),
    );

    await expect(processor.process(issuer, completed(userId, courseId))).resolves.toBe('processed');

    const cert = await certificate(db, userId, courseId);
    expect(cert?.status).toBe('REVOKED');
    expect((await transitions(db, cert!.id)).map((t) => [t.action, t.cause])).toEqual([
      ['ISSUE', 'COURSE_COMPLETED'],
      ['REVOKE', 'ENROLLMENT_REVOKED'],
    ]);
    expect(await outboxTypes(db, cert!.id)).toEqual([
      'CertificateIssued.v1',
      'CertificateRevoked.v1',
    ]);
  }, 30_000);

  it('EnrollmentRevoked revokes (SQL now()), a redelivery is a no-op, a regrant reinstates', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const { db, ownerId, userId, courseId } = await seed();
    await processor.process(issuer, completed(userId, courseId));
    const cert = (await certificate(db, userId, courseId))!;

    const revoke = revokedEvent(userId, courseId, ownerId);
    await expect(processor.process(revoker, revoke)).resolves.toBe('processed');
    await expect(processor.process(revoker, revoke)).resolves.toBe('duplicate');
    await expect(processor.process(revoker, revokedEvent(userId, courseId, ownerId))).resolves.toBe(
      'processed',
    );
    const revoked = await certificate(db, userId, courseId);
    expect(revoked?.status).toBe('REVOKED');
    const { rows } = await sql<{ same: boolean }>`
      SELECT c.revoked_at = t.occurred_at AS same
        FROM learning.certificates c
        JOIN learning.certificate_transitions t ON t.certificate_id = c.id AND t.seq = 2
       WHERE c.id = ${cert.id}
    `.execute(db);
    expect(rows[0]?.same).toBe(true);

    await expect(processor.process(reinstater, regrantEvent(userId, courseId))).resolves.toBe(
      'processed',
    );
    expect((await certificate(db, userId, courseId))?.status).toBe('ACTIVE');
    expect((await transitions(db, cert.id)).map((t) => [t.action, t.cause])).toEqual([
      ['ISSUE', 'COURSE_COMPLETED'],
      ['REVOKE', 'ENROLLMENT_REVOKED'],
      ['REINSTATE', 'ENROLLMENT_REGRANTED'],
    ]);
    expect(await outboxTypes(db, cert.id)).toEqual([
      'CertificateIssued.v1',
      'CertificateRevoked.v1',
      'CertificateReinstated.v1',
    ]);
  }, 30_000);

  it('an admin revocation sticks: a regrant does not reinstate it', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const { db, ownerId, userId, courseId } = await seed();
    await processor.process(issuer, completed(userId, courseId));
    const cert = (await certificate(db, userId, courseId))!;
    await db.transaction().execute((trx) =>
      transitionCertificate(trx, {
        certificateId: cert.id,
        action: 'REVOKE',
        cause: 'ADMIN',
        actorId: ownerId,
        reason: 'integration test: admin revocation',
      }),
    );
    // the enrollment is revoked and regranted afterwards (refund, then re-purchase)
    await db.transaction().execute(async (trx) => {
      await revokeEnrollment(trx, {
        userId,
        courseId,
        revokeReason: 'ADMIN',
        actorId: ownerId,
        reason: 'integration test revoke',
      });
      await grantEnrollment(trx, { userId, courseId, source: 'FREE' });
    });
    await expect(processor.process(revoker, revokedEvent(userId, courseId, ownerId))).resolves.toBe(
      'processed',
    );
    await expect(processor.process(reinstater, regrantEvent(userId, courseId))).resolves.toBe(
      'processed',
    );

    expect((await certificate(db, userId, courseId))?.status).toBe('REVOKED');
    expect((await transitions(db, cert.id)).map((t) => [t.action, t.cause])).toEqual([
      ['ISSUE', 'COURSE_COMPLETED'],
      ['REVOKE', 'ADMIN'],
    ]);
    expect(await outboxTypes(db, cert.id)).toEqual(['CertificateIssued.v1']);
  }, 30_000);
});
