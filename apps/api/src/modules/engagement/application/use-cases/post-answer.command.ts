import { Injectable } from '@nestjs/common';
import { type Answer, AnswerPosted } from '@udemy/contracts';
import { QuestionNotFound } from '../../domain/engagement.errors';
import { assertMarkdownAllowed } from '../../domain/markdown';
import { acceptsAnswers } from '../../domain/qa';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import { EngagementRateLimiter } from '../ports/engagement-rate-limiter';
import { QaRepository } from '../ports/qa.repository';
import { QaHints } from '../ports/qa-hints';
import { TransactionRunner } from '../ports/transaction-runner';
import { QaAccess, type QaViewer } from '../qa-access';
import { questionInCourse } from '../qa-lookups';
import { QaPresenter } from '../qa-presenter';

export interface PostAnswerInput {
  readonly viewer: QaViewer;
  readonly courseId: string;
  readonly questionId: string;
  readonly bodyMd: string;
}

/**
 * `PostAnswer` (design §5, D12): an ACTIVE learner or the owner (whose answers carry the
 * instructor badge); the question must be VISIBLE and not deleted. The question row is locked
 * first, so a concurrent hide or delete cannot slip in; the DB trigger then recounts
 * `answer_count` / `last_activity_at` in the same statement. `AnswerPosted` (the Q&A notifier
 * tells the question author unless they answered themselves) commits with the answer; a
 * `qa.changed` hint follows the commit.
 *
 * Errors: 403, 404 `question_not_found`, 422 `markdown_not_allowed`, 429 (100 per 24 h).
 */
@Injectable()
export class PostAnswerCommand {
  constructor(
    private readonly rateLimiter: EngagementRateLimiter,
    private readonly access: QaAccess,
    private readonly qa: QaRepository,
    private readonly events: EngagementEventPublisher,
    private readonly tx: TransactionRunner,
    private readonly presenter: QaPresenter,
    private readonly hints: QaHints,
  ) {}

  async execute(input: PostAnswerInput): Promise<Answer> {
    const viewerId = input.viewer.userId;
    await this.rateLimiter.hit('answerPost', viewerId);
    const course = await this.access.require(input.courseId, input.viewer);
    assertMarkdownAllowed('bodyMd', input.bodyMd);

    const { question, answer } = await this.tx.run(async (trx) => {
      const locked = questionInCourse(
        await this.qa.lockQuestion(trx, input.questionId),
        course.courseId,
        viewerId,
      );
      if (!acceptsAnswers(locked)) throw new QuestionNotFound();
      const created = await this.qa.insertAnswer(trx, {
        questionId: locked.id,
        authorId: viewerId,
        bodyMd: input.bodyMd,
      });
      await this.events.publish(trx, AnswerPosted, {
        answerId: created.id,
        questionId: locked.id,
        courseId: locked.courseId,
        authorId: created.authorId,
        questionAuthorId: locked.authorId,
        byCourseOwner: course.isOwner,
        postedAt: created.createdAt.toISOString(),
      });
      return { question: locked, answer: created };
    });
    await this.hints.changed({
      courseId: question.courseId,
      questionId: question.id,
      lectureId: question.lectureId,
    });
    return this.presenter.answer(answer, question, { viewerId, ownerId: course.ownerId });
  }
}
