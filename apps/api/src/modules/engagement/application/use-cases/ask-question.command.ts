import { Injectable } from '@nestjs/common';
import { type Question, QuestionPosted } from '@udemy/contracts';
import { CatalogFacade } from '../../../catalog';
import { LectureNotFound } from '../../domain/engagement.errors';
import { assertMarkdownAllowed } from '../../domain/markdown';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import { EngagementRateLimiter } from '../ports/engagement-rate-limiter';
import { QaRepository } from '../ports/qa.repository';
import { QaHints } from '../ports/qa-hints';
import { TransactionRunner } from '../ports/transaction-runner';
import { QaAccess, type QaViewer } from '../qa-access';
import { QaPresenter } from '../qa-presenter';

export interface AskQuestionInput {
  readonly viewer: QaViewer;
  readonly courseId: string;
  /** Null = a general course question. */
  readonly lectureId: string | null;
  /** Plain text, 5-200 (contracts `QuestionTitleSchema`). */
  readonly title: string;
  readonly bodyMd: string;
}

/**
 * `AskQuestion` (design §5, D12): an ACTIVE learner or the owner; the lecture, when given, must
 * be in the course's live revision. The question and `QuestionPosted` (the Q&A notifier tells
 * the owner) commit together; after the commit the course room gets a `qa.changed` hint.
 *
 * Errors: 403 `enrollment_required`, 404 `course_not_found` / `lecture_not_found`,
 * 422 `markdown_not_allowed`, 429 (20 per 24 h).
 */
@Injectable()
export class AskQuestionCommand {
  constructor(
    private readonly rateLimiter: EngagementRateLimiter,
    private readonly access: QaAccess,
    private readonly catalog: CatalogFacade,
    private readonly qa: QaRepository,
    private readonly events: EngagementEventPublisher,
    private readonly tx: TransactionRunner,
    private readonly presenter: QaPresenter,
    private readonly hints: QaHints,
  ) {}

  async execute(input: AskQuestionInput): Promise<Question> {
    await this.rateLimiter.hit('questionPost', input.viewer.userId);
    const course = await this.access.require(input.courseId, input.viewer);
    if (
      input.lectureId !== null &&
      (await this.catalog.getLiveLecture(course.courseId, input.lectureId)) === null
    ) {
      throw new LectureNotFound();
    }
    assertMarkdownAllowed('bodyMd', input.bodyMd);

    const question = await this.tx.run(async (trx) => {
      const created = await this.qa.insertQuestion(trx, {
        courseId: course.courseId,
        lectureId: input.lectureId,
        authorId: input.viewer.userId,
        title: input.title,
        bodyMd: input.bodyMd,
      });
      await this.events.publish(trx, QuestionPosted, {
        questionId: created.id,
        courseId: created.courseId,
        lectureId: created.lectureId,
        authorId: created.authorId,
        postedAt: created.createdAt.toISOString(),
      });
      return created;
    });
    await this.hints.changed({
      courseId: question.courseId,
      questionId: question.id,
      lectureId: question.lectureId,
    });
    return this.presenter.question(question, {
      viewerId: input.viewer.userId,
      ownerId: course.ownerId,
    });
  }
}
