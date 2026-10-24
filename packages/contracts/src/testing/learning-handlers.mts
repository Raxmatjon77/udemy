import type { HttpHandler } from 'msw';
import { z } from 'zod';
import {
  CourseIdParamsSchema,
  LectureParamsSchema,
  RevisionLectureParamsSchema,
} from '../http/catalog.js';
import {
  AnnouncementPageSchema,
  AnnouncementParamsSchema,
  AnnouncementSchema,
  AnnouncementsQuerySchema,
  InstructorAnnouncementPageSchema,
  PostAnnouncementRequestSchema,
  WishlistPageSchema,
  WishlistQuerySchema,
  WishlistStatesQuerySchema,
  WishlistStatesResponseSchema,
} from '../http/engagement-community.js';
import {
  ModerationQueuePageSchema,
  ModerationQueueQuerySchema,
  ModerationReasonRequestSchema,
  ModerationSubjectSchema,
  ReportContentRequestSchema,
  ReportSchema,
  ReportSubjectParamsSchema,
  reportSubjectTypeOfPath,
  REPORT_SUBJECT_PATHS,
  REPORT_SUBJECT_TYPES,
} from '../http/engagement-moderation.js';
import {
  AcceptAnswerRequestSchema,
  AnswerPageSchema,
  AnswerParamsSchema,
  AnswerSchema,
  AnswersQuerySchema,
  AskQuestionRequestSchema,
  EditAnswerRequestSchema,
  EditQuestionRequestSchema,
  InstructorQaPageSchema,
  InstructorQaQuerySchema,
  PostAnswerRequestSchema,
  QuestionDetailSchema,
  QuestionPageSchema,
  QuestionParamsSchema,
  QuestionSchema,
  QuestionsQuerySchema,
} from '../http/engagement-qa.js';
import {
  CourseReviewParamsSchema,
  InstructorReviewPageSchema,
  InstructorReviewsQuerySchema,
  MyCourseReviewSchema,
  MyReviewSchema,
  PUBLIC_ENGAGEMENT_CACHE_CONTROL,
  PublicReviewPageSchema,
  PublicReviewsQuerySchema,
  RatingsQuerySchema,
  RatingsResponseSchema,
  ReviewReplySchema,
  UpsertReviewReplyRequestSchema,
  UpsertReviewRequestSchema,
} from '../http/engagement-reviews.js';
import {
  AdminCertificateReasonRequestSchema,
  AdminCertificateSchema,
  AdminUserCertificatesSchema,
  CertificateCodeParamsSchema,
  CertificateIdParamsSchema,
  CertificatePageSchema,
  CertificateSchema,
  CERTIFICATE_VERIFICATION_CACHE_CONTROL,
  CertificateVerificationSchema,
  CompleteLectureRequestSchema,
  CompletionStateSchema,
  CreateNoteRequestSchema,
  MyCertificatesQuerySchema,
  NoteIdParamsSchema,
  NotePageSchema,
  NoteSchema,
  NotesQuerySchema,
  PlayerBootstrapSchema,
  ProgressAckSchema,
  QuizAttemptDetailSchema,
  QuizAttemptIdParamsSchema,
  QuizAttemptPageSchema,
  QuizAttemptSchema,
  QuizAttemptsQuerySchema,
  RecordHeartbeatRequestSchema,
  SubmitQuizAttemptRequestSchema,
  SubmitQuizAttemptResponseSchema,
  UpdateNoteRequestSchema,
} from '../http/learning.js';
import { SignedUrlSchema } from '../http/media.js';
import { UserIdParamsSchema } from '../http/me.js';
import {
  MarkAllReadRequestSchema,
  NotificationIdParamsSchema,
  NotificationPageSchema,
  NotificationPreferencesSchema,
  NotificationsQuerySchema,
  UnreadCountSchema,
  UnsubscribeRequestSchema,
  UpdateNotificationPreferencesRequestSchema,
} from '../http/notifications.js';
import {
  CreateQuizQuestionRequestSchema,
  PutQuizQuestionOptionsRequestSchema,
  QuizAuthoringSchema,
  QuizQuestionAuthoringSchema,
  QuizQuestionParamsSchema,
  ReorderQuizQuestionsRequestSchema,
  RevisionQuizSchema,
  UpdateQuizQuestionRequestSchema,
  UpdateQuizSettingsRequestSchema,
} from '../http/quiz.js';
import { RealtimeTicketSchema } from '../realtime.js';
import {
  BadRequest,
  bodyOf,
  check,
  noContent,
  paginate,
  queryOf,
  reply,
  routeFactory,
} from './handler-kit.mjs';
import { createLearningMockStore, type LearningMockStore } from './learning-mock-store.mjs';

