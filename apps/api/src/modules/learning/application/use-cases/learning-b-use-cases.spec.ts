import {
  AdminCertificateSchema,
  AdminUserCertificatesSchema,
  CertificatePageSchema,
  CertificateSchema,
  CertificateVerificationSchema,
  ErrorCode,
  NotePageSchema,
  NoteSchema,
  QuizAttemptDetailSchema,
  QuizAttemptPageSchema,
  QuizAttemptSchema,
  SubmitQuizAttemptResponseSchema,
} from '@udemy/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../../../shared/errors';
import {
  ADMIN,
  ALL_CORRECT,
  EXPLANATION,
  type LearningBHarness,
  learningBHarness,
  Q1,
  Q2,
  Q3,
  QUIZ_CONTENT,
  TWO_OF_THREE,
} from '../testing/learning-b.fakes';
import {
  ARTICLE,
  COURSE,
  curriculumOf,
  FOREIGN_LECTURE,
  lecture,
  OTHER_STUDENT,
  OWNER,
  QUIZ,
  RESOURCE,
  REVISION,
  STUDENT,
  VIDEO,
} from '../testing/learning.fakes';

const UNKNOWN = '01900000-0000-7000-8000-00000000c999';
const REVISION_2 = '01900000-0000-7000-8000-00000000d002';
const CODE = '01J9ZP4X6V8Q2M3N5R7T9W0Y1A';
const OTHER_CODE = '01J9ZP4X6V8Q2M3N5R7T9W0Y1B';

/** Every key-revealing field or text the answer key could leak through. */
const KEY_LEAK = /isCorrect|"correct"|correctOptions":\[|explanationMd":"|SECRET-EXPLANATION/;

function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code });
}

/* =================================================================================== notes */

