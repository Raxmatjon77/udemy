import type {
  AccountStatus,
  ExperienceLevel,
  InstructorApplicationStatus,
  Role,
} from '@udemy/contracts';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

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
