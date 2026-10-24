import { randomUUID } from 'node:crypto';
import { issueCertificate, sql, transitionCertificate } from '@udemy/db';
import { afterAll, describe, expect, it } from 'vitest';
import { OutboxPublisher } from '../../shared/outbox';
import { deleteTestUsers, useIntegrationDatabase } from '../../testing/integration';
import { insertCatalogTestUser } from '../catalog/testing/catalog-it';
import { CertificatePresenter } from './application/certificate.presenter';
import { CompletionRecorder } from './application/completion-recorder';
import { LearnerAccess } from './application/learner-access';
import { QuizAttemptPresenter } from './application/quiz-attempt.presenter';
import {
  ALL_CORRECT,
  FakeIdentity,
  QUIZ_CONTENT,
  TWO_OF_THREE,
} from './application/testing/learning-b.fakes';
import {
  COURSE,
  FakeAccessCache,
  FakeCatalog,
  FakeEnrollment,
  FakeRateLimiter,
  QUIZ,
  REVISION,
  VIDEO,
} from './application/testing/learning.fakes';
import { AdminCertificateActionCommand } from './application/use-cases/certificates.use-cases';
import { CreateNoteCommand } from './application/use-cases/notes.use-cases';
import {
  StartQuizAttemptCommand,
  SubmitQuizAttemptCommand,
} from './application/use-cases/quiz-attempts.use-cases';
import { KyselyCertificateRepository } from './infrastructure/kysely-certificates.repository';
import { KyselyLearningRepository } from './infrastructure/kysely-learning.repository';
import { KyselyNotesRepository } from './infrastructure/kysely-notes.repository';
import { KyselyQuizAttemptRepository } from './infrastructure/kysely-quiz-attempts.repository';
import { KyselyTransactionRunner } from './infrastructure/kysely-transaction-runner';
import { OutboxCertificateEventPublisher } from './infrastructure/outbox-certificate-event.publisher';
import { OutboxLearningEventPublisher } from './infrastructure/outbox-learning-event.publisher';
import { deleteLearningTestData, learningEventTypes } from './testing/learning-it';

/*
 * P5-T11 against the integration Postgres, without Nest: the real Kysely repositories, the
 * migration 0005 triggers and constraints, and the outbox; fakes only for catalog / enrollment /
 * identity (soft references: any ids work).
 *
 * - two parallel quiz starts: one open attempt (ON CONFLICT on the open-attempt index);
 * - submit: grades stored, score/passed generated, QUIZ_PASSED completion carrying the attempt
 *   (lecture_completions_quiz_passed_ck), QuizAttemptGraded + LectureCompleted in the outbox;
 * - a submit racing the abandon job: exactly one wins;
 * - the notes cap under the `note` advisory lock: parallel creates never exceed 500;
 * - admin revoke: cause ADMIN, revoked_at from SQL now() (certificates_status_log_ck at COMMIT),
 *   the outbox keyed by the certificate, and a later regrant does NOT reinstate it (R13).
 */
