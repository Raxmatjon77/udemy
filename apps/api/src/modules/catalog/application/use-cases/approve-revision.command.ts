import { Injectable } from '@nestjs/common';
import type { CourseDetail } from '@udemy/contracts';
import { MediaFacade } from '../../../media';
import { planApprove } from '../../domain/lifecycle';
import { CourseDetailAssembler } from '../course-detail.assembler';
import { CourseLocker } from '../course-locker';
import { requireRevisionOf, requireTransitionHead, revisionConsumer } from '../lifecycle-support';
import { CatalogEventPublisher } from '../ports/catalog-event.publisher';
import { CourseLifecycleRepository } from '../ports/course-lifecycle.repository';
import { CourseRepository } from '../ports/course.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface ApproveRevisionInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly revisionId: string;
  /** Optional note to the instructor (stored as the transition reason). */
  readonly note?: string;
  readonly expectedVersion?: number;
}

/**
 * `ApproveRevision` (admin, design §5, D1): the named pending revision goes live.
 *
 * 1. Lock the course; the revision must belong to it (404 `not_found`).
 * 2. `planApprove`: not the owner (403 `self_decision_forbidden`, also a DB trigger),
 *    `expectedVersion` (409 `version_conflict`), the revision is the pending one (409
 *    `invalid_state_transition`: already decided, withdrawn or superseded; the decision unique
 *    index backs a race up).
 * 3. Flip `published_revision_id`, clear the pending pointer, set PUBLISHED and
 *    `first_published_at` once (which freezes the slug, D12).
 * 4. Release the media pins of the superseded live revision (design §4 revision states).
 * 5. APPROVE transition (note as reason) and `CoursePublished{kind}`.
 */
@Injectable()
export class ApproveRevisionCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly lifecycle: CourseLifecycleRepository,
    private readonly media: MediaFacade,
    private readonly events: CatalogEventPublisher,
    private readonly locker: CourseLocker,
    private readonly detail: CourseDetailAssembler,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: ApproveRevisionInput): Promise<CourseDetail> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lock(trx, input.courseId);
      const revision = await requireRevisionOf(this.lifecycle, trx, course.id, input.revisionId);
      const plan = planApprove(course, {
        ownerId: course.ownerId,
        actorId: input.actorId,
        revisionId: input.revisionId,
        expectedVersion: input.expectedVersion,
      });
      const head = await requireTransitionHead(this.lifecycle, trx, course);

      const updated = await this.courses.applyLifecycle(trx, course.id, {
        status: plan.toStatus,
        pendingRevisionId: null,
        publishedRevisionId: input.revisionId,
        markFirstPublished: true,
      });
      if (plan.supersededRevisionId !== null) {
        await this.media.releaseConsumer(trx, revisionConsumer(plan.supersededRevisionId));
      }
      const transition = await this.lifecycle.appendTransition(trx, {
        courseId: course.id,
        prevTransitionId: head.id,
        revisionId: input.revisionId,
        action: 'APPROVE',
        fromStatus: plan.fromStatus,
        toStatus: plan.toStatus,
        actorId: input.actorId,
        reason: input.note ?? null,
      });
      await this.events.coursePublished(trx, {
        courseId: course.id,
        revisionId: input.revisionId,
        revisionNo: revision.revisionNo,
        ownerId: course.ownerId,
        slug: updated.slug,
        kind: revision.kind,
        decidedBy: input.actorId,
        publishedAt: transition.occurredAt.toISOString(),
      });
      return this.detail.build(updated, trx);
    });
  }
}
