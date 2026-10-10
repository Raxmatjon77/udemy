import type { ExperienceLevel, InstructorApplicationStatus } from '@udemy/contracts';

export const EXPERIENCE_LABEL: Record<ExperienceLevel, string> = {
  NONE: 'I have not taught before',
  INFORMAL: 'Informally (friends, colleagues, mentoring)',
  PROFESSIONAL: 'Professionally (classes, workshops)',
  ONLINE: 'Online (videos, courses, live streams)',
};

export const STATUS_LABEL: Record<InstructorApplicationStatus, string> = {
  PENDING: 'Under review',
  APPROVED: 'Approved',
  REJECTED: 'Not approved',
  WITHDRAWN: 'Withdrawn',
};

export const STATUS_BADGE: Record<
  InstructorApplicationStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  PENDING: 'secondary',
  APPROVED: 'default',
  REJECTED: 'destructive',
  WITHDRAWN: 'outline',
};
