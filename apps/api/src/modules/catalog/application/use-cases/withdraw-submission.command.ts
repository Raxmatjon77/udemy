import { Injectable } from '@nestjs/common';
import type { CourseDetail } from '@udemy/contracts';
import { MediaFacade } from '../../../media';
import { CourseNotFound } from '../../domain/catalog.errors';
import { planWithdraw } from '../../domain/lifecycle';
import { CourseDetailAssembler } from '../course-detail.assembler';
import { CourseLocker } from '../course-locker';
import { requireTransitionHead, revisionConsumer } from '../lifecycle-support';
import { CatalogEventPublisher } from '../ports/catalog-event.publisher';
import { CourseLifecycleRepository } from '../ports/course-lifecycle.repository';
import { CourseRepository } from '../ports/course.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface WithdrawSubmissionInput {
  readonly actorId: string;
  readonly courseId: string;
}

/**
 * `WithdrawSubmission` (design §5, D2): the owner takes the pending revision back to edit
 * again. IN_REVIEW -> DRAFT (first submission) or PUBLISHED stays PUBLISHED (an update); the
 * revision's media pins are released, the WITHDRAW transition is appended and
 * `CourseSubmissionWithdrawn{cause: OWNER}` emitted. Nothing pending: 409
 * `invalid_state_transition` (a repeat is deterministic).
 */
@Injectable()
export class WithdrawSubmissionCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly lifecycle: CourseLifecycleRepository,
    private readonly media: MediaFacade,
    private readonly events: CatalogEventPublisher,
    private readonly locker: CourseLocker,
    private readonly detail: CourseDetailAssembler,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: WithdrawSubmissionInput): Promise<CourseDetail> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lock(trx, input.courseId);
      if (course.ownerId !== input.actorId) throw new CourseNotFound();
      const plan = planWithdraw(course);
      const head = await requireTransitionHead(this.lifecycle, trx, course);

      await this.media.releaseConsumer(trx, revisionConsumer(plan.revisionId));
      const updated = await this.courses.applyLifecycle(trx, course.id, {
        status: plan.toStatus,
        pendingRevisionId: null,
      });
      const transition = await this.lifecycle.appendTransition(trx, {
        courseId: course.id,
        prevTransitionId: head.id,
        revisionId: plan.revisionId,
        action: 'WITHDRAW',
        fromStatus: plan.fromStatus,
        toStatus: plan.toStatus,
        actorId: input.actorId,
        reason: null,
      });
      await this.events.courseSubmissionWithdrawn(trx, {
        courseId: course.id,
        revisionId: plan.revisionId,
        ownerId: course.ownerId,
        actorId: input.actorId,
        cause: 'OWNER',
        withdrawnAt: transition.occurredAt.toISOString(),
      });
      return this.detail.build(updated, trx);
    });
  }
}
