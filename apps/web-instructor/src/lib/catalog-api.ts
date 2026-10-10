import {
  ArticleSchema,
  AssetViewSchema,
  CategoryTreeResponseSchema,
  CourseDetailSchema,
  CourseHistoryResponseSchema,
  CurriculumSchema,
  LectureDownloadResponseSchema,
  LectureSchema,
  MyCoursePageSchema,
  SectionSchema,
  SubmitCourseResponseSchema,
  type Article,
  type AssetView,
  type CategoryTreeResponse,
  type CourseDetail,
  type CourseHistoryResponse,
  type CourseStatus,
  type CreateCourseRequest,
  type CreateLectureRequest,
  type CreateSectionRequest,
  type Curriculum,
  type Lecture,
  type MyCoursePage,
  type ReorderCurriculumRequest,
  type Section,
  type SignedUrl,
  type SubmitCourseRequest,
  type ThumbnailVariant,
  type SubmitCourseResponse,
  type UpdateCourseRequest,
  type UpdateLectureRequest,
  type UpdateSectionRequest,
} from '@udemy/contracts';

import { api, queryString } from './api';

/*
 * Typed calls for the instructor course builder (design §8, "Instructor" and "Media" tables).
 * Every response is validated against its contracts schema, so a drifting API shows up as a
 * generic error instead of a broken screen. Paths are relative to `/api/proxy`.
 */

const enc = encodeURIComponent;
const course = (courseId: string) => `/courses/${enc(courseId)}`;
const lecture = (courseId: string, lectureId: string) =>
  `${course(courseId)}/lectures/${enc(lectureId)}`;

export const catalogApi = {
  /* ---- categories (public tree, active leaves only) ---- */
  categories: (): Promise<CategoryTreeResponse> =>
    api('/catalog/categories', { schema: CategoryTreeResponseSchema }),

  /* ---- my courses ---- */
  myCourses: (params: { status?: CourseStatus | undefined; cursor?: string | null }) =>
    api<MyCoursePage>(
      `/instructor/courses${queryString({ status: params.status, cursor: params.cursor, limit: 20 })}`,
      { schema: MyCoursePageSchema },
    ),
  createCourse: (body: CreateCourseRequest): Promise<CourseDetail> =>
    api('/instructor/courses', { method: 'POST', json: body, schema: CourseDetailSchema }),

  /* ---- course details ---- */
  course: (courseId: string): Promise<CourseDetail> =>
    api(course(courseId), { schema: CourseDetailSchema }),
  updateCourse: (courseId: string, body: UpdateCourseRequest): Promise<CourseDetail> =>
    api(course(courseId), { method: 'PATCH', json: body, schema: CourseDetailSchema }),
  setThumbnail: (courseId: string, assetId: string): Promise<CourseDetail> =>
    api(`${course(courseId)}/thumbnail`, {
      method: 'PUT',
      json: { assetId },
      schema: CourseDetailSchema,
    }),
  clearThumbnail: (courseId: string): Promise<CourseDetail> =>
    api(`${course(courseId)}/thumbnail`, { method: 'DELETE', schema: CourseDetailSchema }),
  /**
   * Same-origin image URL of the working-copy thumbnail (app/media/course-thumbnail, a 302 to a
   * presigned URL from `GET /courses/:id/thumbnail`). `assetId` is a cache key: a replaced image
   * gets a new URL, so a cached redirect never shows the old one.
   */
  thumbnailImageUrl: (courseId: string, assetId: string, variant: ThumbnailVariant = 'w480') =>
    `/media/course-thumbnail/${enc(courseId)}?variant=${variant}&v=${enc(assetId)}`,

  /* ---- curriculum ---- */
  curriculum: (courseId: string): Promise<Curriculum> =>
    api(`${course(courseId)}/curriculum`, { schema: CurriculumSchema }),
  reorder: (courseId: string, body: ReorderCurriculumRequest): Promise<Curriculum> =>
    api(`${course(courseId)}/curriculum/order`, {
      method: 'PUT',
      json: body,
      schema: CurriculumSchema,
    }),
  addSection: (courseId: string, body: CreateSectionRequest): Promise<Section> =>
    api(`${course(courseId)}/sections`, { method: 'POST', json: body, schema: SectionSchema }),
  updateSection: (courseId: string, sectionId: string, body: UpdateSectionRequest) =>
    api<Section>(`${course(courseId)}/sections/${enc(sectionId)}`, {
      method: 'PATCH',
      json: body,
      schema: SectionSchema,
    }),
  deleteSection: (courseId: string, sectionId: string): Promise<void> =>
    api(`${course(courseId)}/sections/${enc(sectionId)}`, { method: 'DELETE' }),
  addLecture: (courseId: string, sectionId: string, body: CreateLectureRequest) =>
    api<Lecture>(`${course(courseId)}/sections/${enc(sectionId)}/lectures`, {
      method: 'POST',
      json: body,
      schema: LectureSchema,
    }),
  updateLecture: (courseId: string, lectureId: string, body: UpdateLectureRequest) =>
    api<Lecture>(lecture(courseId, lectureId), {
      method: 'PATCH',
      json: body,
      schema: LectureSchema,
    }),
  deleteLecture: (courseId: string, lectureId: string): Promise<void> =>
    api(lecture(courseId, lectureId), { method: 'DELETE' }),
  article: (courseId: string, lectureId: string): Promise<Article> =>
    api(`${lecture(courseId, lectureId)}/article`, { schema: ArticleSchema }),
  saveArticle: (courseId: string, lectureId: string, bodyMd: string): Promise<Article> =>
    api(`${lecture(courseId, lectureId)}/article`, {
      method: 'PUT',
      json: { bodyMd },
      schema: ArticleSchema,
    }),
  attachMedia: (courseId: string, lectureId: string, assetId: string): Promise<Lecture> =>
    api(`${lecture(courseId, lectureId)}/media`, {
      method: 'PUT',
      json: { assetId },
      schema: LectureSchema,
    }),
  detachMedia: (courseId: string, lectureId: string): Promise<Lecture> =>
    api(`${lecture(courseId, lectureId)}/media`, { method: 'DELETE', schema: LectureSchema }),
  /** `GET /courses/:c/lectures/:l/download` (working copy, owner or admin): 409 while not READY. */
  download: (courseId: string, lectureId: string): Promise<SignedUrl> =>
    api(`${lecture(courseId, lectureId)}/download`, { schema: LectureDownloadResponseSchema }),
  /** Same-origin master playlist of the instructor's own (working-copy) lecture video. */
  previewPlaylistUrl: (courseId: string, lectureId: string): string =>
    `/api/proxy${lecture(courseId, lectureId)}/preview/hls/master.m3u8`,

  /* ---- lifecycle (P2-T10) ---- */
  submit: (courseId: string, body: SubmitCourseRequest): Promise<SubmitCourseResponse> =>
    api(`${course(courseId)}/submit`, {
      method: 'POST',
      json: body,
      schema: SubmitCourseResponseSchema,
    }),
  withdraw: (courseId: string): Promise<CourseDetail> =>
    api(`${course(courseId)}/withdraw`, { method: 'POST', json: {}, schema: CourseDetailSchema }),
  history: (courseId: string): Promise<CourseHistoryResponse> =>
    api(`${course(courseId)}/history`, { schema: CourseHistoryResponseSchema }),

  /* ---- media ---- */
  asset: (assetId: string): Promise<AssetView> =>
    api(`/media/assets/${enc(assetId)}`, { schema: AssetViewSchema }),
};
