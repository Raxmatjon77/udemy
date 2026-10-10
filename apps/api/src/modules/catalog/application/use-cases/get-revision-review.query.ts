import { Injectable } from '@nestjs/common';
import type { RevisionReview, RevisionSection } from '@udemy/contracts';
import { MediaFacade } from '../../../media';
import { CourseNotFound, RevisionNotFound } from '../../domain/catalog.errors';
import { revisionState } from '../../domain/lifecycle';
import { diffRevisions } from '../../domain/revision-diff';
import { referencedAssetIds } from '../../domain/revision-snapshot';
import { CategoryRepository } from '../ports/category.repository';
import { CoursePeopleDirectory } from '../ports/course-people.directory';
import { CourseRepository } from '../ports/course.repository';
import { type RevisionRecord, RevisionRepository } from '../ports/revision.repository';
import { UNKNOWN_PERSON } from './get-course-history.query';

/** The snapshot's curriculum with positions and frozen durations (contract shape). */
function toRevisionSections(revision: RevisionRecord): RevisionSection[] {
  return revision.content.sections.map((section, sectionPosition) => ({
    id: section.id,
    position: sectionPosition,
    title: section.title,
    objective: section.objective,
    lectures: section.lectures.map((lecture, position) => ({
      id: lecture.id,
      sectionId: section.id,
      position,
      type: lecture.type,
      title: lecture.title,
      descriptionMd: lecture.descriptionMd,
      isPreview: lecture.isPreview,
      mediaAssetId: lecture.mediaAssetId,
      durationSeconds: revision.lectures.get(lecture.id)?.durationSeconds ?? null,
      articleBodyMd: lecture.articleBodyMd,
    })),
  }));
}

/**
 * `GetRevisionForReview` (admin, design §5): the full immutable snapshot of any revision (its
 * derived state, D1), a diff against the revision that was live before it (the latest
 * approved revision with a lower number; none for an INITIAL submission), the snapshot's
 * category with its depth-1 group (`parent`), and the views of
 * every asset it references (fresh state, for the reviewer's players). 404 `not_found` for an
 * unknown revision or a deleted course.
 */
@Injectable()
export class GetRevisionReviewQuery {
  constructor(
    private readonly courses: CourseRepository,
    private readonly revisions: RevisionRepository,
    private readonly categories: CategoryRepository,
    private readonly people: CoursePeopleDirectory,
    private readonly media: MediaFacade,
  ) {}

  async execute(revisionId: string): Promise<RevisionReview> {
    const revision = await this.revisions.findById(revisionId);
    if (revision === null) throw new RevisionNotFound();
    const course = await this.courses.findById(revision.courseId);
    if (course === null) throw new CourseNotFound();

    const decision = await this.revisions.findDecisionAction(revision.id);
    const baseId = await this.revisions.findPreviousApprovedId(course.id, revision.revisionNo);
    const base = baseId === null ? null : await this.revisions.findById(baseId);
    const category =
      revision.content.categoryId === null
        ? null
        : await this.categories.findById(revision.content.categoryId);
    const parent =
      category === null || category.parentId === null
        ? null
        : await this.categories.findById(category.parentId);
    const people = await this.people.findPeople([course.ownerId, revision.submittedBy]);
    const name = (id: string): string => people.get(id)?.displayName ?? UNKNOWN_PERSON;
    const content = revision.content;

    return {
      course: {
        id: course.id,
        slug: course.slug,
        status: course.status,
        version: course.version,
        owner: { id: course.ownerId, displayName: name(course.ownerId) },
        pendingRevisionId: course.pendingRevisionId,
        liveRevisionId: course.publishedRevisionId,
      },
      revision: {
        id: revision.id,
        courseId: revision.courseId,
        revisionNo: revision.revisionNo,
        kind: revision.kind,
        state: revisionState(course, revision.id, decision),
        contentHash: revision.contentHashHex,
        title: content.title,
        subtitle: content.subtitle,
        descriptionMd: content.descriptionMd,
        language: content.language,
        level: content.level,
        category:
          category === null
            ? null
            : {
                id: category.id,
                slug: category.slug,
                name: category.name,
                ...(parent === null
                  ? {}
                  : { parent: { id: parent.id, slug: parent.slug, name: parent.name } }),
              },
        thumbnailAssetId: content.thumbnailAssetId,
        outcomes: [...content.outcomes],
        requirements: [...content.requirements],
        sections: toRevisionSections(revision),
        submittedBy: { id: revision.submittedBy, displayName: name(revision.submittedBy) },
        submitterNote: revision.submitterNote,
        submittedAt: revision.submittedAt.toISOString(),
      },
      diff: diffRevisions(content, base === null ? null : { id: base.id, content: base.content }),
      assets: await this.media.getAssets(referencedAssetIds(content)),
    };
  }
}
