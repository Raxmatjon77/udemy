import type {
  AccountStatus,
  CourseBadge,
  CourseStatus,
  ExperienceLevel,
  InstructorApplicationStatus,
  LectureType,
  MediaAssetStatus,
  RevisionDiffField,
  RevisionKind,
  RevisionState,
  Role,
} from '@udemy/contracts';

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export const APPLICATION_STATUS_LABEL: Record<InstructorApplicationStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

export const APPLICATION_STATUS_BADGE: Record<InstructorApplicationStatus, BadgeVariant> = {
  PENDING: 'secondary',
  APPROVED: 'default',
  REJECTED: 'destructive',
  WITHDRAWN: 'outline',
};

export const EXPERIENCE_LABEL: Record<ExperienceLevel, string> = {
  NONE: 'No teaching experience',
  INFORMAL: 'Informal',
  PROFESSIONAL: 'Professional',
  ONLINE: 'Online',
};

export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  ACTIVE: 'Active',
  BANNED: 'Banned',
};

export const ROLE_LABEL: Record<Role, string> = {
  STUDENT: 'Student',
  INSTRUCTOR: 'Instructor',
  ADMIN: 'Admin',
};

export const COURSE_STATUS_LABEL: Record<CourseStatus, string> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  PUBLISHED: 'Published',
  REJECTED: 'Rejected',
  ARCHIVED: 'Archived',
};

/** The derived badge shown in course lists (status + pending/live revision pointers). */
export const COURSE_BADGE_LABEL: Record<CourseBadge, string> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  REJECTED: 'Rejected',
  LIVE: 'Live',
  LIVE_UPDATE_PENDING: 'Live, update in review',
  LIVE_UPDATE_REJECTED: 'Live, update rejected',
  ARCHIVED: 'Archived',
};

export const COURSE_BADGE_VARIANT: Record<CourseBadge, BadgeVariant> = {
  DRAFT: 'outline',
  IN_REVIEW: 'secondary',
  REJECTED: 'destructive',
  LIVE: 'default',
  LIVE_UPDATE_PENDING: 'default',
  LIVE_UPDATE_REJECTED: 'default',
  ARCHIVED: 'outline',
};

export const REVISION_KIND_LABEL: Record<RevisionKind, string> = {
  INITIAL: 'New course',
  UPDATE: 'Update',
};

export const REVISION_STATE_LABEL: Record<RevisionState, string> = {
  PENDING: 'Pending review',
  LIVE: 'Live',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  SUPERSEDED: 'Superseded',
};

export const LECTURE_TYPE_LABEL: Record<LectureType, string> = {
  VIDEO: 'Video',
  ARTICLE: 'Article',
  RESOURCE: 'Resource',
  QUIZ: 'Quiz',
};

export const MEDIA_STATUS_LABEL: Record<MediaAssetStatus, string> = {
  UPLOADING: 'Uploading',
  UPLOADED: 'Uploaded',
  PROCESSING: 'Processing',
  READY: 'Ready',
  FAILED: 'Failed',
  ABORTED: 'Aborted',
};

/** Header fields compared by the revision diff. */
export const REVISION_DIFF_FIELD_LABEL: Record<RevisionDiffField, string> = {
  title: 'Title',
  subtitle: 'Subtitle',
  descriptionMd: 'Description',
  language: 'Language',
  level: 'Level',
  categoryId: 'Category',
  thumbnailAssetId: 'Thumbnail',
  outcomes: 'Learning outcomes',
  requirements: 'Requirements',
};