describe('learning B: notes, quiz attempts, certificates (integration: Postgres)', () => {
  const pg = useIntegrationDatabase({ max: 8 });
  const userIds: string[] = [];

  function wire() {
    const db = pg.db;
    const catalog = new FakeCatalog();
    catalog.setQuiz(REVISION, QUIZ, QUIZ_CONTENT);
    const enrollment = new FakeEnrollment();
    const access = new LearnerAccess(
      catalog.asFacade(),
      enrollment.asFacade(),
      new FakeAccessCache(),
    );
    const tx = new KyselyTransactionRunner(db);
    const completions = new KyselyLearningRepository(db);
    const events = new OutboxLearningEventPublisher(new OutboxPublisher());
    const recorder = new CompletionRecorder(completions, events);
    const attempts = new KyselyQuizAttemptRepository(db);
    const notes = new KyselyNotesRepository(db);
    const certificates = new KyselyCertificateRepository(db);
    const presenter = new QuizAttemptPresenter(catalog.asFacade(), attempts);
    const identity = new FakeIdentity();
    const limiter = new FakeRateLimiter();
    return {
      db,
      catalog,
      enrollment,
      attempts,
      notes,
      certificates,
      identity,
      start: new StartQuizAttemptCommand(
        limiter,
        access,
        catalog.asFacade(),
        attempts,
        presenter,
        tx,
      ),
      submit: new SubmitQuizAttemptCommand(
        limiter,
        access,
        catalog.asFacade(),
        attempts,
        presenter,
        recorder,
        completions,
        events,
        tx,
      ),
      createNote: new CreateNoteCommand(limiter, access, notes, tx),
      adminAction: new AdminCertificateActionCommand(
        certificates,
        new OutboxCertificateEventPublisher(new OutboxPublisher()),
        new CertificatePresenter(catalog.asFacade(), identity.asFacade(), certificates),
        tx,
      ),
    };
  }

  async function learner(w: ReturnType<typeof wire>, label: string): Promise<string> {
    const id = await insertCatalogTestUser(pg.db, `learning-b-${label}`);
    userIds.push(id);
    w.enrollment.active.add(`${id}:${COURSE}`);
    return id;
  }

  afterAll(async () => {
    if (!pg.available) return;
    await deleteLearningTestData(pg.db, userIds);
    await deleteTestUsers(pg.db, userIds);
  });

  it('two parallel starts give one open attempt with its questions frozen in order', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const w = wire();
    const userId = await learner(w, 'start');
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        w.start.execute({ userId, courseId: COURSE, lectureId: QUIZ }),
      ),
    );
    const ids = new Set(results.map((r) => r.attempt.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const [attemptId] = [...ids];
    const questions = await w.attempts.listQuestions(attemptId!);
    expect(questions.map((q) => [q.questionId, q.position, q.isCorrect])).toEqual(
      QUIZ_CONTENT.questions.map((q, i) => [q.id, i, null]),
    );
    // questions can only be added in the START transaction
    await expect(
      sql`INSERT INTO learning.quiz_attempt_questions (attempt_id, question_id, position)
          VALUES (${attemptId!}, ${randomUUID()}, 9)`.execute(pg.db),
    ).rejects.toMatchObject({ constraint: 'quiz_attempt_questions_same_tx_ck' });
  });

  it('a failed then a passing submit: stored grades, generated score, QUIZ_PASSED completion', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const w = wire();
    const userId = await learner(w, 'submit');
    const first = await w.start.execute({ userId, courseId: COURSE, lectureId: QUIZ });
    const failed = await w.submit.execute({
      userId,
      attemptId: first.attempt.id,
      answers: TWO_OF_THREE,
    });
    expect(failed).toMatchObject({ scorePct: 67, passed: false, revealed: false });
    expect(JSON.stringify(failed)).not.toContain('SECRET-EXPLANATION');

    const second = await w.start.execute({ userId, courseId: COURSE, lectureId: QUIZ });
    expect(second.created).toBe(true);
    const passed = await w.submit.execute({
      userId,
      attemptId: second.attempt.id,
      answers: ALL_CORRECT,
    });
    expect(passed).toMatchObject({ scorePct: 100, passed: true, revealed: true });
    expect(passed.progress.lectureCompleted).toBe(true);

    const completion = await pg.db
      .selectFrom('learning.lectureCompletions')
      .select(['cause', 'quizAttemptId'])
      .where('userId', '=', userId)
      .where('lectureId', '=', QUIZ)
      .executeTakeFirstOrThrow();
    expect(completion).toEqual({ cause: 'QUIZ_PASSED', quizAttemptId: second.attempt.id });
    expect(await learningEventTypes(pg.db, userId)).toEqual([
      'QuizAttemptGraded.v1',
      'QuizAttemptGraded.v1',
      'LectureCompleted.v1',
    ]);
    // selections are append-only and only while open
    await expect(
      sql`INSERT INTO learning.quiz_attempt_selections (attempt_id, question_id, option_position)
          VALUES (${second.attempt.id}, ${QUIZ_CONTENT.questions[2]!.id}, 1)`.execute(pg.db),
    ).rejects.toMatchObject({ constraint: 'quiz_attempt_selections_attempt_open_ck' });
  });

  it('a submit racing the abandon of the same attempt: exactly one wins', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const w = wire();
    const userId = await learner(w, 'race');
    const { attempt } = await w.start.execute({ userId, courseId: COURSE, lectureId: QUIZ });
    const abandon = pg.db.transaction().execute((trx) => w.attempts.abandon(trx, attempt.id));
    const submit = w.submit.execute({ userId, attemptId: attempt.id, answers: ALL_CORRECT });
    const [abandoned, submitted] = await Promise.allSettled([abandon, submit]);
    const row = await pg.db
      .selectFrom('learning.quizAttempts')
      .select('status')
      .where('id', '=', attempt.id)
      .executeTakeFirstOrThrow();
    if (row.status === 'SUBMITTED') {
      expect(submitted.status).toBe('fulfilled');
      expect(abandoned).toEqual({ status: 'fulfilled', value: false });
    } else {
      expect(row.status).toBe('ABANDONED');
      expect(submitted).toMatchObject({
        status: 'rejected',
        reason: { code: 'attempt_not_in_progress' },
      });
    }
  });

  it('parallel note creates never exceed the 500 cap (note advisory lock)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const w = wire();
    const userId = await learner(w, 'notes');
    await sql`
      INSERT INTO learning.notes (user_id, course_id, lecture_id, body_md)
      SELECT ${userId}, ${COURSE}, ${VIDEO}, 'seed ' || g FROM generate_series(1, 495) g
    `.execute(pg.db);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        w.createNote.execute({ userId, courseId: COURSE, lectureId: VIDEO, bodyMd: `n${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(
      results.filter(
        (r) =>
          r.status === 'rejected' && (r.reason as { code?: string }).code === 'note_limit_exceeded',
      ),
    ).toHaveLength(7);
    const { count } = await pg.db
      .selectFrom('learning.notes')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    expect(Number(count)).toBe(500);
  });

  it('admin revoke: cause ADMIN, SQL revoked_at, outbox by certificate; a regrant does not reinstate it', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const w = wire();
    const userId = await learner(w, 'cert');
    const adminId = await insertCatalogTestUser(pg.db, 'learning-b-admin');
    userIds.push(adminId);
    w.identity.users.set(adminId, {
      id: adminId,
      email: 'admin@example.test',
      displayName: 'Alex Admin',
      emailVerified: true,
      status: 'ACTIVE',
      createdAt: new Date(0),
    });
    await sql`
      INSERT INTO learning.course_completions (user_id, course_id, revision_id, lecture_count)
      VALUES (${userId}, ${COURSE}, ${REVISION}, 4)
    `.execute(pg.db);
    const code = '0123456789ABCDEFGHJKMNPQRS';
    const issued = await pg.db.transaction().execute((trx) =>
      issueCertificate(trx, {
        userId,
        courseId: COURSE,
        revisionId: REVISION,
        publicCode: code,
        recipientName: 'Sam Student',
        courseTitle: 'TypeScript from scratch',
        instructorName: 'Ada Instructor',
        sourceEventId: randomUUID(),
      }),
    );
    if (issued.outcome !== 'ISSUED') throw new Error('certificate not issued');

    const view = await w.adminAction.execute({
      actorId: adminId,
      certificateId: issued.certificateId,
      action: 'REVOKE',
      reason: 'Plagiarised final project',
    });
    expect(view.certificate.status).toBe('REVOKED');
    expect(view.transitions.map((t) => [t.action, t.cause, t.actorId])).toEqual([
      ['ISSUE', 'COURSE_COMPLETED', null],
      ['REVOKE', 'ADMIN', adminId],
    ]);
    const { rows } = await sql<{ same: boolean }>`
      SELECT c.revoked_at = t.occurred_at AS same
        FROM learning.certificates c
        JOIN learning.certificate_transitions t ON t.certificate_id = c.id AND t.seq = 2
       WHERE c.id = ${issued.certificateId}
    `.execute(pg.db);
    expect(rows[0]?.same).toBe(true);
    const events = await pg.db
      .selectFrom('outbox.events')
      .select(['type', 'aggregateType'])
      .where('aggregateId', '=', issued.certificateId)
      .execute();
    expect(events).toEqual([
      { type: 'CertificateRevoked.v1', aggregateType: 'learning.certificate' },
    ]);

    // the worker's regrant path: an admin revocation sticks (R13)
    const regrant = await pg.db.transaction().execute((trx) =>
      transitionCertificate(trx, {
        certificateId: issued.certificateId,
        action: 'REINSTATE',
        cause: 'ENROLLMENT_REGRANTED',
        sourceEventId: randomUUID(),
      }),
    );
    expect(regrant).toEqual({ outcome: 'SKIPPED_ADMIN_REVOKE', status: 'REVOKED' });

    await expect(
      w.adminAction.execute({
        actorId: adminId,
        certificateId: issued.certificateId,
        action: 'REVOKE',
        reason: 'Plagiarised final project',
      }),
    ).rejects.toMatchObject({ code: 'invalid_state_transition' });
  });
});
