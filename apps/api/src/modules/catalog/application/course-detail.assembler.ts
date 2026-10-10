import { Injectable } from '@nestjs/common';
import type { CourseDetail } from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import { courseBadge, isSlugEditable, isWorkingCopyLocked } from '../domain/course';
import { CourseReadinessEvaluator } from './course-readiness.evaluator';
import { CurriculumReader } from './curriculum-reader';
import { CourseLifecycleRepository } from './ports/course-lifecycle.repository';
import { type CourseRecord, CourseRepository } from './ports/course.repository';
import { UnpublishedChangesDetector } from './ports/unpublished-changes.detector';
import { toRevisionSummary } from './views';

/**
 * Builds `CourseDetail` (GET/PATCH /courses/:id and every action that answers with the
 * course): header, bullets, thumbnail state, lifecycle pointers, the latest decision, the
 * derived badge, readiness and `hasUnpublishedChanges`. Pass the write transaction to answer
 * with the state the write just produced.
 */
@Injectable()
export class CourseDetailAssembler {
  constructor(
    private readonly courses: CourseRepository,
    private readonly lifecycle: CourseLifecycleRepository,
    private readonly reader: CurriculumReader,
    private readonly readiness: CourseReadinessEvaluator,
    private readonly unpublished: UnpublishedChangesDetector,
  ) {}

  async build(course: CourseRecord, ex?: Executor): Promise<CourseDetail> {
    const bullets = await this.courses.getBullets(course.id, ex);
    const curriculum = await this.reader.load(course, ex);
    const readiness = await this.readiness.evaluate(course, ex, {
      curriculum,
      outcomeCount: bullets.outcomes.length,
    });
    const revisionIds = [course.pendingRevisionId, course.publishedRevisionId].filter(
      (id): id is string => id !== null,
    );
    const revisions = new Map(
      (await this.lifecycle.findRevisionSummaries(revisionIds, ex)).map((r) => [r.id, r]),
    );
    const decision = await this.lifecycle.findLatestDecision(course.id, ex);
    const pending =
      course.pendingRevisionId === null ? undefined : revisions.get(course.pendingRevisionId);
    const live =
      course.publishedRevisionId === null ? undefined : revisions.get(course.publishedRevisionId);

    return {
      id: course.id,
      ownerId: course.ownerId,
      slug: course.slug,
      slugEditable: isSlugEditable(course),
      title: course.title,
      subtitle: course.subtitle,
      descriptionMd: course.descriptionMd,
      language: course.language,
      level: course.level,
      categoryId: course.categoryId,
      thumbnailAssetId: course.thumbnailAssetId,
      thumbnail:
        course.thumbnailAssetId === null
          ? null
          : (curriculum.assets.get(course.thumbnailAssetId) ?? null),
      outcomes: [...bullets.outcomes],
      requirements: [...bullets.requirements],
      status: course.status,
      badge: courseBadge(course, decision),
      version: course.version,
      locked: isWorkingCopyLocked(course),
      pendingRevision: pending === undefined ? null : toRevisionSummary(pending),
      liveRevision: live === undefined ? null : toRevisionSummary(live),
      latestDecision:
        decision === null
          ? null
          : {
              action: decision.action,
              revisionId: decision.revisionId,
              revisionNo: decision.revisionNo,
              reason: decision.reason,
              decidedAt: decision.decidedAt.toISOString(),
            },
      readiness,
      hasUnpublishedChanges: await this.unpublished.hasUnpublishedChanges(course, ex),
      firstPublishedAt: course.firstPublishedAt?.toISOString() ?? null,
      createdAt: course.createdAt.toISOString(),
      updatedAt: course.updatedAt.toISOString(),
    };
  }
}
