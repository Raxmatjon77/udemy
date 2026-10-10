import { Injectable } from '@nestjs/common';
import type { SignedUrl, ThumbnailVariant } from '@udemy/contracts';
import { MediaFacade } from '../../../media';
import { CourseNotFound, RevisionNotFound, ThumbnailNotFound } from '../../domain/catalog.errors';
import type { LectureSource } from '../lecture-access.authorizer';
import { CourseRepository } from '../ports/course.repository';
import { PublicCatalogRepository } from '../ports/public-catalog.repository';

export interface CourseThumbnailInput {
  /**
   * `live`: the public image of a PUBLISHED course (archived: 404).
   * `working`: the builder's current thumbnail (route policy: owner or admin).
   * `revision`: the thumbnail frozen in a revision (route: `course:read:any`).
   */
  readonly source: LectureSource;
  readonly variant: ThumbnailVariant;
}

/**
 * `GetCourseImage` (design §5): a presigned GET (`image/jpeg`, TTL `MEDIA_IMAGE_URL_TTL_S`) of
 * a re-encoded thumbnail variant (`w750` / `w480`, D11). The web apps embed it through their
 * stable redirect route (`createSignedRedirectHandler`), never directly.
 *
 * Errors: 404 (no such course/revision, or no thumbnail), 409 `media_not_ready` while the
 * working-copy thumbnail is still uploading or processing.
 */
@Injectable()
export class GetCourseThumbnailQuery {
  constructor(
    private readonly publicCatalog: PublicCatalogRepository,
    private readonly courses: CourseRepository,
    private readonly media: MediaFacade,
  ) {}

  async execute(input: CourseThumbnailInput): Promise<SignedUrl> {
    return this.media.presignImage(await this.thumbnailAssetId(input.source), input.variant);
  }

  private async thumbnailAssetId(source: LectureSource): Promise<string> {
    switch (source.kind) {
      case 'live': {
        const course = await this.publicCatalog.findLiveCourse(source.courseId);
        if (course?.status !== 'PUBLISHED') throw new CourseNotFound();
        return course.thumbnailAssetId;
      }
      case 'working': {
        const course = await this.courses.findById(source.courseId);
        if (course === null) throw new CourseNotFound();
        if (course.thumbnailAssetId === null) throw new ThumbnailNotFound();
        return course.thumbnailAssetId;
      }
      case 'revision': {
        const header = await this.publicCatalog.findRevisionHeader(source.revisionId);
        if (header === null) throw new RevisionNotFound();
        return header.thumbnailAssetId;
      }
    }
  }
}
