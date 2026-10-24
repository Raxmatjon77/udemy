import { randomUUID } from 'node:crypto';
import {
  AnnouncementPageSchema,
  AnnouncementSchema,
  AnswerPageSchema,
  AnswerSchema,
  InstructorAnnouncementPageSchema,
  InstructorQaPageSchema,
  ModerationQueuePageSchema,
  ModerationSubjectSchema,
  QuestionDetailSchema,
  QuestionPageSchema,
  QuestionSchema,
  ReportSchema,
} from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../../../shared/errors';
import {
  AnnouncementLimitExceeded,
  AnnouncementNotFound,
  AnswerNotFound,
  CannotVoteOwnContent,
  CourseNotFound,
  EnrollmentRequired,
  InvalidModerationTransition,
  LectureNotFound,
  MarkdownNotAllowed,
  NotContentAuthor,
  QuestionNotFound,
  ReplyNotFound,
} from '../../domain/engagement.errors';
import type { QaViewer } from '../qa-access';
import { createQaHarness, type QaHarness } from '../testing/qa.fakes';

const DAY_MS = 86_400_000;

/** An owner with a published course (one lecture), two enrolled students and an outsider. */
function setup(h: QaHarness = createQaHarness()) {
  const owner = h.users.add('Owner');
  const alice = h.users.add('Alice');
  const bob = h.users.add('Bob');
  const outsider = h.users.add('Outsider');
  const course = h.catalog.add(owner);
  const lectureId = h.catalog.addLecture(course.id, 'Intro');
  h.enrollment.enroll(alice, course.id);
  h.enrollment.enroll(bob, course.id);
  const student = (userId: string): QaViewer => ({ userId, app: 'student' });
  const instructor = (userId: string): QaViewer => ({ userId, app: 'instructor' });
  return { h, owner, alice, bob, outsider, course, lectureId, student, instructor };
}

async function ask(
  s: ReturnType<typeof setup>,
  viewer: QaViewer,
  title = 'How do closures work?',
  lectureId: string | null = null,
) {
  return s.h.askQuestion.execute({
    viewer,
    courseId: s.course.id,
    lectureId,
    title,
    bodyMd: 'Some **markdown**.',
  });
}

