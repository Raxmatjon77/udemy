import { Injectable } from '@nestjs/common';
import type { CourseLanding, LandingSection } from '@udemy/contracts';
import { MediaFacade } from '../../../media';
import { UsersFacade } from '../../../users';
import { CourseNotFound } from '../../domain/catalog.errors';
import { PublicCatalogRepository } from '../ports/public-catalog.repository';
import { RevisionRepository } from '../ports/revision.repository';
import { CategoryDirectory, isServableThumbnail } from '../public-catalog-support';

/**
 * `GetCourseLanding` (design §5, public): the landing page of a PUBLISHED course, rendered
 * ONLY from its live revision snapshot. Edits that are not approved yet (the working copy, a
 * pending revision) never show here. Unknown, draft, archived or deleted: 404
 * `course_not_found`.
 *
 * The instructor card is `UsersFacade.getPublicProfile`, null for a banned or unknown owner.
 * Durations are the ones frozen at submit (`revision_lectures.duration_seconds`).
 */
@Injectable()
export class GetCourseLandingQuery {
  constructor(
    private readonly publicCatalog: PublicCatalogRepository,
    private readonly revisions: RevisionRepository,
    private readonly users: UsersFacade,
    private readonly media: MediaFacade,
  ) {}

  async execute(slug: string): Promise<CourseLanding> {
    const course = await this.publicCatalog.findPublishedBySlug(slug);
    if (course === null) throw new CourseNotFound();
    const revision = await this.revisions.findById(course.liveRevisionId, undefined, {
      articleBodies: false,
    });
    // A PUBLISHED course always has its live revision (FK); a race with a concurrent
    // approve is harmless (we render the revision we resolved).
    if (revision === null) throw new CourseNotFound();

    const [categories, instructor, thumbnails] = await Promise.all([
      this.publicCatalog.listCategories(),
      this.users.getPublicProfile(course.ownerId),
      this.media.getAssets([course.thumbnailAssetId]),
    ]);
    const content = revision.content;

    let lectureCount = 0;
    let videoSeconds = 0;
    const sections: LandingSection[] = content.sections.map((section) => ({
      id: section.id,
      title: section.title,
      objective: section.objective,
      lectures: section.lectures.map((lecture) => {
        const durationSeconds =
          lecture.type === 'VIDEO'
            ? (revision.lectures.get(lecture.id)?.durationSeconds ?? 0)
            : null;
        lectureCount += 1;
        videoSeconds += durationSeconds ?? 0;
        return {
          id: lecture.id,
          title: lecture.title,
          type: lecture.type,
          durationSeconds,
          isPreview: lecture.isPreview,
        };
      }),
    }));

    return {
      id: course.id,
      slug: course.slug,
      revisionId: revision.id,
      title: content.title,
      subtitle: content.subtitle,
      descriptionMd: content.descriptionMd,
      language: content.language,
      level: content.level,
      outcomes: [...content.outcomes],
      requirements: [...content.requirements],
      categoryPath: new CategoryDirectory(categories).path(content.categoryId),
      instructor,
      sections,
      totals: { sectionCount: sections.length, lectureCount, videoSeconds },
      publishedAt: course.firstPublishedAt.toISOString(),
      lastUpdatedAt: course.liveSince.toISOString(),
      hasThumbnail: thumbnails.some(isServableThumbnail),
    };
  }
}