describe('Notes', () => {
  let h: LearningBHarness;
  beforeEach(() => {
    h = learningBHarness();
  });

  const create = (input: Partial<Parameters<LearningBHarness['createNote']['execute']>[0]> = {}) =>
    h.createNote.execute({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: VIDEO,
      bodyMd: 'Remember **this**',
      ...input,
    });

  it('creates a note on a live lecture with a video timestamp, under the note cap lock', async () => {
    const note = NoteSchema.parse(await create({ positionSeconds: 42 }));
    expect(note).toMatchObject({
      courseId: COURSE,
      lectureId: VIDEO,
      positionSeconds: 42,
      bodyMd: 'Remember **this**',
    });
    expect(h.notes.capLocks).toBe(1);
    expect(h.rateLimiter.hits).toContainEqual({ rule: 'noteWrite', subject: STUDENT });
  });

  it('404 for an unknown course and for a lecture of another course (IDOR through the path)', async () => {
    await rejectsWith(create({ courseId: UNKNOWN }), ErrorCode.CourseNotFound);
    await rejectsWith(create({ lectureId: FOREIGN_LECTURE }), ErrorCode.LectureNotFound);
  });

  it('403 enrollment_required without an ACTIVE enrollment, also for the owner', async () => {
    await rejectsWith(create({ userId: OTHER_STUDENT }), ErrorCode.EnrollmentRequired);
    await rejectsWith(create({ userId: OWNER }), ErrorCode.EnrollmentRequired);
  });

  it('a timestamp only on a video and within its duration (422 validation_failed)', async () => {
    await rejectsWith(
      create({ lectureId: ARTICLE, positionSeconds: 1 }),
      ErrorCode.ValidationFailed,
    );
    await rejectsWith(create({ positionSeconds: 101 }), ErrorCode.ValidationFailed);
    await expect(create({ positionSeconds: 100 })).resolves.toMatchObject({ positionSeconds: 100 });
    await expect(create({ lectureId: ARTICLE })).resolves.toMatchObject({ positionSeconds: null });
  });

  it('422 markdown_not_allowed for raw HTML or images', async () => {
    await rejectsWith(create({ bodyMd: '<script>x</script>' }), ErrorCode.MarkdownNotAllowed);
    await rejectsWith(
      create({ bodyMd: '![x](https://e.test/i.png)' }),
      ErrorCode.MarkdownNotAllowed,
    );
    expect(h.notes.notes.size).toBe(0);
  });

  it('422 note_limit_exceeded at 500 notes per course', async () => {
    for (let i = 0; i < 500; i++) {
      h.notes.notes.set(`n${i}`, {
        id: `n${i}`,
        userId: STUDENT,
        courseId: COURSE,
        lectureId: VIDEO,
        positionSeconds: null,
        bodyMd: 'x',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });
    }
    await rejectsWith(create(), ErrorCode.NoteLimitExceeded);
  });

  it('429 when the note write limit is exhausted', async () => {
    h.rateLimiter.limited.add('noteWrite');
    await expect(create()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('lists my notes newest first, per lecture, with a keyset cursor; never other users', async () => {
    const first = await create({ bodyMd: 'one' });
    h.clock.advance(1);
    const second = await create({ lectureId: ARTICLE, bodyMd: 'two' });
    h.clock.advance(1);
    const third = await create({ bodyMd: 'three' });
    h.enrollment.active.add(`${OTHER_STUDENT}:${COURSE}`);
    await create({ userId: OTHER_STUDENT, bodyMd: 'foreign' });

    const page1 = NotePageSchema.parse(
      await h.listNotes.execute({ userId: STUDENT, courseId: COURSE, limit: 2 }),
    );
    expect(page1.items.map((n) => n.id)).toEqual([third.id, second.id]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await h.listNotes.execute({
      userId: STUDENT,
      courseId: COURSE,
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2).toEqual({ items: [expect.objectContaining({ id: first.id })], nextCursor: null });

    const videoOnly = await h.listNotes.execute({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: VIDEO.toUpperCase(),
      limit: 20,
    });
    expect(videoOnly.items.map((n) => n.id)).toEqual([third.id, first.id]);
  });

  it('list: 403 without enrollment, 422 for a forged cursor', async () => {
    await rejectsWith(
      h.listNotes.execute({ userId: OTHER_STUDENT, courseId: COURSE, limit: 20 }),
      ErrorCode.EnrollmentRequired,
    );
    await rejectsWith(
      h.listNotes.execute({ userId: STUDENT, courseId: COURSE, limit: 20, cursor: 'Zm9v' }),
      ErrorCode.ValidationFailed,
    );
  });

  it('update and delete: own notes only (404 note_not_found), and still after a revoke (D9)', async () => {
    const note = await create({ positionSeconds: 10 });
    h.enrollment.active.clear();
    h.accessCache.values.clear();

    const edited = await h.updateNote.execute({
      userId: STUDENT,
      noteId: note.id,
      bodyMd: 'edited',
      positionSeconds: null,
    });
    expect(NoteSchema.parse(edited)).toMatchObject({ bodyMd: 'edited', positionSeconds: null });
    await rejectsWith(
      h.updateNote.execute({ userId: OTHER_STUDENT, noteId: note.id, bodyMd: 'x' }),
      ErrorCode.NoteNotFound,
    );
    await rejectsWith(
      h.updateNote.execute({ userId: STUDENT, noteId: 'not-a-uuid', bodyMd: 'x' }),
      ErrorCode.NoteNotFound,
    );
    await rejectsWith(
      h.deleteNote.execute({ userId: OTHER_STUDENT, noteId: note.id }),
      ErrorCode.NoteNotFound,
    );
    await h.deleteNote.execute({ userId: STUDENT, noteId: note.id });
    await rejectsWith(
      h.deleteNote.execute({ userId: STUDENT, noteId: note.id }),
      ErrorCode.NoteNotFound,
    );
  });

  it('update: a new timestamp must fit the lecture in the CURRENT live revision', async () => {
    const note = await create();
    await expect(
      h.updateNote.execute({ userId: STUDENT, noteId: note.id, positionSeconds: 99 }),
    ).resolves.toMatchObject({ positionSeconds: 99 });
    await rejectsWith(
      h.updateNote.execute({ userId: STUDENT, noteId: note.id, positionSeconds: 101 }),
      ErrorCode.ValidationFailed,
    );
    await rejectsWith(
      h.updateNote.execute({ userId: STUDENT, noteId: note.id, bodyMd: '<b>x</b>' }),
      ErrorCode.MarkdownNotAllowed,
    );
    // the video left the curriculum: only clearing the timestamp is possible
    h.catalog.curricula.set(COURSE, curriculumOf([lecture(ARTICLE, 'ARTICLE')]));
    await rejectsWith(
      h.updateNote.execute({ userId: STUDENT, noteId: note.id, positionSeconds: 5 }),
      ErrorCode.ValidationFailed,
    );
    await expect(
      h.updateNote.execute({ userId: STUDENT, noteId: note.id, positionSeconds: null }),
    ).resolves.toMatchObject({ positionSeconds: null });
  });
});

/* =========================================================================== quiz attempts */

describe('Quiz attempts', () => {
  let h: LearningBHarness;
  beforeEach(() => {
    h = learningBHarness();
  });

  const start = (userId = STUDENT, lectureId = QUIZ) =>
    h.startAttempt.execute({ userId, courseId: COURSE, lectureId });
  const submit = (attemptId: string, answers: typeof ALL_CORRECT, userId = STUDENT) =>
    h.submitAttempt.execute({ userId, attemptId, answers });

  it('START: 201 with the live revision questions in order and NO correctness fields', async () => {
    const { attempt, created } = await start();
    expect(created).toBe(true);
    const parsed = QuizAttemptSchema.parse(attempt);
    expect(parsed).toMatchObject({
      courseId: COURSE,
      lectureId: QUIZ,
      revisionId: REVISION,
      status: 'IN_PROGRESS',
      passPct: 70,
      questionCount: 3,
    });
    expect(parsed.questions.map((q) => [q.id, q.position, q.options.length])).toEqual([
      [Q1, 0, 3],
      [Q2, 1, 4],
      [Q3, 2, 2],
    ]);
    expect(JSON.stringify(attempt)).not.toMatch(KEY_LEAK);
    expect(JSON.stringify(attempt)).not.toContain('explanation');
    expect(h.catalog.answerKeyCalls).toEqual([]);
  });

  it('START again: 200 with the same open attempt (one open attempt per user and quiz)', async () => {
    const first = await start();
    const again = await start();
    expect(again.created).toBe(false);
    expect(again.attempt.id).toBe(first.attempt.id);
    expect([...h.attempts.attempts.values()]).toHaveLength(1);
  });

  it('START: an open attempt of a revision that is no longer live is abandoned', async () => {
    const old = await start();
    h.catalog.curricula.set(COURSE, { ...curriculumOf(), liveRevisionId: REVISION_2 });
    h.catalog.setQuiz(REVISION_2, QUIZ, QUIZ_CONTENT);
    const fresh = await start();
    expect(fresh.created).toBe(true);
    expect(fresh.attempt.revisionId).toBe(REVISION_2);
    expect(h.attempts.attempts.get(old.attempt.id)?.status).toBe('ABANDONED');
  });

  it('START: 422 lecture_type_mismatch for a non-quiz lecture, 403 / 404 per the learner rule', async () => {
    await rejectsWith(start(STUDENT, ARTICLE), ErrorCode.LectureTypeMismatch);
    await rejectsWith(start(OTHER_STUDENT), ErrorCode.EnrollmentRequired);
    await rejectsWith(start(OWNER), ErrorCode.EnrollmentRequired);
    await rejectsWith(start(STUDENT, FOREIGN_LECTURE), ErrorCode.LectureNotFound);
    h.rateLimiter.limited.add('quizStart');
    await expect(start()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('a FAILED attempt: own right/wrong only, never the key or explanations', async () => {
    const { attempt } = await start();
    const result = SubmitQuizAttemptResponseSchema.parse(await submit(attempt.id, TWO_OF_THREE));
    expect(result).toMatchObject({
      scorePct: 67,
      correctCount: 2,
      questionCount: 3,
      passed: false,
      revealed: false,
      progress: { lectureCompleted: false, courseCompleted: false, coursePct: 0 },
    });
    expect(result.questions.map((q) => [q.yourAnswerCorrect, q.selectedOptions])).toEqual([
      [true, [1]],
      [false, [0]],
      [true, [0]],
    ]);
    expect(
      result.questions.every((q) => q.correctOptions === null && q.explanationMd === null),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(KEY_LEAK);
    // the key was loaded for grading only (once), never for the response
    expect(h.catalog.answerKeyCalls).toHaveLength(1);
    expect(h.events.ofType('QuizAttemptGraded')).toHaveLength(1);
    expect(h.events.ofType('QuizAttemptGraded')[0]?.payload).toMatchObject({
      attemptId: attempt.id,
      scorePct: 67,
      passed: false,
    });
    expect(h.events.ofType('LectureCompleted')).toHaveLength(0);

    const detail = QuizAttemptDetailSchema.parse(
      await h.getAttempt.execute({ userId: STUDENT, attemptId: attempt.id }),
    );
    expect(detail.result?.revealed).toBe(false);
    expect(JSON.stringify(detail)).not.toMatch(KEY_LEAK);
    expect(h.catalog.answerKeyCalls).toHaveLength(1);
  });

  it('retry after a fail, then pass: only the PASSED attempt reveals keys and explanations', async () => {
    const failed = (await start()).attempt;
    await submit(failed.id, TWO_OF_THREE);

    const retry = await start();
    expect(retry.created).toBe(true);
    expect(retry.attempt.id).not.toBe(failed.id);
    const openDetail = await h.getAttempt.execute({ userId: STUDENT, attemptId: retry.attempt.id });
    expect(QuizAttemptDetailSchema.parse(openDetail).result).toBeNull();
    expect(JSON.stringify(openDetail)).not.toMatch(KEY_LEAK);

    const passed = SubmitQuizAttemptResponseSchema.parse(
      await submit(retry.attempt.id, ALL_CORRECT),
    );
    expect(passed).toMatchObject({ scorePct: 100, passed: true, revealed: true });
    expect(passed.questions.map((q) => [q.correctOptions, q.explanationMd])).toEqual([
      [[1], `${EXPLANATION} 1`],
      [[0, 2], `${EXPLANATION} 2`],
      [[0], null],
    ]);
    expect(passed.progress.lectureCompleted).toBe(true);

    // the earlier FAILED attempt stays key-free, even now that the learner passed
    const failedDetail = await h.getAttempt.execute({ userId: STUDENT, attemptId: failed.id });
    expect(failedDetail.result?.revealed).toBe(false);
    expect(JSON.stringify(failedDetail)).not.toMatch(KEY_LEAK);

    const passedDetail = QuizAttemptDetailSchema.parse(
      await h.getAttempt.execute({ userId: STUDENT, attemptId: retry.attempt.id }),
    );
    expect(passedDetail.result?.revealed).toBe(true);
  });

  it('a pass completes the QUIZ lecture (QUIZ_PASSED with the attempt) and possibly the course', async () => {
    h.completions.seedCompletion(STUDENT, COURSE, VIDEO, 'VIDEO', 'VIDEO_WATCHED');
    h.completions.seedCompletion(STUDENT, COURSE, ARTICLE, 'ARTICLE', 'MANUAL');
    h.completions.seedCompletion(STUDENT, COURSE, RESOURCE, 'RESOURCE', 'MANUAL');
    const { attempt } = await start();
    const result = await submit(attempt.id, ALL_CORRECT);
    expect(result.progress).toEqual({
      lectureCompleted: true,
      courseCompleted: true,
      coursePct: 100,
    });
    expect(h.events.ofType('LectureCompleted')[0]?.payload).toMatchObject({
      lectureId: QUIZ,
      lectureType: 'QUIZ',
      cause: 'QUIZ_PASSED',
    });
    expect(h.events.ofType('CourseCompleted')).toHaveLength(1);
    expect(h.completions.completions.get(`${STUDENT}:${QUIZ}`)?.cause).toBe('QUIZ_PASSED');
    // the whole grading ran in ONE transaction
    expect(h.tx.runs).toBe(2);
  });

  it('a repeat SUBMIT returns the stored result and writes nothing', async () => {
    const { attempt } = await start();
    const first = await submit(attempt.id, ALL_CORRECT);
    const events = h.events.events.length;
    const again = await submit(attempt.id, []);
    expect(again).toEqual(first);
    expect(h.events.events.length).toBe(events);
  });

  it('unanswered questions count as wrong', async () => {
    const { attempt } = await start();
    const result = await submit(attempt.id, []);
    expect(result).toMatchObject({ correctCount: 0, scorePct: 0, passed: false });
    expect(result.questions.every((q) => q.selectedOptions.length === 0)).toBe(true);
  });

  it('422 quiz_answers_invalid; the attempt stays open', async () => {
    const { attempt } = await start();
    for (const answers of [
      [{ questionId: UNKNOWN, optionPositions: [0] }],
      [{ questionId: Q3, optionPositions: [2] }],
      [{ questionId: Q1, optionPositions: [0, 1] }],
    ]) {
      await rejectsWith(submit(attempt.id, answers), ErrorCode.QuizAnswersInvalid);
    }
    expect(h.attempts.attempts.get(attempt.id)?.status).toBe('IN_PROGRESS');
  });

  it('409 attempt_not_in_progress for an ABANDONED attempt', async () => {
    const { attempt } = await start();
    h.attempts.attempts.get(attempt.id)!.status = 'ABANDONED';
    h.attempts.attempts.get(attempt.id)!.abandonedAt = new Date(h.clock.ms);
    await rejectsWith(submit(attempt.id, ALL_CORRECT), ErrorCode.AttemptNotInProgress);
  });

  it('IDOR: another learner gets 404 quiz_attempt_not_found on GET and SUBMIT', async () => {
    const { attempt } = await start();
    h.enrollment.active.add(`${OTHER_STUDENT}:${COURSE}`);
    await rejectsWith(
      h.getAttempt.execute({ userId: OTHER_STUDENT, attemptId: attempt.id }),
      ErrorCode.QuizAttemptNotFound,
    );
    await rejectsWith(
      submit(attempt.id, ALL_CORRECT, OTHER_STUDENT),
      ErrorCode.QuizAttemptNotFound,
    );
  });

  it('SUBMIT needs an ACTIVE enrollment (D9); reading my attempt does not', async () => {
    const { attempt } = await start();
    h.enrollment.active.clear();
    await rejectsWith(submit(attempt.id, ALL_CORRECT), ErrorCode.EnrollmentRequired);
    await expect(
      h.getAttempt.execute({ userId: STUDENT, attemptId: attempt.id }),
    ).resolves.toMatchObject({ status: 'IN_PROGRESS' });
  });

  it('grades against the attempt revision even after a new revision went live (no completion if the quiz left)', async () => {
    const { attempt } = await start();
    h.catalog.curricula.set(COURSE, {
      ...curriculumOf([lecture(VIDEO, 'VIDEO')]),
      liveRevisionId: REVISION_2,
    });
    const result = await submit(attempt.id, ALL_CORRECT);
    expect(result).toMatchObject({ passed: true, revealed: true });
    expect(h.events.ofType('LectureCompleted')).toHaveLength(0);
    expect(h.catalog.answerKeyCalls.every((k) => k === `${REVISION}:${QUIZ}`)).toBe(true);
  });

  it('lists my attempts of a quiz, newest first, as summaries', async () => {
    const a = (await start()).attempt;
    await submit(a.id, TWO_OF_THREE);
    h.clock.advance(5);
    const b = (await start()).attempt;
    const page = QuizAttemptPageSchema.parse(
      await h.listAttempts.execute({
        userId: STUDENT,
        courseId: COURSE,
        lectureId: QUIZ,
        limit: 20,
      }),
    );
    expect(page.items.map((s) => [s.id, s.status, s.scorePct, s.passed])).toEqual([
      [b.id, 'IN_PROGRESS', null, null],
      [a.id, 'SUBMITTED', 67, false],
    ]);
    await rejectsWith(
      h.listAttempts.execute({
        userId: OTHER_STUDENT,
        courseId: COURSE,
        lectureId: QUIZ,
        limit: 20,
      }),
      ErrorCode.EnrollmentRequired,
    );
  });
});

/* ============================================================================ certificates */

describe('Certificates', () => {
  let h: LearningBHarness;
  beforeEach(() => {
    h = learningBHarness();
  });

  it('own list (newest first) and detail; another learner gets 404', async () => {
    const mine = h.certificates.issue({ userId: STUDENT, courseId: COURSE, code: CODE });
    h.certificates.issue({ userId: OTHER_STUDENT, courseId: COURSE, code: OTHER_CODE });
    const page = CertificatePageSchema.parse(
      await h.listMyCertificates.execute({ userId: STUDENT, limit: 20 }),
    );
    expect(page.items).toEqual([
      expect.objectContaining({
        id: mine.id,
        code: CODE,
        courseSlug: 'typescript-from-scratch',
        status: 'ACTIVE',
        pdfReady: true,
        revokedAt: null,
      }),
    ]);
    CertificateSchema.parse(
      await h.getMyCertificate.execute({ userId: STUDENT, certificateId: mine.id }),
    );
    await rejectsWith(
      h.getMyCertificate.execute({ userId: OTHER_STUDENT, certificateId: mine.id }),
      ErrorCode.CertificateNotFound,
    );
  });

  it('PDF: 409 certificate_pdf_pending until rendered, then a presigned attachment', async () => {
    const pending = h.certificates.issue({
      userId: STUDENT,
      courseId: COURSE,
      code: CODE,
      pdfReady: false,
    });
    await rejectsWith(
      h.getMyCertificatePdf.execute({ userId: STUDENT, certificateId: pending.id }),
      ErrorCode.CertificatePdfPending,
    );
    h.certificates.certificates.set(pending.id, {
      ...pending,
      pdfObjectKey: `certificates/${pending.id}/v1.pdf`,
    });
    const url = await h.getMyCertificatePdf.execute({ userId: STUDENT, certificateId: pending.id });
    expect(url.url).toContain(`certificates/${pending.id}/v1.pdf`);
    expect(h.pdfStorage.signed).toEqual([
      { objectKey: `certificates/${pending.id}/v1.pdf`, downloadName: `certificate-${CODE}.pdf` },
    ]);
  });

  it('public verification: snapshots and status, slug only while PUBLISHED, rate-limited per IP', async () => {
    h.certificates.issue({ userId: STUDENT, courseId: COURSE, code: CODE });
    const verified = CertificateVerificationSchema.parse(
      await h.verifyCertificate.execute({ code: CODE, ip: '203.0.113.9' }),
    );
    expect(verified).toMatchObject({
      status: 'ACTIVE',
      recipientName: 'Sam Student',
      courseSlug: 'typescript-from-scratch',
      pdfAvailable: true,
    });
    expect(h.rateLimiter.hits).toContainEqual({
      rule: 'certificateVerify',
      subject: '203.0.113.9',
    });
    h.catalog.curricula.set(COURSE, { ...curriculumOf(), status: 'ARCHIVED' });
    expect(
      (await h.verifyCertificate.execute({ code: CODE, ip: '203.0.113.9' })).courseSlug,
    ).toBeNull();
    await rejectsWith(
      h.verifyCertificate.execute({ code: OTHER_CODE, ip: '203.0.113.9' }),
      ErrorCode.CertificateNotFound,
    );
  });

  it('public PDF: ACTIVE only (a revoked certificate is 404)', async () => {
    h.certificates.issue({ userId: STUDENT, courseId: COURSE, code: CODE, status: 'REVOKED' });
    const verified = await h.verifyCertificate.execute({ code: CODE, ip: '203.0.113.9' });
    expect(verified).toMatchObject({ status: 'REVOKED', pdfAvailable: false });
    expect(verified.revokedAt).not.toBeNull();
    await rejectsWith(
      h.publicCertificatePdf.execute({ code: CODE, ip: '203.0.113.9' }),
      ErrorCode.CertificateNotFound,
    );
  });

  it('admin: list per user with transitions; 404 user_not_found', async () => {
    h.certificates.issue({ userId: STUDENT, courseId: COURSE, code: CODE });
    const listed = AdminUserCertificatesSchema.parse(
      await h.adminListCertificates.execute(STUDENT),
    );
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.transitions.map((t) => [t.action, t.cause])).toEqual([
      ['ISSUE', 'COURSE_COMPLETED'],
    ]);
    await rejectsWith(h.adminListCertificates.execute(UNKNOWN), ErrorCode.UserNotFound);
  });

  it('admin revoke: cause ADMIN with actor and reason, lrnc lock first, outbox keyed by certificate', async () => {
    const certificate = h.certificates.issue({ userId: STUDENT, courseId: COURSE, code: CODE });
    const view = AdminCertificateSchema.parse(
      await h.adminCertificateAction.execute({
        actorId: ADMIN,
        certificateId: certificate.id,
        action: 'REVOKE',
        reason: 'Plagiarised final project',
      }),
    );
    expect(view.certificate).toMatchObject({ status: 'REVOKED' });
    expect(view.certificate.revokedAt).not.toBeNull();
    expect(view.transitions.at(-1)).toMatchObject({
      action: 'REVOKE',
      cause: 'ADMIN',
      actorId: ADMIN,
      actor: { id: ADMIN, displayName: 'Alex Admin' },
      reason: 'Plagiarised final project',
    });
    expect(h.certificates.completionLocks).toEqual([`${STUDENT}:${COURSE}`]);
    expect(h.certificateEvents.events).toEqual([
      expect.objectContaining({
        type: 'CertificateRevoked',
        aggregateId: certificate.id,
        payload: expect.objectContaining({ cause: 'ADMIN', actorId: ADMIN, userId: STUDENT }),
      }),
    ]);

    await rejectsWith(
      h.adminCertificateAction.execute({
        actorId: ADMIN,
        certificateId: certificate.id,
        action: 'REVOKE',
        reason: 'Plagiarised final project',
      }),
      ErrorCode.InvalidStateTransition,
    );

    const reinstated = await h.adminCertificateAction.execute({
      actorId: ADMIN,
      certificateId: certificate.id,
      action: 'REINSTATE',
      reason: 'Appeal accepted after review',
    });
    expect(reinstated.certificate).toMatchObject({ status: 'ACTIVE', revokedAt: null });
    expect(h.certificateEvents.events.map((e) => e.type)).toEqual([
      'CertificateRevoked',
      'CertificateReinstated',
    ]);
    // transition ids are stable per (certificate, seq)
    const again = await h.adminListCertificates.execute(STUDENT);
    expect(again.items[0]?.transitions.map((t) => t.id)).toEqual(
      reinstated.transitions.map((t) => t.id),
    );
    expect(new Set(reinstated.transitions.map((t) => t.id)).size).toBe(3);
  });

  it('admin action on an unknown certificate: 404 certificate_not_found', async () => {
    await rejectsWith(
      h.adminCertificateAction.execute({
        actorId: ADMIN,
        certificateId: UNKNOWN,
        action: 'REVOKE',
        reason: 'Plagiarised final project',
      }),
      ErrorCode.CertificateNotFound,
    );
  });
});
