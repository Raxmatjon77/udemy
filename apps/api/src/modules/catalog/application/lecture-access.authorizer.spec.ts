import type { LectureType } from '@udemy/contracts';
import type { BrowseOptions } from '@udemy/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CourseEntitlements } from '../../../shared/entitlements';
import {
  CourseNotFound,
  LectureLocked,
  LectureNotFound,
  LectureTypeMismatch,
  RevisionNotFound,
} from '../domain/catalog.errors';
import type { PlaybackViewer } from '../domain/playback-access';
import { LectureAccessAuthorizer, type LectureAccessRequest } from './lecture-access.authorizer';
import type { CategoryRecord } from './ports/category.repository';
import type { CourseRecord, CourseRepository } from './ports/course.repository';
import type { CurriculumRepository, LectureRecord } from './ports/curriculum.repository';
import {
  type BrowseRecord,
  type LiveCourseRecord,
  type LiveCourseSummaryRecord,
  type LiveLectureLookup,
  PublicCatalogRepository,
  type LiveTotals,
  type RevisionHeaderRecord,
  type SnapshotLectureRecord,
} from './ports/public-catalog.repository';

/*
 * The playback authorization matrix (design §5, §9) on in-memory data: who may stream, read or
 * download a lecture of the live revision, the working copy or a revision under review, and
 * that a lecture is only ever found inside the container it was requested from.
 */

const COURSE = '00000000-0000-7000-8000-000000000001';
const OTHER_COURSE = '00000000-0000-7000-8000-000000000002';
const LIVE_REV = '00000000-0000-7000-8000-0000000000a1';
const PENDING_REV = '00000000-0000-7000-8000-0000000000a2';
const OWNER = '00000000-0000-7000-8000-0000000000f1';

const viewers = {
  anonymous: null,
  student: { userId: '00000000-0000-7000-8000-0000000000e1', isModerator: false },
  owner: { userId: OWNER, isModerator: false },
  otherInstructor: { userId: '00000000-0000-7000-8000-0000000000e2', isModerator: false },
  admin: { userId: '00000000-0000-7000-8000-0000000000e3', isModerator: true },
} as const satisfies Record<string, PlaybackViewer | null>;
type ViewerName = keyof typeof viewers;

const lectureIds = {
  previewVideo: '00000000-0000-7000-8000-0000000000b1',
  lockedVideo: '00000000-0000-7000-8000-0000000000b2',
  previewArticle: '00000000-0000-7000-8000-0000000000b3',
  resource: '00000000-0000-7000-8000-0000000000b4',
  /** Only in the working copy and the pending revision (an unapproved addition). */
  draftVideo: '00000000-0000-7000-8000-0000000000b5',
  /** A lecture of ANOTHER live course. */
  foreign: '00000000-0000-7000-8000-0000000000b6',
  /** A QUIZ lecture (Phase 5): live, in review and in the working copy. */
  quiz: '00000000-0000-7000-8000-0000000000b7',
} as const;

function snapshot(
  revisionId: string,
  lectureId: string,
  type: LectureType,
  isPreview: boolean,
): SnapshotLectureRecord {
  return {
    revisionId,
    lectureId,
    type,
    title: `${type} ${lectureId.slice(-2)}`,
    isPreview,
    mediaAssetId: type === 'ARTICLE' || type === 'QUIZ' ? null : `asset-${lectureId.slice(-2)}`,
    articleBodyMd: type === 'ARTICLE' ? `# Body of ${lectureId.slice(-2)}` : null,
  };
}

class InMemoryPublicCatalog extends PublicCatalogRepository {
  readonly courses = new Map<string, LiveCourseRecord>();
  readonly revisions = new Map<
    string,
    { header: RevisionHeaderRecord; lectures: SnapshotLectureRecord[] }
  >();