export interface LearningHandlersOptions {
  /** Prefix of every route without a trailing slash (`'*\/api/proxy'` or `'http://api.test/api/v1'`). */
  baseUrl: string;
  /** Shared state; a fresh default store when omitted. */
  store?: LearningMockStore;
}

export interface LearningHandlers {
  handlers: HttpHandler[];
  store: LearningMockStore;
}

const ModerationActionParamsSchema = ReportSubjectParamsSchema.extend({
  type: z.string(),
  action: z.enum(['hide', 'restore', 'dismiss-reports']),
});
const CertificateActionParamsSchema = CertificateIdParamsSchema.extend({
  action: z.enum(['revoke', 'reinstate']),
});

/**
 * MSW handlers for every Phase 5 route of the learning experience design §8 (learning,
 * engagement, notifications, the realtime ticket, quiz authoring and the admin routes). Combine
 * them with the Phase 4 handlers over one commerce store:
 *
 * ```ts
 * const commerce = createCommerceHandlers({ baseUrl });
 * const learning = createLearningHandlers({
 *   baseUrl,
 *   store: createLearningMockStore({ commerce: commerce.store }),
 * });
 * const server = setupServer(...commerce.handlers, ...learning.handlers);
 * ```
 *
 * Requests are validated with the contracts schemas (400 `validation_failed`), and every
 * response is parsed with its response schema before it is sent: an attempt or a quiz served to a
 * learner can never carry a key, because the schema has no field for it.
 */
