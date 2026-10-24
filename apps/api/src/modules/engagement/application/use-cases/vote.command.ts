import { Injectable } from '@nestjs/common';
import type { VoteSubject } from '@udemy/db';
import { CannotVoteOwnContent, QuestionNotFound } from '../../domain/engagement.errors';
import { EngagementRateLimiter } from '../ports/engagement-rate-limiter';
import { QaRepository } from '../ports/qa.repository';
import { QaAccess, type QaViewer } from '../qa-access';
import { findVisibleAnswer, findVisibleQuestion } from '../qa-lookups';

export interface VoteInput {
  readonly viewer: QaViewer;
  readonly courseId: string;
  readonly subject: VoteSubject;
  /** The question or answer id (resolved within the course). */
  readonly subjectId: string;
  /** PUT = true (upvote), DELETE = false (retract). */
  readonly on: boolean;
}

/**
 * `Vote` / `Unvote` (design §5, D12): one upvote per user and subject, never on your own post.
 * Idempotent (`INSERT … ON CONFLICT DO NOTHING` / `DELETE` by PK); the DB triggers keep
 * `upvote_count` exact (20 parallel votes by one user count once). Voting needs a live
 * question (not deleted) or a visible answer. No hint: counts refresh with the next fetch.
 *
 * Errors: 403, 404 `question_not_found` / `answer_not_found`, 422 `cannot_vote_own_content`,
 * 429 (300 per hour, upvotes only).
 */
@Injectable()
export class VoteCommand {
  constructor(
    private readonly rateLimiter: EngagementRateLimiter,
    private readonly access: QaAccess,
    private readonly qa: QaRepository,
  ) {}

  async execute(input: VoteInput): Promise<void> {
    const viewerId = input.viewer.userId;
    if (input.on) await this.rateLimiter.hit('vote', viewerId);
    const course = await this.access.require(input.courseId, input.viewer);
    let authorId: string;
    if (input.subject === 'QUESTION') {
      const question = await findVisibleQuestion(
        this.qa,
        course.courseId,
        input.subjectId,
        viewerId,
      );
      if (question.deletedAt !== null) throw new QuestionNotFound();
      authorId = question.authorId;
    } else {
      const { answer } = await findVisibleAnswer(
        this.qa,
        course.courseId,
        input.subjectId,
        viewerId,
      );
      authorId = answer.authorId;
    }
    if (authorId === viewerId) throw new CannotVoteOwnContent();
    if (input.on) {
      await this.qa.castVote(input.subject, input.subjectId, viewerId);
    } else {
      await this.qa.retractVote(input.subject, input.subjectId, viewerId);
    }
  }
}