  findPublishedBySlug(): Promise<LiveCourseRecord | null> {
    throw new Error('not used');
  }
  findLiveCourse(courseId: string): Promise<LiveCourseRecord | null> {
    return Promise.resolve(this.courses.get(courseId) ?? null);
  }
  findLiveLecture(
    courseId: string,
    lectureId: string,
    options: { readonly withArticle: boolean },
  ): Promise<LiveLectureLookup | null> {
    const course = this.courses.get(courseId);
    if (course === undefined) return Promise.resolve(null);
    const lecture = this.revisions
      .get(course.liveRevisionId)
      ?.lectures.find((l) => l.lectureId === lectureId);
    return Promise.resolve({
      course,
      lecture:
        lecture === undefined
          ? null
          : { ...lecture, articleBodyMd: options.withArticle ? lecture.articleBodyMd : null },
    });
  }
  findRevisionHeader(revisionId: string): Promise<RevisionHeaderRecord | null> {
    return Promise.resolve(this.revisions.get(revisionId)?.header ?? null);
  }
  findRevisionLecture(
    revisionId: string,
    lectureId: string,
  ): Promise<SnapshotLectureRecord | null> {
    return Promise.resolve(
      this.revisions.get(revisionId)?.lectures.find((l) => l.lectureId === lectureId) ?? null,
    );
  }
  findLiveCourseSummaries(): Promise<LiveCourseSummaryRecord[]> {
    throw new Error('not used');
  }
  listLiveLectureIds(): Promise<string[]> {
    throw new Error('not used');
  }
  liveTotals(): Promise<ReadonlyMap<string, LiveTotals>> {
    throw new Error('not used');
  }
  browse(_options: BrowseOptions): Promise<BrowseRecord[]> {
    throw new Error('not used');
  }
  listCategories(): Promise<CategoryRecord[]> {
    throw new Error('not used');
  }
}

function liveCourse(
  id: string,
  status: 'PUBLISHED' | 'ARCHIVED',
  revisionId: string,
): LiveCourseRecord {
  return {
    id,
    slug: `course-${id.slice(-2)}`,
    ownerId: OWNER,
    status,
    liveRevisionId: revisionId,
    thumbnailAssetId: 'thumb',
    firstPublishedAt: new Date('2026-10-01T00:00:00Z'),
    liveSince: new Date('2026-10-01T00:00:00Z'),
  };
}

const workingCopy: CourseRecord = {
  id: COURSE,
  ownerId: OWNER,
  slug: 'course-01',
  title: 'Working title',
  subtitle: null,
  descriptionMd: null,
  language: null,
  level: null,
  categoryId: null,
  thumbnailAssetId: null,
  status: 'PUBLISHED',
  version: 7,
  pendingRevisionId: PENDING_REV,
  publishedRevisionId: LIVE_REV,
  firstPublishedAt: new Date('2026-10-01T00:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-10-02T00:00:00Z'),
};

function workingLecture(id: string, type: LectureType, mediaAssetId: string | null): LectureRecord {
  return {
    id,
    courseId: COURSE,
    sectionId: 'section',
    type,
    title: `working ${id.slice(-2)}`,
    descriptionMd: null,
    isPreview: false,
    position: 0,
    mediaAssetId,
    updatedAt: new Date(),
  };
}

