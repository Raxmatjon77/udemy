import { Injectable } from '@nestjs/common';
import type { CourseDetail } from '@udemy/contracts';
import { MediaFacade } from '../../../media';
import { CourseNotFound, InvalidCatalogField } from '../../domain/catalog.errors';
import { planArchive } from '../../domain/lifecycle';
import { CourseDetailAssembler } from '../course-detail.assembler';
import { CourseLocker } from '../course-locker';
import { requireTransitionHead, revisionConsumer } from '../lifecycle-support';
import { CatalogEventPublisher } from '../ports/catalog-event.publisher';
import { CourseLifecycleRepository } from '../ports/course-lifecycle.repository';
import { CourseRepository } from '../ports/course.repository';
import { TransactionRunner } from '../ports/transaction-runner';

/** The system marker of an automatic withdraw (`course_transitions_withdraw_reason_ck`). */
export const ARCHIVED_WITHDRAW_REASON = 'ARCHIVED';

/** Minimum length of an admin takedown reason (invariant 8; also a DB trigger). */
const TAKEDOWN_REASON_MIN = 10;

export interface ArchiveCourseInput {
  readonly actorId: string;
  readonly courseId: string;
  /** Owner: optional (1–2000). Admin takedown: required (10–2000). */
  readonly reason?: string;
  /** From the route: the admin takedown endpoint, not the owner's archive. */
  readonly byAdmin: boolean;
}

/**
 * `ArchiveCourse` (design §5, D13): owner archive or admin TAKEDOWN (§13 Q4: the manual
 * answer to banned instructors). Only a PUBLISHED course; anything else is 409
 * `invalid_state_transition`. The live revision and its pins are KEPT (Phase 4 students keep
 * access); a pending update is withdrawn first (WITHDRAW with reason `ARCHIVED`, its pins
 * released, `CourseSubmissionWithdrawn{cause: ARCHIVED}`), then ARCHIVE is appended and
 * `CourseArchived{byAdmin}` emitted (the worker mails the owner on a takedown).
 */
@Injectable()
export class ArchiveCourseCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly lifecycle: CourseLifecycleRepository,
    private readonly media: MediaFacade,
    private readonly events: CatalogEventPublisher,
    private readonly locker: CourseLocker,
    private readonly detail: CourseDetailAssembler,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: ArchiveCourseInput): Promise<CourseDetail> {
    const reason = input.reason ?? null;
    if (input.byAdmin && (reason === null || reason.length < TAKEDOWN_REASON_MIN)) {
      throw new InvalidCatalogField({
        path: 'reason',
        message: `A takedown needs a reason of at least ${TAKEDOWN_REASON_MIN} characters.`,
      });
    }
    return this.tx.run(async (trx) => {
      const course = await this.locker.lock(trx, input.courseId);
      if (!input.byAdmin && course.ownerId !== input.actorId) throw new CourseNotFound();
      const plan = planArchive(course);
      let head = await requireTransitionHead(this.lifecycle, trx, course);

      const pending = plan.pendingToWithdraw;
      if (pending !== null) {
        await this.media.releaseConsumer(trx, revisionConsumer(pending));
        const withdrawn = await this.lifecycle.appendTransition(trx, {
          courseId: course.id,
          prevTransitionId: head.id,
          revisionId: pending,
          action: 'WITHDRAW',
          fromStatus: 'PUBLISHED',
          toStatus: 'PUBLISHED',
          actorId: input.actorId,
          reason: ARCHIVED_WITHDRAW_REASON,
        });
        head = {
          id: withdrawn.id,
          toStatus: 'PUBLISHED',
          action: 'WITHDRAW',
          actorId: input.actorId,
        };
        await this.events.courseSubmissionWithdrawn(trx, {
          courseId: course.id,
          revisionId: pending,
          ownerId: course.ownerId,
          actorId: input.actorId,
          cause: 'ARCHIVED',
          withdrawnAt: withdrawn.occurredAt.toISOString(),
        });
      }

      const updated = await this.courses.applyLifecycle(trx, course.id, {
        status: plan.toStatus,
        pendingRevisionId: null,
      });
      const archived = await this.lifecycle.appendTransition(trx, {
        courseId: course.id,
        prevTransitionId: head.id,
        revisionId: null,
        action: 'ARCHIVE',
        fromStatus: plan.fromStatus,
        toStatus: plan.toStatus,
        actorId: input.actorId,
        reason,
      });
      await this.events.courseArchived(trx, {
        courseId: course.id,
        ownerId: course.ownerId,
        actorId: input.actorId,
        byAdmin: input.byAdmin,
        reason,
        archivedAt: archived.occurredAt.toISOString(),
      });
      return this.detail.build(updated, trx);
    });
  }
}
