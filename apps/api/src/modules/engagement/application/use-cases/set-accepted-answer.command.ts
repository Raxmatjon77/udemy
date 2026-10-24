import { Injectable } from '@nestjs/common';
import { type Question, QuestionReopened, QuestionResolved } from '@udemy/contracts';
import { AnswerNotFound, NotContentAuthor, QuestionNotFound } from '../../domain/engagement.errors';
import { canResolve } from '../../domain/qa';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import { QaRepository } from '../ports/qa.repository';
import { QaHints } from '../ports/qa-hints';
import { TransactionRunner } from '../ports/transaction-runner';
import { QaAccess, type QaViewer } from '../qa-access';
import { questionInCourse } from '../qa-lookups';
import { QaPresenter } from '../qa-presenter';

export interface SetAcceptedAnswerInput {
  readonly viewer: QaViewer;
  readonly courseId: string;
  readonly questionId: string;
  /** The answer to accept; null un-accepts (reopens). */
  readonly answerId: string | null;
}

/**
 * `AcceptAnswer` / `UnacceptAnswer` (design §5, D12): the question author or the course owner.
 * The answer must be a VISIBLE, non-deleted answer of THIS question (the composite FK
 * `questions_id_accepted_answer_id_fk` and `questions_accepted_answer_visible_ck` back this up
 * against races: both map to 404 `answer_not_found`). The question row is locked first.
 * A change emits `QuestionResolved` (new answer) or `QuestionReopened` (cleared); repeating the
 * current state is a no-op (200, no event).
 *
 * Errors: 403 `enrollment_required` / `not_content_author`, 404 `question_not_found` /
 * `answer_not_found`.
 */
@Injectable()
export class SetAcceptedAnswerCommand {
  constructor(
    private readonly access: QaAccess,
    private readonly qa: QaRepository,
    private readonly events: EngagementEventPublisher,
    private readonly tx: TransactionRunner,
    private readonly presenter: QaPresenter,
    private readonly hints: QaHints,
  ) {}

  async execute(input: SetAcceptedAnswerInput): Promise<Question> {
    const course = await this.access.require(input.courseId, input.viewer);
    const viewerId = input.viewer.userId;

    const { question, changed } = await this.tx.run(async (trx) => {
      const locked = questionInCourse(
        await this.qa.lockQuestion(trx, input.questionId),
        course.courseId,
        viewerId,
      );
      if (locked.deletedAt !== null) throw new QuestionNotFound();
      if (!canResolve(locked, viewerId, course.ownerId)) throw new NotContentAuthor();
      if (input.answerId === locked.acceptedAnswerId) return { question: locked, changed: false };
      if (input.answerId !== null) {
        const found = await this.qa.findAnswer(input.answerId, trx);
        if (
          found === null ||
          found.answer.questionId !== locked.id ||
          found.answer.deletedAt !== null ||
          found.answer.moderationStatus !== 'VISIBLE'
        ) {
          throw new AnswerNotFound();
        }
      }
      const change = await this.qa.setAcceptedAnswer(trx, locked.id, input.answerId);
      if (change === null) throw new QuestionNotFound();
      const ids = { questionId: locked.id, courseId: locked.courseId, actorId: viewerId };
      const at = change.at.toISOString();
      if (input.answerId !== null) {
        await this.events.publish(trx, QuestionResolved, {
          ...ids,
          answerId: input.answerId,
          resolvedAt: at,
        });
      } else if (change.previousAnswerId !== null) {
        await this.events.publish(trx, QuestionReopened, {
          ...ids,
          answerId: change.previousAnswerId,
          reopenedAt: at,
        });
      }
      return { question: change.question, changed: change.previousAnswerId !== input.answerId };
    });
    if (changed) {
      await this.hints.changed({
        courseId: question.courseId,
        questionId: question.id,
        lectureId: question.lectureId,
      });
    }
    return this.presenter.question(question, { viewerId, ownerId: course.ownerId });
  }
}