export function createLearningHandlers(options: LearningHandlersOptions): LearningHandlers {
  const store = options.store ?? createLearningMockStore();
  const route = routeFactory(options.baseUrl);
  const publicCache = { headers: { 'cache-control': PUBLIC_ENGAGEMENT_CACHE_CONTROL } };

  const reportRoutes = REPORT_SUBJECT_TYPES.map((type) =>
    route('post', `/engagement/${REPORT_SUBJECT_PATHS[type]}/:subjectId/reports`, async (args) => {
      const { subjectId } = check(ReportSubjectParamsSchema, args.params);
      const body = check(ReportContentRequestSchema, await bodyOf(args.request));
      const { status, report } = store.report(type, subjectId, body);
      return reply(ReportSchema, report, { status });
    }),
  );

  const handlers: HttpHandler[] = [
    /* ------------------------------------------------------------ public */
    route('get', '/engagement/ratings', ({ request }) => {
      const { courseIds } = check(RatingsQuerySchema, queryOf(request));
      return reply(RatingsResponseSchema, { items: store.ratings(courseIds) }, publicCache);
    }),
    route('get', '/engagement/courses/:courseId/reviews', ({ request, params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      const query = check(PublicReviewsQuerySchema, queryOf(request));
      return reply(
        PublicReviewPageSchema,
        paginate(store.publicReviews(courseId, query.rating), query),
        publicCache,
      );
    }),
    route('get', '/certificates/:code', ({ params }) => {
      const { code } = check(CertificateCodeParamsSchema, params);
      return reply(CertificateVerificationSchema, store.verifyCertificate(code), {
        headers: { 'cache-control': CERTIFICATE_VERIFICATION_CACHE_CONTROL },
      });
    }),
    route('get', '/certificates/:code/pdf', ({ params }) => {
      const { code } = check(CertificateCodeParamsSchema, params);
      return reply(SignedUrlSchema, store.publicCertificatePdf(code));
    }),
    route('post', '/notifications/unsubscribe', async ({ request }) => {
      const { token } = check(UnsubscribeRequestSchema, await bodyOf(request));
      store.unsubscribe(token);
      return noContent();
    }),

    /* ------------------------------------------------------------ learning */
    route('get', '/me/courses/:courseId/learn', ({ params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      return reply(PlayerBootstrapSchema, store.playerBootstrap(courseId));
    }),
    route(
      'put',
      '/me/courses/:courseId/lectures/:lectureId/progress',
      async ({ request, params }) => {
        const { courseId, lectureId } = check(LectureParamsSchema, params);
        const body = check(RecordHeartbeatRequestSchema, await bodyOf(request));
        return reply(ProgressAckSchema, store.recordHeartbeat(courseId, lectureId, body));
      },
    ),
    route(
      'post',
      '/me/courses/:courseId/lectures/:lectureId/completion',
      async ({ request, params }) => {
        const { courseId, lectureId } = check(LectureParamsSchema, params);
        const { cause } = check(CompleteLectureRequestSchema, await bodyOf(request));
        return reply(CompletionStateSchema, store.completeLecture(courseId, lectureId, cause));
      },
    ),
    route('delete', '/me/courses/:courseId/lectures/:lectureId/completion', ({ params }) => {
      const { courseId, lectureId } = check(LectureParamsSchema, params);
      return reply(CompletionStateSchema, store.uncompleteLecture(courseId, lectureId));
    }),
    route('get', '/me/courses/:courseId/notes', ({ request, params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      const query = check(NotesQuerySchema, queryOf(request));
      return reply(NotePageSchema, paginate(store.listNotes(courseId, query.lectureId), query));
    }),
    route('post', '/me/courses/:courseId/notes', async ({ request, params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      const body = check(CreateNoteRequestSchema, await bodyOf(request));
      return reply(NoteSchema, store.createNote(courseId, body), { status: 201 });
    }),
    route('patch', '/me/notes/:noteId', async ({ request, params }) => {
      const { noteId } = check(NoteIdParamsSchema, params);
      const body = check(UpdateNoteRequestSchema, await bodyOf(request));
      return reply(NoteSchema, store.updateNote(noteId, body));
    }),
    route('delete', '/me/notes/:noteId', ({ params }) => {
      const { noteId } = check(NoteIdParamsSchema, params);
      store.deleteNote(noteId);
      return noContent();
    }),
    route('post', '/me/courses/:courseId/lectures/:lectureId/quiz-attempts', ({ params }) => {
      const { courseId, lectureId } = check(LectureParamsSchema, params);
      const { status, attempt } = store.startQuizAttempt(courseId, lectureId);
      return reply(QuizAttemptSchema, attempt, { status });
    }),
    route(
      'get',
      '/me/courses/:courseId/lectures/:lectureId/quiz-attempts',
      ({ request, params }) => {
        const { courseId, lectureId } = check(LectureParamsSchema, params);
        const query = check(QuizAttemptsQuerySchema, queryOf(request));
        return reply(
          QuizAttemptPageSchema,
          paginate(store.listQuizAttempts(courseId, lectureId), query),
        );
      },
    ),
    route('get', '/me/quiz-attempts/:attemptId', ({ params }) => {
      const { attemptId } = check(QuizAttemptIdParamsSchema, params);
      return reply(QuizAttemptDetailSchema, store.getQuizAttempt(attemptId));
    }),
    route('post', '/me/quiz-attempts/:attemptId/submit', async ({ request, params }) => {
      const { attemptId } = check(QuizAttemptIdParamsSchema, params);
      const { answers } = check(SubmitQuizAttemptRequestSchema, await bodyOf(request));
      return reply(SubmitQuizAttemptResponseSchema, store.submitQuizAttempt(attemptId, answers));
    }),
    route('get', '/me/certificates', ({ request }) => {
      const query = check(MyCertificatesQuerySchema, queryOf(request));
      return reply(CertificatePageSchema, paginate(store.myCertificates(), query));
    }),
    route('get', '/me/certificates/:certificateId', ({ params }) => {
      const { certificateId } = check(CertificateIdParamsSchema, params);
      return reply(CertificateSchema, store.myCertificate(certificateId));
    }),
    route('get', '/me/certificates/:certificateId/pdf', ({ params }) => {
      const { certificateId } = check(CertificateIdParamsSchema, params);
      return reply(SignedUrlSchema, store.myCertificatePdf(certificateId));
    }),
    route('get', '/me/courses/:courseId/announcements', ({ request, params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      const query = check(AnnouncementsQuerySchema, queryOf(request));
      return reply(AnnouncementPageSchema, paginate(store.learnerAnnouncements(courseId), query));
    }),

    /* ------------------------------------------------------------ reviews (student) */
    route('get', '/me/courses/:courseId/review', ({ params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      return reply(MyCourseReviewSchema, store.myCourseReview(courseId));
    }),
    route('put', '/me/courses/:courseId/review', async ({ request, params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      const body = check(UpsertReviewRequestSchema, await bodyOf(request));
      const { status, review } = store.upsertMyReview(courseId, body);
      return reply(MyReviewSchema, review, { status });
    }),
    route('delete', '/me/courses/:courseId/review', ({ params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      store.deleteMyReview(courseId);
      return noContent();
    }),

    /* ------------------------------------------------------------ wishlist (registered before /:courseId) */
    route('get', '/me/wishlist/states', ({ request }) => {
      const { courseIds } = check(WishlistStatesQuerySchema, queryOf(request));
      return reply(WishlistStatesResponseSchema, { items: store.wishlistStates(courseIds) });
    }),
    route('get', '/me/wishlist', ({ request }) => {
      const query = check(WishlistQuerySchema, queryOf(request));
      return reply(WishlistPageSchema, paginate(store.wishlist(), query));
    }),
    route('put', '/me/wishlist/:courseId', ({ params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      store.addToWishlist(courseId);
      return noContent();
    }),
    route('delete', '/me/wishlist/:courseId', ({ params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      store.removeFromWishlist(courseId);
      return noContent();
    }),

    /* ------------------------------------------------------------ reports */
    ...reportRoutes,

    /* ------------------------------------------------------------ Q&A (student + instructor) */
    route('get', '/courses/:courseId/questions', ({ request, params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      const query = check(QuestionsQuerySchema, queryOf(request));
      return reply(QuestionPageSchema, paginate(store.listQuestions(courseId, query), query));
    }),
    route('post', '/courses/:courseId/questions', async ({ request, params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      const body = check(AskQuestionRequestSchema, await bodyOf(request));
      return reply(QuestionSchema, store.askQuestion(courseId, body), { status: 201 });
    }),
    route('get', '/courses/:courseId/questions/:questionId', ({ request, params }) => {
      const { courseId, questionId } = check(QuestionParamsSchema, params);
      const query = check(AnswersQuerySchema, queryOf(request));
      const question = store.question(courseId, questionId);
      const answers = paginate(store.listAnswers(courseId, questionId), query);
      return reply(QuestionDetailSchema, { ...question, answers });
    }),
    route('patch', '/courses/:courseId/questions/:questionId', async ({ request, params }) => {
      const { courseId, questionId } = check(QuestionParamsSchema, params);
      const body = check(EditQuestionRequestSchema, await bodyOf(request));
      return reply(QuestionSchema, store.editQuestion(courseId, questionId, body));
    }),
    route('delete', '/courses/:courseId/questions/:questionId', ({ params }) => {
      const { courseId, questionId } = check(QuestionParamsSchema, params);
      store.deleteQuestion(courseId, questionId);
      return noContent();
    }),
    route('get', '/courses/:courseId/questions/:questionId/answers', ({ request, params }) => {
      const { courseId, questionId } = check(QuestionParamsSchema, params);
      const query = check(AnswersQuerySchema, queryOf(request));
      return reply(AnswerPageSchema, paginate(store.listAnswers(courseId, questionId), query));
    }),
    route(
      'post',
      '/courses/:courseId/questions/:questionId/answers',
      async ({ request, params }) => {
        const { courseId, questionId } = check(QuestionParamsSchema, params);
        const { bodyMd } = check(PostAnswerRequestSchema, await bodyOf(request));
        return reply(AnswerSchema, store.postAnswer(courseId, questionId, bodyMd), { status: 201 });
      },
    ),
    route('patch', '/courses/:courseId/answers/:answerId', async ({ request, params }) => {
      const { courseId, answerId } = check(AnswerParamsSchema, params);
      const { bodyMd } = check(EditAnswerRequestSchema, await bodyOf(request));
      return reply(AnswerSchema, store.editAnswer(courseId, answerId, bodyMd));
    }),
    route('delete', '/courses/:courseId/answers/:answerId', ({ params }) => {
      const { courseId, answerId } = check(AnswerParamsSchema, params);
      store.deleteAnswer(courseId, answerId);
      return noContent();
    }),
    ...(['put', 'delete'] as const).flatMap((method) => [
      route(method, '/courses/:courseId/questions/:questionId/vote', ({ params }) => {
        const { courseId, questionId } = check(QuestionParamsSchema, params);
        store.vote(courseId, 'question', questionId, method === 'put');
        return noContent();
      }),
      route(method, '/courses/:courseId/answers/:answerId/vote', ({ params }) => {
        const { courseId, answerId } = check(AnswerParamsSchema, params);
        store.vote(courseId, 'answer', answerId, method === 'put');
        return noContent();
      }),
    ]),
    route(
      'put',
      '/courses/:courseId/questions/:questionId/accepted-answer',
      async ({ request, params }) => {
        const { courseId, questionId } = check(QuestionParamsSchema, params);
        const { answerId } = check(AcceptAnswerRequestSchema, await bodyOf(request));
        return reply(QuestionSchema, store.setAcceptedAnswer(courseId, questionId, answerId));
      },
    ),
    route('delete', '/courses/:courseId/questions/:questionId/accepted-answer', ({ params }) => {
      const { courseId, questionId } = check(QuestionParamsSchema, params);
      return reply(QuestionSchema, store.setAcceptedAnswer(courseId, questionId, null));
    }),

    /* ------------------------------------------------------------ instructor */
    route('get', '/instructor/qa', ({ request }) => {
      const query = check(InstructorQaQuerySchema, queryOf(request));
      return reply(InstructorQaPageSchema, paginate(store.instructorQa(query), query));
    }),
    route('get', '/courses/:courseId/reviews', ({ request, params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      const query = check(InstructorReviewsQuerySchema, queryOf(request));
      return reply(
        InstructorReviewPageSchema,
        paginate(store.instructorReviews(courseId, query.rating), query),
      );
    }),
    route('put', '/courses/:courseId/reviews/:reviewId/reply', async ({ request, params }) => {
      const { courseId, reviewId } = check(CourseReviewParamsSchema, params);
      const { body } = check(UpsertReviewReplyRequestSchema, await bodyOf(request));
      return reply(ReviewReplySchema, store.upsertReviewReply(courseId, reviewId, body));
    }),
    route('delete', '/courses/:courseId/reviews/:reviewId/reply', ({ params }) => {
      const { courseId, reviewId } = check(CourseReviewParamsSchema, params);
      store.deleteReviewReply(courseId, reviewId);
      return noContent();
    }),
    route('get', '/courses/:courseId/announcements', ({ request, params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      const query = check(AnnouncementsQuerySchema, queryOf(request));
      const page = paginate(store.instructorAnnouncements(courseId), query);
      return reply(InstructorAnnouncementPageSchema, {
        ...page,
        quota: store.announcementQuota(courseId),
      });
    }),
    route('post', '/courses/:courseId/announcements', async ({ request, params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      const body = check(PostAnnouncementRequestSchema, await bodyOf(request));
      return reply(AnnouncementSchema, store.postAnnouncement(courseId, body), { status: 201 });
    }),
    route('delete', '/courses/:courseId/announcements/:announcementId', ({ params }) => {
      const { courseId, announcementId } = check(AnnouncementParamsSchema, params);
      store.deleteAnnouncement(courseId, announcementId);
      return noContent();
    }),

    /* ------------------------------------------------------------ quiz authoring */
    route('get', '/courses/:courseId/lectures/:lectureId/quiz', ({ params }) => {
      const { courseId, lectureId } = check(LectureParamsSchema, params);
      return reply(QuizAuthoringSchema, store.quizAuthoring(courseId, lectureId));
    }),
    route('put', '/courses/:courseId/lectures/:lectureId/quiz', async ({ request, params }) => {
      const { courseId, lectureId } = check(LectureParamsSchema, params);
      const { passPct } = check(UpdateQuizSettingsRequestSchema, await bodyOf(request));
      return reply(QuizAuthoringSchema, store.updateQuizSettings(courseId, lectureId, passPct));
    }),
    route(
      'post',
      '/courses/:courseId/lectures/:lectureId/quiz/questions',
      async ({ request, params }) => {
        const { courseId, lectureId } = check(LectureParamsSchema, params);
        const body = check(CreateQuizQuestionRequestSchema, await bodyOf(request));
        return reply(
          QuizQuestionAuthoringSchema,
          store.addQuizQuestion(courseId, lectureId, body),
          {
            status: 201,
          },
        );
      },
    ),
    route(
      'patch',
      '/courses/:courseId/lectures/:lectureId/quiz/questions/:questionId',
      async ({ request, params }) => {
        const { courseId, lectureId, questionId } = check(QuizQuestionParamsSchema, params);
        const body = check(UpdateQuizQuestionRequestSchema, await bodyOf(request));
        return reply(
          QuizQuestionAuthoringSchema,
          store.updateQuizQuestion(courseId, lectureId, questionId, body),
        );
      },
    ),
    route(
      'delete',
      '/courses/:courseId/lectures/:lectureId/quiz/questions/:questionId',
      ({ params }) => {
        const { courseId, lectureId, questionId } = check(QuizQuestionParamsSchema, params);
        store.deleteQuizQuestion(courseId, lectureId, questionId);
        return noContent();
      },
    ),
    route(
      'put',
      '/courses/:courseId/lectures/:lectureId/quiz/questions/:questionId/options',
      async ({ request, params }) => {
        const { courseId, lectureId, questionId } = check(QuizQuestionParamsSchema, params);
        const { options } = check(PutQuizQuestionOptionsRequestSchema, await bodyOf(request));
        return reply(
          QuizQuestionAuthoringSchema,
          store.putQuizQuestionOptions(courseId, lectureId, questionId, options),
        );
      },
    ),
    route(
      'put',
      '/courses/:courseId/lectures/:lectureId/quiz/order',
      async ({ request, params }) => {
        const { courseId, lectureId } = check(LectureParamsSchema, params);
        const { questionIds } = check(ReorderQuizQuestionsRequestSchema, await bodyOf(request));
        return reply(
          QuizAuthoringSchema,
          store.reorderQuizQuestions(courseId, lectureId, questionIds),
        );
      },
    ),

    /* ------------------------------------------------------------ admin */
    route('get', '/admin/moderation/reports', ({ request }) => {
      const query = check(ModerationQueueQuerySchema, queryOf(request));
      return reply(ModerationQueuePageSchema, paginate(store.moderationQueue(query), query));
    }),
    route('post', '/admin/moderation/:type/:subjectId/:action', async ({ request, params }) => {
      const { type: segment, subjectId, action } = check(ModerationActionParamsSchema, params);
      const type = reportSubjectTypeOfPath(segment);
      if (type === null) throw new BadRequest([{ path: 'type', message: 'Unknown subject type' }]);
      const { reason } = check(ModerationReasonRequestSchema, await bodyOf(request));
      return reply(ModerationSubjectSchema, store.moderate(type, subjectId, action, reason));
    }),
    route('post', '/admin/certificates/:certificateId/:action', async ({ request, params }) => {
      const { certificateId, action } = check(CertificateActionParamsSchema, params);
      const { reason } = check(AdminCertificateReasonRequestSchema, await bodyOf(request));
      return reply(
        AdminCertificateSchema,
        store.adminTransitionCertificate(certificateId, action, reason),
      );
    }),
    route('get', '/admin/users/:userId/certificates', ({ params }) => {
      const { userId } = check(UserIdParamsSchema, params);
      return reply(AdminUserCertificatesSchema, { items: store.adminUserCertificates(userId) });
    }),
    route('get', '/admin/course-revisions/:revisionId/lectures/:lectureId/quiz', ({ params }) => {
      const { revisionId, lectureId } = check(RevisionLectureParamsSchema, params);
      return reply(RevisionQuizSchema, store.revisionQuiz(revisionId, lectureId));
    }),

    /* ------------------------------------------------------------ notifications (every BFF) */
    route('get', '/me/notifications/unread-count', () =>
      reply(UnreadCountSchema, store.unreadCount()),
    ),
    route('post', '/me/notifications/read-all', async ({ request }) => {
      const { upToId } = check(MarkAllReadRequestSchema, await bodyOf(request));
      store.markAllRead(upToId);
      return noContent();
    }),
    route('get', '/me/notifications', ({ request }) => {
      const query = check(NotificationsQuerySchema, queryOf(request));
      return reply(
        NotificationPageSchema,
        paginate(store.listNotifications(query.unreadOnly), query),
      );
    }),
    route('post', '/me/notifications/:notificationId/read', ({ params }) => {
      const { notificationId } = check(NotificationIdParamsSchema, params);
      store.markRead(notificationId);
      return noContent();
    }),
    route('get', '/me/notification-preferences', () =>
      reply(NotificationPreferencesSchema, { items: store.preferencesOf() }),
    ),
    route('put', '/me/notification-preferences', async ({ request }) => {
      const { items } = check(UpdateNotificationPreferencesRequestSchema, await bodyOf(request));
      return reply(NotificationPreferencesSchema, { items: store.updatePreferences(items) });
    }),
    route('post', '/realtime/tickets', () =>
      reply(RealtimeTicketSchema, store.issueRealtimeTicket(), { status: 201 }),
    ),
  ];

  return { handlers, store };
}
