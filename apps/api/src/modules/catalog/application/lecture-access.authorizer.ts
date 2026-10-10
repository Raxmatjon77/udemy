import { Inject, Injectable } from '@nestjs/common';
import type { LectureType } from '@udemy/contracts';
import { COURSE_ENTITLEMENTS, type CourseEntitlements } from '../../../shared/entitlements';
import {
  CourseNotFound,
  LectureLocked,
  LectureNotFound,
  LectureTypeMismatch,
  RevisionNotFound,
} from '../domain/catalog.errors';
import {
  canInspectRevision,
  canPreviewWorkingCopy,
  decideLiveAccess,
  LECTURE_TYPE_FOR_USE,
  type LectureUse,
  needsEntitlement,
  type PlaybackViewer,
} from '../domain/playback-access';
import { CourseRepository } from './ports/course.repository';
import { CurriculumRepository } from './ports/curriculum.repository';
import { PublicCatalogRepository } from './ports/public-catalog.repository';

/** Where the lecture is read from (design §5 `AuthorizeLecturePlayback`). */
export type LectureSource =
  | { readonly kind: 'live'; readonly courseId: string }
  | { readonly kind: 'working'; readonly courseId: string }
  | { readonly kind: 'revision'; readonly revisionId: string };

export interface LectureAccessRequest {
  readonly source: LectureSource;
  readonly lectureId: string;
  readonly use: LectureUse;
  readonly viewer: PlaybackViewer | null;
}

/** A lecture the viewer may consume, as stored in the requested source. */
export interface AuthorizedLecture {
  readonly courseId: string;
  readonly lectureId: string;
  readonly type: LectureType;
  readonly title: string;
  /** The attached asset (null: nothing attached in the working copy, or an ARTICLE). */
  readonly mediaAssetId: string | null;
  /** `use: 'article'` from a revision only; null otherwise. */
  readonly articleBodyMd: string | null;
}

const TYPE_MISMATCH_MESSAGES: Readonly<Record<LectureUse, string>> = {
  stream: 'Only video lectures can be played.',
  article: 'This lecture is not an article.',
  download: 'Only resource lectures can be downloaded.',
};

function assertTypeFor(use: LectureUse, type: LectureType): void {
  if (type !== LECTURE_TYPE_FOR_USE[use])
    throw new LectureTypeMismatch(TYPE_MISMATCH_MESSAGES[use]);
}

/**
 * The single place that decides whether a viewer may stream, read or download a lecture
 * (design §5 "Playback rules", §9 IDOR). Every lookup is scoped by its container: the lecture
 * must belong to THAT live revision, working copy or revision, otherwise 404, so a lecture id
 * of another course never resolves. Media rendering happens afterwards, on the asset id this
 * service returns (MediaFacade performs no authorization).
 *
 * Errors: 404 `course_not_found` / `lecture_not_found` / `not_found` (revision),
 * 422 `lecture_type_mismatch`, 403 `lecture_locked` (live only).
 */
@Injectable()
export class LectureAccessAuthorizer {
  constructor(
    private readonly publicCatalog: PublicCatalogRepository,
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    @Inject(COURSE_ENTITLEMENTS) private readonly entitlements: CourseEntitlements,
  ) {}

  authorize(request: LectureAccessRequest): Promise<AuthorizedLecture> {
    switch (request.source.kind) {
      case 'live':
        return this.live(request.source.courseId, request);
      case 'working':
        return this.working(request.source.courseId, request);
      case 'revision':
        return this.revision(request.source.revisionId, request);
    }
  }

  private async live(courseId: string, request: LectureAccessRequest): Promise<AuthorizedLecture> {
    const found = await this.publicCatalog.findLiveLecture(courseId, request.lectureId, {
      withArticle: request.use === 'article',
    });
    if (found === null) throw new CourseNotFound();
    const { course, lecture } = found;
    const facts = {
      courseStatus: course.status,
      ownerId: course.ownerId,
      lectureInLiveRevision: lecture !== null,
      isPreview: lecture?.isPreview ?? false,
      use: request.use,
      viewer: request.viewer,
    };
    const entitled =
      request.viewer !== null && needsEntitlement(facts)
        ? await this.entitlements.hasCourseAccess(request.viewer.userId, course.id)
        : false;
    const decision = decideLiveAccess({ ...facts, entitled });
    if (decision === 'COURSE_NOT_FOUND') throw new CourseNotFound();
    if (decision === 'LECTURE_NOT_FOUND' || lecture === null) throw new LectureNotFound();
    assertTypeFor(request.use, lecture.type);
    if (decision === 'LOCKED') throw new LectureLocked();
    return {
      courseId: course.id,
      lectureId: lecture.lectureId,
      type: lecture.type,
      title: lecture.title,
      mediaAssetId: lecture.mediaAssetId,
      articleBodyMd: lecture.articleBodyMd,
    };
  }

  private async working(
    courseId: string,
    request: LectureAccessRequest,
  ): Promise<AuthorizedLecture> {
    const course = await this.courses.findById(courseId);
    // Neither owner nor moderator (a misrouted policy): the course "does not exist".
    if (course === null || !canPreviewWorkingCopy(request.viewer, course.ownerId)) {
      throw new CourseNotFound();
    }
    const lecture = await this.curriculum.findLecture(course.id, request.lectureId);
    if (lecture === null) throw new LectureNotFound();
    assertTypeFor(request.use, lecture.type);
    return {
      courseId: course.id,
      lectureId: lecture.id,
      type: lecture.type,
      title: lecture.title,
      mediaAssetId: lecture.mediaAssetId,
      articleBodyMd: null,
    };
  }

  private async revision(
    revisionId: string,
    request: LectureAccessRequest,
  ): Promise<AuthorizedLecture> {
    if (!canInspectRevision(request.viewer)) throw new RevisionNotFound();
    const header = await this.publicCatalog.findRevisionHeader(revisionId);
    if (header === null) throw new RevisionNotFound();
    const lecture = await this.publicCatalog.findRevisionLecture(revisionId, request.lectureId, {
      withArticle: request.use === 'article',
    });
    if (lecture === null) throw new LectureNotFound();
    assertTypeFor(request.use, lecture.type);
    return {
      courseId: header.courseId,
      lectureId: lecture.lectureId,
      type: lecture.type,
      title: lecture.title,
      mediaAssetId: lecture.mediaAssetId,
      articleBodyMd: lecture.articleBodyMd,
    };
  }
}
