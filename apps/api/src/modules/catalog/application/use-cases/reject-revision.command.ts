import { Injectable } from '@nestjs/common';
import type { CourseDetail } from '@udemy/contracts';
import { MediaFacade } from '../../../media';
import { planReject } from '../../domain/lifecycle';
import { CourseDetailAssembler } from '../course-detail.assembler';
import { CourseLocker } from '../course-locker';
import { requireRevisionOf, requireTransitionHead, revisionConsumer } from '../lifecycle-support';
import { CatalogEventPublisher } from '../ports/catalog-event.publisher';
import { CourseLifecycleRepository } from '../ports/course-lifecycle.repository';
import { CourseRepository } from '../ports/course.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface RejectRevisionInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly revisionId: string;
  /** 10–2000 characters, mailed to the instructor (validated by the request schema). */
  readonly reason: string;
  readonly expectedVersion?: number;
}

/**
 * `RejectRevision` (admin, design §5): same guards as approve. A first submission becomes
 * REJECTED (editable again); a rejected update leaves the live course PUBLISHED (badge
 * LIVE_UPDATE_REJECTED). Releases the revision's pins, appends REJECT with the reason and
 * emits `CourseRejected`.
 */
@Injectable()
export class RejectRevisionCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly lifecycle: CourseLifecycleRepository,
    private readonly media: MediaFacade,
    private readonly events: CatalogEventPublisher,
    private readonly locker: CourseLocker,
    private readonly detail: CourseDetailAssembler,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: RejectRevisionInput): Promise<CourseDetail> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lock(trx, input.courseId);
      const revision = await requireRevisionOf(this.lifecycle, trx, course.id, input.revisionId);
      const plan = planReject(course, {
        ownerId: course.ownerId,
        actorId: input.actorId,
        revisionId: input.revisionId,
        expectedVersion: input.expectedVersion,
      });
      const head = await requireTransitionHead(this.lifecycle, trx, course);

      await this.media.releaseConsumer(trx, revisionConsumer(input.revisionId));
      const updated = await this.courses.applyLifecycle(trx, course.id, {
        status: plan.toStatus,
        pendingRevisionId: null,
      });
      const transition = await this.lifecycle.appendTransition(trx, {
        courseId: course.id,
        prevTransitionId: head.id,
        revisionId: input.revisionId,
        action: 'REJECT',
        fromStatus: plan.fromStatus,
        toStatus: plan.toStatus,
        actorId: input.actorId,
        reason: input.reason,
      });
      await this.events.courseRejected(trx, {
        courseId: course.id,
        revisionId: input.revisionId,
        ownerId: course.ownerId,
        kind: revision.kind,
        decidedBy: input.actorId,
        reason: input.reason,
        rejectedAt: transition.occurredAt.toISOString(),
      });
      return this.detail.build(updated, trx);
    });
  }
}
