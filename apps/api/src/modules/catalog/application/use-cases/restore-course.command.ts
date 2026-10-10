import { Injectable } from '@nestjs/common';
import type { CourseDetail } from '@udemy/contracts';
import { CourseNotFound } from '../../domain/catalog.errors';
import { planRestore } from '../../domain/lifecycle';
import { CourseDetailAssembler } from '../course-detail.assembler';
import { CourseLocker } from '../course-locker';
import { requireTransitionHead } from '../lifecycle-support';
import { CatalogEventPublisher } from '../ports/catalog-event.publisher';
import { CourseLifecycleRepository } from '../ports/course-lifecycle.repository';
import { CourseRepository } from '../ports/course.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface RestoreCourseInput {
  readonly actorId: string;
  readonly courseId: string;
  /** From the route: the admin restore endpoint, not the owner's. */
  readonly byAdmin: boolean;
}

/**
 * `RestoreCourse` (design §5): ARCHIVED -> PUBLISHED with the same live revision. The owner may
 * restore only what they archived themselves; after an admin takedown it is 403
 * `restore_forbidden` (invariant 10, also `course_transitions_restore_actor_ck`). An admin may
 * always restore. Appends RESTORE and emits `CourseRestored`.
 */
@Injectable()
export class RestoreCourseCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly lifecycle: CourseLifecycleRepository,
    private readonly events: CatalogEventPublisher,
    private readonly locker: CourseLocker,
    private readonly detail: CourseDetailAssembler,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: RestoreCourseInput): Promise<CourseDetail> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lock(trx, input.courseId);
      if (!input.byAdmin && course.ownerId !== input.actorId) throw new CourseNotFound();
      const head = await requireTransitionHead(this.lifecycle, trx, course);
      const plan = planRestore(course, head, input.byAdmin);

      const updated = await this.courses.applyLifecycle(trx, course.id, { status: plan.toStatus });
      const restored = await this.lifecycle.appendTransition(trx, {
        courseId: course.id,
        prevTransitionId: head.id,
        revisionId: null,
        action: 'RESTORE',
        fromStatus: plan.fromStatus,
        toStatus: plan.toStatus,
        actorId: input.actorId,
        reason: null,
      });
      await this.events.courseRestored(trx, {
        courseId: course.id,
        ownerId: course.ownerId,
        actorId: input.actorId,
        restoredAt: restored.occurredAt.toISOString(),
      });
      return this.detail.build(updated, trx);
    });
  }
}