describe('AskQuestion (D12, §5)', () => {
  it('learner or owner; QuestionPosted keyed by course; hint after the commit', async () => {
    const s = setup();
    const q = QuestionSchema.parse(await ask(s, s.student(s.alice), 'Why is this?', s.lectureId));
    expect(q).toMatchObject({
      courseId: s.course.id,
      lectureId: s.lectureId,
      title: 'Why is this?',
      mine: true,
      byInstructor: false,
      answerCount: 0,
      resolved: false,
      hidden: false,
      deleted: false,
      author: { id: s.alice, displayName: 'Alice' },
    });
    const byOwner = await ask(s, s.instructor(s.owner), 'A note from the instructor');
    expect(byOwner).toMatchObject({ byInstructor: true, mine: true });

    expect(s.h.events.types()).toEqual(['QuestionPosted', 'QuestionPosted']);
    expect(s.h.events.events.every((e) => e.aggregateId === s.course.id)).toBe(true);
    expect(s.h.events.events[0]?.payload).toMatchObject({
      questionId: q.id,
      lectureId: s.lectureId,
      authorId: s.alice,
    });
    expect(s.h.hints.hints[0]).toEqual({
      courseId: s.course.id,
      questionId: q.id,
      lectureId: s.lectureId,
    });
    expect(s.h.rateLimiter.hits.map((x) => x.rule)).toEqual(['questionPost', 'questionPost']);
  });

  it('403 not enrolled; 403 an instructor-app token on a course it does not own; 404s; 422 markdown', async () => {
    const s = setup();
    await expect(ask(s, s.student(s.outsider))).rejects.toBeInstanceOf(EnrollmentRequired);
    // enrolled, but through the instructor BFF: only the owner may use it
    await expect(ask(s, s.instructor(s.alice))).rejects.toBeInstanceOf(EnrollmentRequired);
    await expect(
      s.h.askQuestion.execute({
        viewer: s.student(s.alice),
        courseId: randomUUID(),
        lectureId: null,
        title: 'Lost question',
        bodyMd: 'x',
      }),
    ).rejects.toBeInstanceOf(CourseNotFound);
    await expect(ask(s, s.student(s.alice), 'Wrong lecture', randomUUID())).rejects.toBeInstanceOf(
      LectureNotFound,
    );
    await expect(
      s.h.askQuestion.execute({
        viewer: s.student(s.alice),
        courseId: s.course.id,
        lectureId: null,
        title: 'Sneaky question',
        bodyMd: '<script>alert(1)</script>',
      }),
    ).rejects.toBeInstanceOf(MarkdownNotAllowed);
    expect(s.h.events.events).toHaveLength(0);
    expect(s.h.hints.hints).toHaveLength(0);

    s.h.rateLimiter.limited.add('questionPost');
    await expect(ask(s, s.student(s.alice))).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('ListQuestions / GetQuestion (keyset per sort, visibility)', () => {
  it('recent / top / unanswered pages, lecture filter, title search; hidden and deleted are excluded', async () => {
    const s = setup();
    const q1 = await ask(s, s.student(s.alice), 'First question about scope', s.lectureId);
    const q2 = await ask(s, s.student(s.bob), 'Second question');
    const q3 = await ask(s, s.student(s.alice), 'Third question about scope');
    s.h.qa.seedAnswer(q1.id, s.owner); // q1 gets the newest activity
    await s.h.vote.execute({
      viewer: s.student(s.bob),
      courseId: s.course.id,
      subject: 'QUESTION',
      subjectId: q3.id,
      on: true,
    });
    const hidden = s.h.qa.seedQuestion({
      courseId: s.course.id,
      authorId: s.bob,
      moderationStatus: 'HIDDEN',
    });

    const list = (viewer: QaViewer, extra: object = {}) =>
      s.h.listQuestions.execute({
        viewer,
        courseId: s.course.id,
        sort: 'recent',
        limit: 2,
        ...extra,
      });
    const page1 = QuestionPageSchema.parse(await list(s.student(s.alice)));
    expect(page1.items.map((q) => q.id)).toEqual([q1.id, q3.id]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await list(s.student(s.alice), { cursor: page1.nextCursor });
    expect(page2.items.map((q) => q.id)).toEqual([q2.id]);
    expect(page2.nextCursor).toBeNull();

    const top = await list(s.student(s.alice), { sort: 'top', limit: 1 });
    expect(top.items.map((q) => [q.id, q.upvoteCount, q.voted])).toEqual([[q3.id, 1, false]]);
    const topForBob = await list(s.student(s.bob), { sort: 'top', limit: 1 });
    expect(topForBob.items[0]?.voted).toBe(true);
    const unanswered = await list(s.student(s.alice), { sort: 'unanswered', limit: 10 });
    expect(unanswered.items.map((q) => q.id)).toEqual([q3.id, q2.id]);
    const byLecture = await list(s.student(s.alice), { lectureId: s.lectureId, limit: 10 });
    expect(byLecture.items.map((q) => q.id)).toEqual([q1.id]);
    const search = await list(s.student(s.alice), { q: 'scope', limit: 10 });
    expect(search.items.map((q) => q.id).sort()).toEqual([q1.id, q3.id].sort());
    // hidden content never lists, not even for its author
    const forBob = await list(s.student(s.bob), { limit: 10 });
    expect(forBob.items.map((q) => q.id)).not.toContain(hidden.id);

    // a cursor of another sort is refused (422)
    await expect(
      list(s.student(s.alice), { sort: 'top', cursor: page1.nextCursor }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(list(s.student(s.outsider))).rejects.toBeInstanceOf(EnrollmentRequired);
  });

  it('detail: hidden only for its author; a deleted question is a placeholder while it has answers', async () => {
    const s = setup();
    const hidden = s.h.qa.seedQuestion({
      courseId: s.course.id,
      authorId: s.alice,
      moderationStatus: 'HIDDEN',
    });
    const get = (viewer: QaViewer, questionId: string, courseId = s.course.id) =>
      s.h.getQuestion.execute({ viewer, courseId, questionId, limit: 20 });

    expect((await get(s.student(s.alice), hidden.id)).hidden).toBe(true);
    await expect(get(s.student(s.bob), hidden.id)).rejects.toBeInstanceOf(QuestionNotFound);
    await expect(get(s.instructor(s.owner), hidden.id)).rejects.toBeInstanceOf(QuestionNotFound);

    const q = await ask(s, s.student(s.alice));
    const answer = s.h.qa.seedAnswer(q.id, s.bob);
    await s.h.deleteQuestion.execute({
      viewer: s.student(s.alice),
      courseId: s.course.id,
      questionId: q.id,
    });
    const placeholder = QuestionDetailSchema.parse(await get(s.student(s.bob), q.id));
    expect(placeholder).toMatchObject({
      deleted: true,
      title: null,
      bodyMd: null,
      author: null,
      answerCount: 1,
    });
    expect(placeholder.answers.items.map((a) => a.id)).toEqual([answer.id]);

    const lonely = await ask(s, s.student(s.alice), 'Nobody answers this');
    await s.h.deleteQuestion.execute({
      viewer: s.student(s.alice),
      courseId: s.course.id,
      questionId: lonely.id,
    });
    await expect(get(s.student(s.alice), lonely.id)).rejects.toBeInstanceOf(QuestionNotFound);

    // IDOR: the question through another course's path
    const other = s.h.catalog.add(s.owner);
    s.h.enrollment.enroll(s.alice, other.id);
    await expect(get(s.student(s.alice), hidden.id, other.id)).rejects.toBeInstanceOf(
      QuestionNotFound,
    );
  });
});

describe('Answers, votes, accepted answers', () => {
  it('posts (AnswerPosted with byCourseOwner), lists oldest first, refuses hidden or deleted questions', async () => {
    const s = setup();
    const q = await ask(s, s.student(s.alice));
    const first = AnswerSchema.parse(
      await s.h.postAnswer.execute({
        viewer: s.student(s.bob),
        courseId: s.course.id,
        questionId: q.id,
        bodyMd: 'Try this.',
      }),
    );
    const second = await s.h.postAnswer.execute({
      viewer: s.instructor(s.owner),
      courseId: s.course.id,
      questionId: q.id,
      bodyMd: 'Official answer.',
    });
    expect(first).toMatchObject({ mine: true, byInstructor: false, accepted: false });
    expect(second.byInstructor).toBe(true);
    const answered = s.h.events.events.filter((e) => e.type === 'AnswerPosted');
    expect(answered.map((e) => e.payload)).toEqual([
      expect.objectContaining({ questionAuthorId: s.alice, byCourseOwner: false }),
      expect.objectContaining({ questionAuthorId: s.alice, byCourseOwner: true }),
    ]);
    expect(s.h.qa.locks).toContain(`question:${q.id}`);

    const page = AnswerPageSchema.parse(
      await s.h.listAnswers.execute({
        viewer: s.student(s.alice),
        courseId: s.course.id,
        questionId: q.id,
        limit: 1,
      }),
    );
    expect(page.items.map((a) => a.id)).toEqual([first.id]);
    const next = await s.h.listAnswers.execute({
      viewer: s.student(s.alice),
      courseId: s.course.id,
      questionId: q.id,
      cursor: page.nextCursor ?? undefined,
      limit: 1,
    });
    expect(next.items.map((a) => a.id)).toEqual([second.id]);

    s.h.qa.setStatus('QUESTION', q.id, 'HIDDEN');
    await expect(
      s.h.postAnswer.execute({
        viewer: s.student(s.alice),
        courseId: s.course.id,
        questionId: q.id,
        bodyMd: 'Hidden now',
      }),
    ).rejects.toBeInstanceOf(QuestionNotFound);
  });

  it('only the author edits or deletes; deleting the accepted answer reopens the question', async () => {
    const s = setup();
    const q = await ask(s, s.student(s.alice));
    const answer = await s.h.postAnswer.execute({
      viewer: s.student(s.bob),
      courseId: s.course.id,
      questionId: q.id,
      bodyMd: 'v1',
    });
    await expect(
      s.h.editAnswer.execute({
        viewer: s.student(s.alice),
        courseId: s.course.id,
        answerId: answer.id,
        bodyMd: 'hijack',
      }),
    ).rejects.toBeInstanceOf(NotContentAuthor);
    await expect(
      s.h.editQuestion.execute({
        viewer: s.student(s.bob),
        courseId: s.course.id,
        questionId: q.id,
        title: 'Not mine to edit',
      }),
    ).rejects.toBeInstanceOf(NotContentAuthor);
    const edited = await s.h.editAnswer.execute({
      viewer: s.student(s.bob),
      courseId: s.course.id,
      answerId: answer.id,
      bodyMd: 'v2',
    });
    expect(edited.bodyMd).toBe('v2');
    expect(edited.editedAt).not.toBeNull();

    await s.h.setAccepted.execute({
      viewer: s.student(s.alice),
      courseId: s.course.id,
      questionId: q.id,
      answerId: answer.id,
    });
    await s.h.deleteAnswer.execute({
      viewer: s.student(s.bob),
      courseId: s.course.id,
      answerId: answer.id,
    });
    expect(s.h.events.types().slice(-3)).toEqual([
      'QuestionResolved',
      'AnswerDeleted',
      'QuestionReopened',
    ]);
    expect(s.h.events.events.at(-1)?.payload).toMatchObject({
      questionId: q.id,
      answerId: answer.id,
      actorId: s.bob,
    });
    const after = await s.h.qa.findQuestion(q.id);
    expect(after).toMatchObject({ acceptedAnswerId: null, answerCount: 0 });
    await expect(
      s.h.deleteAnswer.execute({
        viewer: s.student(s.bob),
        courseId: s.course.id,
        answerId: answer.id,
      }),
    ).rejects.toBeInstanceOf(AnswerNotFound);
  });

  it('votes: idempotent, never on own content, retractable', async () => {
    const s = setup();
    const q = await ask(s, s.student(s.alice));
    const vote = (viewer: QaViewer, on: boolean) =>
      s.h.vote.execute({ viewer, courseId: s.course.id, subject: 'QUESTION', subjectId: q.id, on });
    await vote(s.student(s.bob), true);
    await vote(s.student(s.bob), true);
    expect((await s.h.qa.findQuestion(q.id))?.upvoteCount).toBe(1);
    await expect(vote(s.student(s.alice), true)).rejects.toBeInstanceOf(CannotVoteOwnContent);
    await vote(s.student(s.bob), false);
    await vote(s.student(s.bob), false);
    expect((await s.h.qa.findQuestion(q.id))?.upvoteCount).toBe(0);
    expect(s.h.rateLimiter.hits.filter((x) => x.rule === 'vote')).toHaveLength(3);
  });

  it('accept: question author or owner; the answer must belong to the question; repeat is a no-op', async () => {
    const s = setup();
    const q = await ask(s, s.student(s.alice));
    const other = await ask(s, s.student(s.alice), 'Another question');
    const a = s.h.qa.seedAnswer(q.id, s.bob);
    const foreign = s.h.qa.seedAnswer(other.id, s.bob);
    const accept = (viewer: QaViewer, answerId: string | null) =>
      s.h.setAccepted.execute({ viewer, courseId: s.course.id, questionId: q.id, answerId });

    await expect(accept(s.student(s.bob), a.id)).rejects.toBeInstanceOf(NotContentAuthor);
    await expect(accept(s.student(s.alice), foreign.id)).rejects.toBeInstanceOf(AnswerNotFound);
    const resolved = await accept(s.instructor(s.owner), a.id);
    expect(resolved).toMatchObject({ resolved: true, acceptedAnswerId: a.id });
    const again = await accept(s.student(s.alice), a.id);
    expect(again.acceptedAnswerId).toBe(a.id);
    const reopened = await accept(s.student(s.alice), null);
    expect(reopened.resolved).toBe(false);
    expect(s.h.events.types().filter((t) => t.startsWith('Question'))).toEqual([
      'QuestionPosted',
      'QuestionPosted',
      'QuestionResolved',
      'QuestionReopened',
    ]);
    const detail = await s.h.getQuestion.execute({
      viewer: s.student(s.alice),
      courseId: s.course.id,
      questionId: q.id,
      limit: 20,
    });
    expect(detail.answers.items[0]?.accepted).toBe(false);
  });
});

describe('InstructorQaInbox', () => {
  it('across owned courses, by status; a foreign courseId is 404; lecture titles from the live revision', async () => {
    const s = setup();
    const second = s.h.catalog.add(s.owner);
    s.h.enrollment.enroll(s.alice, second.id);
    const foreign = s.h.catalog.add(s.h.users.add('Other owner'));
    const q1 = await ask(s, s.student(s.alice), 'Lecture question', s.lectureId);
    const q2 = await s.h.askQuestion.execute({
      viewer: s.student(s.alice),
      courseId: second.id,
      lectureId: null,
      title: 'Second course question',
      bodyMd: 'x',
    });
    const answered = await ask(s, s.student(s.bob), 'Answered one');
    s.h.qa.seedAnswer(answered.id, s.owner);

    const inbox = (extra: object = {}) =>
      s.h.inbox.execute({ ownerId: s.owner, status: 'unanswered', limit: 20, ...extra });
    const page = InstructorQaPageSchema.parse(await inbox());
    expect(page.items.map((i) => i.question.id)).toEqual([q2.id, q1.id]);
    expect(page.items[1]).toMatchObject({
      course: { id: s.course.id, slug: s.course.slug },
      lectureTitle: 'Intro',
    });
    expect((await inbox({ status: 'all' })).items).toHaveLength(3);
    expect((await inbox({ courseId: second.id })).items.map((i) => i.question.id)).toEqual([q2.id]);
    await expect(inbox({ courseId: foreign.id })).rejects.toBeInstanceOf(CourseNotFound);
    const none = await s.h.inbox.execute({
      ownerId: s.h.users.add('No courses'),
      status: 'all',
      limit: 20,
    });
    expect(none).toEqual({ items: [], nextCursor: null });
  });
});

describe('Reports on Q&A (D13)', () => {
  it('three reporters auto-hide a question: QuestionHidden (actor null) and a hint', async () => {
    const s = setup();
    const carol = s.h.users.add('Carol');
    s.h.enrollment.enroll(carol, s.course.id);
    const q = await ask(s, s.student(s.alice));
    const report = (userId: string) =>
      s.h.reportContent.execute({
        subjectType: 'QUESTION',
        routeId: q.id,
        reporterId: userId,
        reason: 'SPAM',
        comment: null,
      });
    await expect(report(s.outsider)).rejects.toBeInstanceOf(QuestionNotFound);
    ReportSchema.parse((await report(s.bob)).report);
    await report(carol);
    const third = await report(s.owner);
    expect(third.report).toMatchObject({
      subjectType: 'QUESTION',
      subjectId: q.id,
      status: 'ACTIONED',
    });
    expect(s.h.events.events.at(-1)).toMatchObject({
      type: 'QuestionHidden',
      payload: { questionId: q.id, actorId: null },
    });
    expect(s.h.hints.hints.at(-1)).toMatchObject({ questionId: q.id });
  });

  it('auto-hiding the accepted answer emits AnswerHidden then QuestionReopened', async () => {
    const s = setup(createQaHarness({ autoHideReports: 1 }));
    const q = await ask(s, s.student(s.alice));
    const a = s.h.qa.seedAnswer(q.id, s.bob);
    await s.h.setAccepted.execute({
      viewer: s.student(s.alice),
      courseId: s.course.id,
      questionId: q.id,
      answerId: a.id,
    });
    await s.h.reportContent.execute({
      subjectType: 'ANSWER',
      routeId: a.id,
      reporterId: s.alice,
      reason: 'ABUSE',
      comment: null,
    });
    expect(s.h.events.types().slice(-2)).toEqual(['AnswerHidden', 'QuestionReopened']);
    expect(s.h.events.events.at(-1)?.payload).toMatchObject({ answerId: a.id, actorId: null });
    expect(s.h.qa.locks.slice(-2)).toEqual([`answer:${a.id}`, `question:${q.id}`]);
    expect((await s.h.qa.findQuestion(q.id))?.acceptedAnswerId).toBeNull();
  });
});

describe('Announcements (D18, quota R12)', () => {
  it('4 per course per 30 days (deleted ones count); the 5th is 422 with retryAt; the window frees it', async () => {
    const s = setup();
    const post = (title = 'Welcome to the course') =>
      s.h.postAnnouncement.execute({
        actorId: s.owner,
        courseId: s.course.id,
        title,
        bodyMd: 'Hello **everyone**',
        sendEmail: true,
      });
    const first = AnnouncementSchema.parse(await post());
    expect(first).toMatchObject({ sendEmail: true, author: { id: s.owner } });
    await post();
    await post();
    await post();
    await s.h.deleteAnnouncement.execute({
      actorId: s.owner,
      courseId: s.course.id,
      announcementId: first.id,
    });
    const refused = await post().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AnnouncementLimitExceeded);
    expect((refused as AnnouncementLimitExceeded).retryAt.getTime()).toBe(
      Date.parse(first.createdAt) + 30 * DAY_MS,
    );
    expect(s.h.announcements.lockedCourses.length).toBe(5);

    const page = InstructorAnnouncementPageSchema.parse(
      await s.h.listCourseAnnouncements.execute({ courseId: s.course.id, limit: 2 }),
    );
    expect(page.items).toHaveLength(2);
    expect(page.quota).toMatchObject({ limit: 4, used: 4, windowDays: 30 });
    expect(page.quota.nextAvailableAt).toBe(
      new Date(Date.parse(first.createdAt) + 30 * DAY_MS).toISOString(),
    );

    s.h.clock.advance(30 * DAY_MS);
    await post('Back after a month');
    expect(s.h.events.types().filter((t) => t.startsWith('Announcement'))).toEqual([
      'AnnouncementPosted',
      'AnnouncementPosted',
      'AnnouncementPosted',
      'AnnouncementPosted',
      'AnnouncementDeleted',
      'AnnouncementPosted',
    ]);
  });

  it('learners (and the owner) read; outsiders 403; delete is IDOR-safe and 404 the second time; markdown checked', async () => {
    const s = setup();
    const a = await s.h.postAnnouncement.execute({
      actorId: s.owner,
      courseId: s.course.id,
      title: 'Exam next week',
      bodyMd: 'Prepare.',
      sendEmail: false,
    });
    const read = (viewer: QaViewer) =>
      s.h.listAnnouncements.execute({ viewer, courseId: s.course.id, limit: 20 });
    expect(
      AnnouncementPageSchema.parse(await read(s.student(s.alice))).items.map((x) => x.id),
    ).toEqual([a.id]);
    expect((await read(s.student(s.owner))).items).toHaveLength(1);
    await expect(read(s.student(s.outsider))).rejects.toBeInstanceOf(EnrollmentRequired);

    const other = s.h.catalog.add(s.owner);
    await expect(
      s.h.deleteAnnouncement.execute({
        actorId: s.owner,
        courseId: other.id,
        announcementId: a.id,
      }),
    ).rejects.toBeInstanceOf(AnnouncementNotFound);
    await s.h.deleteAnnouncement.execute({
      actorId: s.owner,
      courseId: s.course.id,
      announcementId: a.id,
    });
    await expect(
      s.h.deleteAnnouncement.execute({
        actorId: s.owner,
        courseId: s.course.id,
        announcementId: a.id,
      }),
    ).rejects.toBeInstanceOf(AnnouncementNotFound);
    expect(s.h.events.events.at(-1)).toMatchObject({
      type: 'AnnouncementDeleted',
      payload: { announcementId: a.id, authorId: s.owner, actorId: s.owner, sendEmail: false },
    });
    await expect(
      s.h.postAnnouncement.execute({
        actorId: s.owner,
        courseId: s.course.id,
        title: 'Look at this',
        bodyMd: '![img](https://example.com/x.png)',
        sendEmail: false,
      }),
    ).rejects.toBeInstanceOf(MarkdownNotAllowed);
    await expect(
      s.h.postAnnouncement.execute({
        actorId: s.owner,
        courseId: randomUUID(),
        title: 'Unknown course',
        bodyMd: 'x',
        sendEmail: false,
      }),
    ).rejects.toBeInstanceOf(CourseNotFound);
  });
});

describe('Admin moderation (D13)', () => {
  it('queue: one item per subject, newest report first; review replies under their REVIEW id', async () => {
    const s = setup();
    const reviewId = s.h.reviews.seed({ courseId: s.course.id, userId: s.alice });
    const replyId = s.h.reviews.seedReply(reviewId, s.owner);
    const q = await ask(s, s.student(s.alice));
    await s.h.reportContent.execute({
      subjectType: 'REVIEW_REPLY',
      routeId: reviewId,
      reporterId: s.bob,
      reason: 'HARASSMENT',
      comment: 'Rude',
    });
    await s.h.reportContent.execute({
      subjectType: 'QUESTION',
      routeId: q.id,
      reporterId: s.bob,
      reason: 'SPAM',
      comment: null,
    });

    const page = ModerationQueuePageSchema.parse(
      await s.h.moderationQueue.execute({ status: 'OPEN', limit: 1 }),
    );
    expect(page.items.map((i) => [i.subjectType, i.subjectId])).toEqual([['QUESTION', q.id]]);
    const next = await s.h.moderationQueue.execute({
      status: 'OPEN',
      limit: 1,
      cursor: page.nextCursor ?? undefined,
    });
    const reply = next.items[0];
    expect(reply).toMatchObject({
      subjectType: 'REVIEW_REPLY',
      subjectId: reviewId,
      courseId: s.course.id,
      courseTitle: s.course.title,
      moderationStatus: 'VISIBLE',
      openReportCount: 1,
      preview: { bodyIsMarkdown: false, author: { id: s.owner }, deleted: false },
    });
    expect(reply?.reports.map((r) => [r.subjectId, r.reporter?.id, r.comment])).toEqual([
      [reviewId, s.bob, 'Rude'],
    ]);
    expect(replyId).not.toBe(reviewId);
    expect(
      (await s.h.moderationQueue.execute({ status: 'OPEN', type: 'QUESTION', limit: 10 })).items,
    ).toHaveLength(1);
  });

  it('hide -> restore -> 409s; dismiss needs open reports; events carry the admin; Q&A hints', async () => {
    const s = setup();
    const admin = s.h.users.add('Admin');
    const q = await ask(s, s.student(s.alice));
    const act = (action: 'hide' | 'restore' | 'dismiss-reports', routeId = q.id) =>
      s.h.moderate.execute({
        actorId: admin,
        subjectType: 'QUESTION',
        routeId,
        action,
        reason: 'Violates the community rules',
      });
    await s.h.reportContent.execute({
      subjectType: 'QUESTION',
      routeId: q.id,
      reporterId: s.bob,
      reason: 'SPAM',
      comment: null,
    });
    const hidden = ModerationSubjectSchema.parse(await act('hide'));
    expect(hidden).toMatchObject({
      moderationStatus: 'HIDDEN',
      openReportCount: 0,
      subjectId: q.id,
    });
    expect(hidden.actions.map((a) => [a.action, a.actor?.id, a.reason])).toEqual([
      ['HIDE', admin, 'Violates the community rules'],
    ]);
    await expect(act('hide')).rejects.toBeInstanceOf(InvalidModerationTransition);
    await expect(act('dismiss-reports')).rejects.toBeInstanceOf(InvalidModerationTransition);
    const restored = await act('restore');
    expect(restored.moderationStatus).toBe('VISIBLE');
    await expect(act('restore')).rejects.toBeInstanceOf(InvalidModerationTransition);
    await expect(act('hide', randomUUID())).rejects.toBeInstanceOf(QuestionNotFound);
    expect(s.h.events.types().slice(-2)).toEqual(['QuestionHidden', 'QuestionRestored']);
    expect(s.h.events.events.at(-1)?.payload).toMatchObject({ actorId: admin });
    expect(s.h.hints.hints.filter((x) => x.questionId === q.id)).toHaveLength(3);
  });

  it('hiding the accepted answer reopens the question; replies by review id; dismiss on deleted content', async () => {
    const s = setup();
    const admin = s.h.users.add('Admin');
    const q = await ask(s, s.student(s.alice));
    const a = s.h.qa.seedAnswer(q.id, s.bob);
    await s.h.setAccepted.execute({
      viewer: s.student(s.alice),
      courseId: s.course.id,
      questionId: q.id,
      answerId: a.id,
    });
    await s.h.moderate.execute({
      actorId: admin,
      subjectType: 'ANSWER',
      routeId: a.id,
      action: 'hide',
      reason: 'Off-topic and abusive',
    });
    expect(s.h.events.types().slice(-2)).toEqual(['AnswerHidden', 'QuestionReopened']);
    expect(s.h.events.events.at(-1)?.payload).toMatchObject({ actorId: admin, answerId: a.id });

    const reviewId = s.h.reviews.seed({ courseId: s.course.id, userId: s.alice });
    s.h.reviews.seedReply(reviewId, s.owner);
    const replyHidden = await s.h.moderate.execute({
      actorId: admin,
      subjectType: 'REVIEW_REPLY',
      routeId: reviewId,
      action: 'hide',
      reason: 'Insulting the student',
    });
    expect(replyHidden).toMatchObject({ subjectType: 'REVIEW_REPLY', subjectId: reviewId });
    expect(s.h.events.events.at(-1)).toMatchObject({
      type: 'ReviewReplyHidden',
      payload: { reviewId, authorId: s.owner, actorId: admin },
    });
    await expect(
      s.h.moderate.execute({
        actorId: admin,
        subjectType: 'REVIEW_REPLY',
        routeId: randomUUID(),
        action: 'hide',
        reason: 'No such reply here',
      }),
    ).rejects.toBeInstanceOf(ReplyNotFound);

    // reported, then deleted by its author: hide is 409, the reports can still be dismissed
    const doomed = await ask(s, s.student(s.alice), 'Soon deleted');
    await s.h.reportContent.execute({
      subjectType: 'QUESTION',
      routeId: doomed.id,
      reporterId: s.bob,
      reason: 'SPAM',
      comment: null,
    });
    await s.h.deleteQuestion.execute({
      viewer: s.student(s.alice),
      courseId: s.course.id,
      questionId: doomed.id,
    });
    const act = (action: 'hide' | 'dismiss-reports') =>
      s.h.moderate.execute({
        actorId: admin,
        subjectType: 'QUESTION',
        routeId: doomed.id,
        action,
        reason: 'Clearing the queue entry',
      });
    await expect(act('hide')).rejects.toBeInstanceOf(InvalidModerationTransition);
    expect(await act('dismiss-reports')).toMatchObject({ openReportCount: 0 });
  });
});
