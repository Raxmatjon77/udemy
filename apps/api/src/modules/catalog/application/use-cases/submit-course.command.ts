import { Injectable } from '@nestjs/common';
import type { AssetView, SubmitCourseResponse } from '@udemy/contracts';
import { MediaFacade } from '../../../media';
import {
  CourseNotFound,
  CourseNotReady,
  InvalidStateTransition,
  NothingToReview,
} from '../../domain/catalog.errors';
import { planSubmit } from '../../domain/lifecycle';
import {
  contentHash,
  referencedAssetIds,
  type SnapshotContent,
} from '../../domain/revision-snapshot';
import { CourseLocker } from '../course-locker';
import { CourseReadinessEvaluator } from '../course-readiness.evaluator';
import { CurriculumReader } from '../curriculum-reader';
import { requireTransitionHead } from '../lifecycle-support';
import { CatalogEventPublisher } from '../ports/catalog-event.publisher';
import { CategoryRepository } from '../ports/category.repository';
import { CourseLifecycleRepository } from '../ports/course-lifecycle.repository';
import { CourseRepository } from '../ports/course.repository';
import { type NewRevision, RevisionRepository } from '../ports/revision.repository';
import { SubmissionRateLimiter } from '../ports/submission-rate-limiter';
import { TransactionRunner } from '../ports/transaction-runner';
import { WorkingCopySnapshotter } from '../working-copy-snapshotter';

export interface SubmitCourseInput {
  readonly actorId: string;
  readonly courseId: string;
  /** Optional note for the reviewer (1–1000, validated by the request schema). */
  readonly note?: string;
}

function required<T>(value: T | null, field: string): T {
  // Readiness (invariant 6) guarantees every header field; a null here is a programming error.
  if (value === null) throw new Error(`submit: ${field} is missing after the readiness check`);
  return value;
}

/** The complete revision rows for a ready working copy, with frozen video durations. */
function toNewRevision(
  courseId: string,
  content: SnapshotContent,
  assets: ReadonlyMap<string, AssetView>,
  meta: Pick<NewRevision, 'revisionNo' | 'kind' | 'contentHash' | 'submitterNote'>,
): NewRevision {
  return {
    courseId,
    ...meta,
    title: content.title,
    subtitle: required(content.subtitle, 'subtitle'),
    descriptionMd: required(content.descriptionMd, 'descriptionMd'),
    language: required(content.language, 'language'),
    level: required(content.level, 'level'),
    categoryId: required(content.categoryId, 'categoryId'),
    thumbnailAssetId: required(content.thumbnailAssetId, 'thumbnailAssetId'),
    outcomes: content.outcomes,
    requirements: content.requirements,
    sections: content.sections.map((section) => ({
      id: section.id,
      title: section.title,
      objective: section.objective,
      lectures: section.lectures.map((lecture) => ({
        ...lecture,
        durationSeconds:
          lecture.type === 'VIDEO' && lecture.mediaAssetId !== null
            ? required(assets.get(lecture.mediaAssetId)?.durationSeconds ?? null, 'duration')
            : null,
      })),
    })),
  };
}

/**
 * `SubmitCourse` (design §5, D1/D2): snapshots the owner's ready working copy into an immutable
 * revision and puts it in review, in ONE transaction:
 *
 * 1. Per-user rate limit (`rl:catalog:submit:u:{uid}`, 429), before any lock.
 * 2. Lock the course (404 for others' courses); `planSubmit` (409 `review_already_pending`,
 *    `course_not_editable` when archived); lock the category FOR SHARE (lock order: course ->
 *    category -> assets) so a concurrent deactivate cannot slip past the readiness check.
 * 3. Readiness with asset states read fresh in the transaction (422 `course_not_ready` with
 *    every issue).
 * 4. Snapshot + canonical SHA-256; an update identical to the live revision is 409
 *    `nothing_to_review` (invariant 7).
 * 5. Insert the revision (header, bullets, sections, lectures with frozen durations), pin
 *    every referenced READY asset to it (`catalog.course_revision` usages), set
 *    `pending_revision_id` (+ IN_REVIEW for a first submission), append the SUBMIT transition
 *    (`prev_transition_id` = head) and emit `CourseSubmittedForReview`.
 */
@Injectable()
export class SubmitCourseCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly categories: CategoryRepository,
    private readonly lifecycle: CourseLifecycleRepository,
    private readonly revisions: RevisionRepository,
    private readonly reader: CurriculumReader,
    private readonly readiness: CourseReadinessEvaluator,
    private readonly snapshotter: WorkingCopySnapshotter,
    private readonly media: MediaFacade,
    private readonly events: CatalogEventPublisher,
    private readonly rateLimiter: SubmissionRateLimiter,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: SubmitCourseInput): Promise<SubmitCourseResponse> {
    await this.rateLimiter.hitSubmit(input.actorId);
    return this.tx.run(async (trx) => {
      const course = await this.locker.lock(trx, input.courseId);
      if (course.ownerId !== input.actorId) throw new CourseNotFound();
      const plan = planSubmit(course);
      if (course.categoryId !== null) await this.categories.findForShare(trx, course.categoryId);

      const content = await this.snapshotter.content(course, trx);
      const loaded = await this.reader.load(course, trx);
      const readiness = await this.readiness.evaluate(course, trx, {
        curriculum: loaded,
        outcomeCount: content.outcomes.length,
      });
      if (!readiness.ready) throw new CourseNotReady(readiness.issues);

      const hash = contentHash(content);
      if (course.publishedRevisionId !== null) {
        const live = await this.revisions.findContentHashHex(course.publishedRevisionId, trx);
        if (live === hash.toString('hex')) throw new NothingToReview();
      }

      const head = await requireTransitionHead(this.lifecycle, trx, course);
      if (head.toStatus !== plan.fromStatus) throw new InvalidStateTransition();
      const revisionNo = await this.revisions.nextRevisionNo(trx, course.id);
      const revision = await this.revisions.insert(
        trx,
        toNewRevision(course.id, content, loaded.assets, {
          revisionNo,
          kind: plan.kind,
          contentHash: hash,
          submitterNote: input.note ?? null,
        }),
      );
      await this.media.pinRevisionAssets(trx, {
        revisionId: revision.id,
        assetIds: referencedAssetIds(content),
      });
      await this.courses.applyLifecycle(trx, course.id, {
        status: plan.toStatus,
        pendingRevisionId: revision.id,
      });
      await this.lifecycle.appendTransition(trx, {
        courseId: course.id,
        prevTransitionId: head.id,
        revisionId: revision.id,
        action: 'SUBMIT',
        fromStatus: plan.fromStatus,
        toStatus: plan.toStatus,
        actorId: input.actorId,
        reason: null,
      });
      await this.events.courseSubmittedForReview(trx, {
        courseId: course.id,
        revisionId: revision.id,
        revisionNo: revision.revisionNo,
        ownerId: course.ownerId,
        kind: plan.kind,
        title: content.title,
        submittedAt: revision.submittedAt.toISOString(),
      });
      return { revisionId: revision.id, revisionNo: revision.revisionNo };
    });
  }
}