describe('LectureAccessAuthorizer', () => {
  let catalog: InMemoryPublicCatalog;
  let hasCourseAccess: ReturnType<typeof vi.fn<CourseEntitlements['hasCourseAccess']>>;
  let authorizer: LectureAccessAuthorizer;

  beforeEach(() => {
    catalog = new InMemoryPublicCatalog();
    catalog.courses.set(COURSE, liveCourse(COURSE, 'PUBLISHED', LIVE_REV));
    catalog.courses.set(OTHER_COURSE, liveCourse(OTHER_COURSE, 'PUBLISHED', 'rev-other'));
    catalog.revisions.set(LIVE_REV, {
      header: { revisionId: LIVE_REV, courseId: COURSE, ownerId: OWNER, thumbnailAssetId: 't1' },
      lectures: [
        snapshot(LIVE_REV, lectureIds.previewVideo, 'VIDEO', true),
        snapshot(LIVE_REV, lectureIds.lockedVideo, 'VIDEO', false),
        snapshot(LIVE_REV, lectureIds.previewArticle, 'ARTICLE', true),
        snapshot(LIVE_REV, lectureIds.resource, 'RESOURCE', false),
        snapshot(LIVE_REV, lectureIds.quiz, 'QUIZ', false),
      ],
    });
    catalog.revisions.set(PENDING_REV, {
      header: { revisionId: PENDING_REV, courseId: COURSE, ownerId: OWNER, thumbnailAssetId: 't2' },
      lectures: [
        snapshot(PENDING_REV, lectureIds.lockedVideo, 'VIDEO', false),
        snapshot(PENDING_REV, lectureIds.draftVideo, 'VIDEO', false),
        snapshot(PENDING_REV, lectureIds.quiz, 'QUIZ', false),
      ],
    });
    catalog.revisions.set('rev-other', {
      header: {
        revisionId: 'rev-other',
        courseId: OTHER_COURSE,
        ownerId: OWNER,
        thumbnailAssetId: 't3',
      },
      lectures: [snapshot('rev-other', lectureIds.foreign, 'VIDEO', true)],
    });

    const courses = {
      findById: (id: string) => Promise.resolve(id === COURSE ? workingCopy : null),
    } as Pick<CourseRepository, 'findById'> as CourseRepository;
    const working = new Map<string, LectureRecord>([
      [lectureIds.lockedVideo, workingLecture(lectureIds.lockedVideo, 'VIDEO', 'asset-w2')],
      [lectureIds.draftVideo, workingLecture(lectureIds.draftVideo, 'VIDEO', null)],
      [lectureIds.resource, workingLecture(lectureIds.resource, 'RESOURCE', 'asset-w4')],
      [lectureIds.quiz, workingLecture(lectureIds.quiz, 'QUIZ', null)],
    ]);
    const curriculum = {
      findLecture: (courseId: string, lectureId: string) =>
        Promise.resolve(courseId === COURSE ? (working.get(lectureId) ?? null) : null),
    } as Pick<CurriculumRepository, 'findLecture'> as CurriculumRepository;
    hasCourseAccess = vi.fn<CourseEntitlements['hasCourseAccess']>(() => Promise.resolve(false));
    authorizer = new LectureAccessAuthorizer(catalog, courses, curriculum, { hasCourseAccess });
  });

  const live = (
    viewer: ViewerName,
    lectureId: string,
    use: LectureAccessRequest['use'] = 'stream',
    courseId = COURSE,
  ) =>
    authorizer.authorize({
      source: { kind: 'live', courseId },
      lectureId,
      use,
      viewer: viewers[viewer],
    });

  describe('live revision', () => {
    type Expect = 'allow' | typeof LectureLocked;
    const matrix: [ViewerName, Expect, Expect][] = [
      // viewer             preview video  locked video
      ['anonymous', 'allow', LectureLocked],
      ['student', 'allow', LectureLocked],
      ['otherInstructor', 'allow', LectureLocked],
      ['owner', 'allow', 'allow'],
      ['admin', 'allow', 'allow'],
    ];
    it.each(matrix)('%s: preview video %s, locked video %s', async (viewer, preview, locked) => {
      for (const [lectureId, expected] of [
        [lectureIds.previewVideo, preview],
        [lectureIds.lockedVideo, locked],
      ] as const) {
        if (expected === 'allow') {
          await expect(live(viewer, lectureId)).resolves.toMatchObject({
            courseId: COURSE,
            lectureId,
            mediaAssetId: `asset-${lectureId.slice(-2)}`,
          });
        } else {
          await expect(live(viewer, lectureId)).rejects.toBeInstanceOf(expected);
        }
      }
    });

    it('asks entitlements only for a signed-in viewer the rules do not already allow', async () => {
      await expect(live('anonymous', lectureIds.lockedVideo)).rejects.toBeInstanceOf(LectureLocked);
      await live('owner', lectureIds.lockedVideo);
      await live('admin', lectureIds.lockedVideo);
      await live('student', lectureIds.previewVideo);
      expect(hasCourseAccess).not.toHaveBeenCalled();

      await expect(live('student', lectureIds.lockedVideo)).rejects.toBeInstanceOf(LectureLocked);
      expect(hasCourseAccess).toHaveBeenCalledWith(viewers.student.userId, COURSE);

      hasCourseAccess.mockResolvedValue(true); // Phase 4: an enrolled student
      await expect(live('student', lectureIds.lockedVideo)).resolves.toMatchObject({
        lectureId: lectureIds.lockedVideo,
      });
    });

    it('a lecture of another course, or not (yet) in the live revision, is 404', async () => {
      for (const viewer of ['anonymous', 'owner', 'admin'] as const) {
        await expect(live(viewer, lectureIds.foreign)).rejects.toBeInstanceOf(LectureNotFound);
        await expect(live(viewer, lectureIds.draftVideo)).rejects.toBeInstanceOf(LectureNotFound);
      }
      await expect(
        live('anonymous', lectureIds.previewVideo, 'stream', OTHER_COURSE),
      ).rejects.toBeInstanceOf(LectureNotFound);
    });

    it('an unknown or unpublished course is 404 course_not_found', async () => {
      await expect(
        live('admin', lectureIds.previewVideo, 'stream', '00000000-0000-7000-8000-000000000099'),
      ).rejects.toBeInstanceOf(CourseNotFound);
    });

    it('an archived course is 404 for the public, readable for the owner and moderators', async () => {
      catalog.courses.set(COURSE, liveCourse(COURSE, 'ARCHIVED', LIVE_REV));
      await expect(live('anonymous', lectureIds.previewVideo)).rejects.toBeInstanceOf(
        CourseNotFound,
      );
      await expect(live('student', lectureIds.previewVideo)).rejects.toBeInstanceOf(CourseNotFound);
      await expect(live('owner', lectureIds.lockedVideo)).resolves.toBeDefined();
      await expect(live('admin', lectureIds.lockedVideo)).resolves.toBeDefined();
    });

    it('checks the lecture type for the use (422), before revealing the lock', async () => {
      await expect(live('anonymous', lectureIds.previewArticle)).rejects.toBeInstanceOf(
        LectureTypeMismatch,
      );
      await expect(live('anonymous', lectureIds.resource, 'stream')).rejects.toBeInstanceOf(
        LectureTypeMismatch,
      );
      await expect(live('anonymous', lectureIds.lockedVideo, 'article')).rejects.toBeInstanceOf(
        LectureTypeMismatch,
      );
    });

    it('articles follow the preview rules and carry their body', async () => {
      await expect(live('anonymous', lectureIds.previewArticle, 'article')).resolves.toMatchObject({
        articleBodyMd: `# Body of ${lectureIds.previewArticle.slice(-2)}`,
      });
    });

    it('downloads: never unlocked by a preview; owner, moderator or entitled only', async () => {
      catalog.revisions.get(LIVE_REV)?.lectures.push({
        ...snapshot(LIVE_REV, lectureIds.draftVideo, 'RESOURCE', false),
        isPreview: true, // impossible by the CHECK, but must still not unlock a download
      });
      await expect(live('anonymous', lectureIds.draftVideo, 'download')).rejects.toBeInstanceOf(
        LectureLocked,
      );
      await expect(live('student', lectureIds.resource, 'download')).rejects.toBeInstanceOf(
        LectureLocked,
      );
      await expect(live('owner', lectureIds.resource, 'download')).resolves.toBeDefined();
      await expect(live('admin', lectureIds.resource, 'download')).resolves.toBeDefined();
    });
  });

  describe('working copy', () => {
    const working = (viewer: ViewerName, lectureId: string, courseId = COURSE) =>
      authorizer.authorize({
        source: { kind: 'working', courseId },
        lectureId,
        use: 'stream',
        viewer: viewers[viewer],
      });

    it('owner and moderators get the WORKING asset, everyone else 404', async () => {
      await expect(working('owner', lectureIds.lockedVideo)).resolves.toMatchObject({
        mediaAssetId: 'asset-w2',
      });
      await expect(working('admin', lectureIds.lockedVideo)).resolves.toMatchObject({
        mediaAssetId: 'asset-w2',
      });
      for (const viewer of ['anonymous', 'student', 'otherInstructor'] as const) {
        await expect(working(viewer, lectureIds.lockedVideo)).rejects.toBeInstanceOf(
          CourseNotFound,
        );
      }
    });

    it('unapproved lectures are previewable; nothing attached means mediaAssetId null', async () => {
      await expect(working('owner', lectureIds.draftVideo)).resolves.toMatchObject({
        mediaAssetId: null,
      });
    });

    it('a lecture of another course is 404 (scoped by course)', async () => {
      await expect(working('owner', lectureIds.foreign)).rejects.toBeInstanceOf(LectureNotFound);
      await expect(working('owner', lectureIds.lockedVideo, OTHER_COURSE)).rejects.toBeInstanceOf(
        CourseNotFound,
      );
    });
  });

  describe('revision', () => {
    const revision = (viewer: ViewerName, revisionId: string, lectureId: string) =>
      authorizer.authorize({
        source: { kind: 'revision', revisionId },
        lectureId,
        use: 'stream',
        viewer: viewers[viewer],
      });

    it('moderators only; the owner cannot inspect revisions', async () => {
      await expect(revision('admin', PENDING_REV, lectureIds.draftVideo)).resolves.toMatchObject({
        courseId: COURSE,
        mediaAssetId: `asset-${lectureIds.draftVideo.slice(-2)}`,
      });
      for (const viewer of ['anonymous', 'student', 'owner'] as const) {
        await expect(revision(viewer, PENDING_REV, lectureIds.draftVideo)).rejects.toBeInstanceOf(
          RevisionNotFound,
        );
      }
    });

    it('the lecture must be in THAT revision', async () => {
      await expect(revision('admin', LIVE_REV, lectureIds.draftVideo)).rejects.toBeInstanceOf(
        LectureNotFound,
      );
      await expect(revision('admin', PENDING_REV, lectureIds.foreign)).rejects.toBeInstanceOf(
        LectureNotFound,
      );
      await expect(
        revision('admin', '00000000-0000-7000-8000-0000000000ff', lectureIds.lockedVideo),
      ).rejects.toBeInstanceOf(RevisionNotFound);
    });
  });

  describe('QUIZ lectures (Phase 5): no playback use at all', () => {
    const uses = ['stream', 'article', 'download'] as const;

    it('live: 422 lecture_type_mismatch for every use, even for the owner, admins and learners', async () => {
      hasCourseAccess.mockResolvedValue(true);
      for (const viewer of ['student', 'owner', 'admin'] as const) {
        for (const use of uses) {
          await expect(live(viewer, lectureIds.quiz, use)).rejects.toBeInstanceOf(
            LectureTypeMismatch,
          );
        }
      }
    });

    it('working copy and revision: 422 lecture_type_mismatch for every use', async () => {
      for (const use of uses) {
        await expect(
          authorizer.authorize({
            source: { kind: 'working', courseId: COURSE },
            lectureId: lectureIds.quiz,
            use,
            viewer: viewers.owner,
          }),
        ).rejects.toBeInstanceOf(LectureTypeMismatch);
        await expect(
          authorizer.authorize({
            source: { kind: 'revision', revisionId: PENDING_REV },
            lectureId: lectureIds.quiz,
            use,
            viewer: viewers.admin,
          }),
        ).rejects.toBeInstanceOf(LectureTypeMismatch);
      }
    });
  });
});
