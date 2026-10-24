import type {
  CourseBadge,
  CourseReadinessIssue,
  CourseStatus,
  CourseTransitionAction,
  LectureType,
  MediaAssetStatus,
} from '@udemy/contracts';

import { formatMinutes } from './format';

/** "My courses" badge wording and look (design §5 `ListMyCourses`). */
export const COURSE_BADGE_LABELS: Readonly<Record<CourseBadge, string>> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  REJECTED: 'Changes requested',
  LIVE: 'Live',
  LIVE_UPDATE_PENDING: 'Live · update in review',
  LIVE_UPDATE_REJECTED: 'Live · update rejected',
  ARCHIVED: 'Archived',
};

export const COURSE_BADGE_VARIANTS: Readonly<
  Record<CourseBadge, 'default' | 'secondary' | 'destructive' | 'outline'>
> = {
  DRAFT: 'outline',
  IN_REVIEW: 'secondary',
  REJECTED: 'destructive',
  LIVE: 'default',
  LIVE_UPDATE_PENDING: 'secondary',
  LIVE_UPDATE_REJECTED: 'destructive',
  ARCHIVED: 'outline',
};

export const COURSE_STATUS_LABELS: Readonly<Record<CourseStatus, string>> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  PUBLISHED: 'Published',
  REJECTED: 'Rejected',
  ARCHIVED: 'Archived',
};

export const TRANSITION_LABELS: Readonly<Record<CourseTransitionAction, string>> = {
  CREATE: 'Created',
  SUBMIT: 'Submitted for review',
  WITHDRAW: 'Withdrawn from review',
  APPROVE: 'Approved',
  REJECT: 'Rejected',
  ARCHIVE: 'Archived',
  RESTORE: 'Restored',
  DELETE: 'Deleted',
};

export const LECTURE_TYPE_LABELS: Readonly<Record<LectureType, string>> = {
  VIDEO: 'Video',
  ARTICLE: 'Article',
  RESOURCE: 'Resource',
  QUIZ: 'Quiz',
};

export const MEDIA_STATUS_LABELS: Readonly<Record<MediaAssetStatus, string>> = {
  UPLOADING: 'Uploading',
  UPLOADED: 'Uploaded, waiting for processing',
  PROCESSING: 'Processing',
  READY: 'Ready',
  FAILED: 'Failed',
  ABORTED: 'Upload cancelled',
};

/** Where a readiness issue is fixed, so the checklist can link to it. */
export type BuilderTarget =
  | { tab: 'details'; field: DetailsField }
  | { tab: 'curriculum'; sectionId?: string; lectureId?: string };

export type DetailsField =
  | 'title'
  | 'subtitle'
  | 'descriptionMd'
  | 'language'
  | 'level'
  | 'categoryId'
  | 'thumbnail'
  | 'outcomes'
  | 'requirements';

function counts(issue: CourseReadinessIssue): string {
  if (issue.required === null) return '';
  return issue.actual === null
    ? ` (at least ${issue.required})`
    : ` (${issue.actual} of at least ${issue.required})`;
}

/** Human wording of one readiness issue, plus where to fix it. */
export function describeReadinessIssue(
  issue: CourseReadinessIssue,
  names: {
    section?: (id: string) => string | undefined;
    lecture?: (id: string) => string | undefined;
  } = {},
): { message: string; target: BuilderTarget } {
  const lecture = issue.lectureId ? names.lecture?.(issue.lectureId) : undefined;
  const section = issue.sectionId ? names.section?.(issue.sectionId) : undefined;
  const lectureRef = lecture ? `“${lecture}”` : 'A lecture';
  const curriculum: BuilderTarget = {
    tab: 'curriculum',
    ...(issue.sectionId ? { sectionId: issue.sectionId } : {}),
    ...(issue.lectureId ? { lectureId: issue.lectureId } : {}),
  };
  switch (issue.code) {
    case 'SUBTITLE_MISSING':
      return { message: 'Add a subtitle.', target: { tab: 'details', field: 'subtitle' } };
    case 'DESCRIPTION_TOO_SHORT':
      return {
        message: `Write a longer description${counts(issue)} characters.`,
        target: { tab: 'details', field: 'descriptionMd' },
      };
    case 'LANGUAGE_MISSING':
      return {
        message: 'Choose the course language.',
        target: { tab: 'details', field: 'language' },
      };
    case 'LEVEL_MISSING':
      return { message: 'Choose the course level.', target: { tab: 'details', field: 'level' } };
    case 'CATEGORY_MISSING':
      return { message: 'Choose a category.', target: { tab: 'details', field: 'categoryId' } };
    case 'CATEGORY_INACTIVE':
      return {
        message: 'The chosen category is no longer available. Choose another one.',
        target: { tab: 'details', field: 'categoryId' },
      };
    case 'THUMBNAIL_MISSING':
      return { message: 'Upload a course image.', target: { tab: 'details', field: 'thumbnail' } };
    case 'THUMBNAIL_NOT_READY':
      return {
        message: 'The course image is still processing or failed. Check it or upload another one.',
        target: { tab: 'details', field: 'thumbnail' },
      };
    case 'TOO_FEW_OUTCOMES':
      return {
        message: `Add more learning outcomes${counts(issue)}.`,
        target: { tab: 'details', field: 'outcomes' },
      };
    case 'NO_SECTIONS':
      return { message: 'Add at least one section.', target: curriculum };
    case 'SECTION_EMPTY':
      return {
        message: `${section ? `Section “${section}”` : 'A section'} has no lectures.`,
        target: curriculum,
      };
    case 'TOO_FEW_LECTURES':
      return { message: `Add more lectures${counts(issue)}.`, target: curriculum };
    case 'NOT_ENOUGH_VIDEO': {
      const need =
        issue.required === null
          ? ''
          : ` (${formatMinutes(issue.actual ?? 0)} of at least ${formatMinutes(issue.required)})`;
      return { message: `Add more video content${need}.`, target: curriculum };
    }
    case 'LECTURE_MEDIA_MISSING':
      return { message: `${lectureRef} has no uploaded file.`, target: curriculum };
    case 'LECTURE_MEDIA_NOT_READY':
      return {
        message: `${lectureRef}: the file is still processing or failed.`,
        target: curriculum,
      };
    case 'ARTICLE_TOO_SHORT':
      return {
        message: `${lectureRef}: the article is too short${counts(issue)}.`,
        target: curriculum,
      };
    // Phase 5 quiz readiness; TODO(P5-T7): link to the quiz editor once it exists.
    case 'QUIZ_EMPTY':
      return { message: `${lectureRef}: the quiz has no questions.`, target: curriculum };
    case 'QUIZ_QUESTION_INVALID':
      return {
        message: `${lectureRef}: a quiz question needs 2–6 options and its correct answer(s) marked.`,
        target: curriculum,
      };
  }
}
