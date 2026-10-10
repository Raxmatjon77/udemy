import { useQuery } from '@tanstack/react-query';
import {
  MeResponseSchema,
  type AdminCoursesQuery,
  type AdminUsersQuery,
  type InstructorApplicationStatus,
  type MeResponse,
} from '@udemy/contracts';

import { api } from './api';

/** TanStack Query keys of this app, in one place so invalidation stays consistent. */
export const queryKeys = {
  me: ['me'] as const,
  applications: ['admin', 'instructor-applications'] as const,
  applicationQueue: (status: InstructorApplicationStatus) =>
    ['admin', 'instructor-applications', 'queue', status] as const,
  application: (id: string) => ['admin', 'instructor-applications', 'detail', id] as const,
  users: ['admin', 'users'] as const,
  userSearch: (filters: Pick<AdminUsersQuery, 'q' | 'status' | 'role'>) =>
    ['admin', 'users', 'search', filters] as const,
  user: (id: string) => ['admin', 'users', 'detail', id] as const,
  courseReviews: ['admin', 'course-reviews'] as const,
  courseReviewQueue: ['admin', 'course-reviews', 'queue'] as const,
  courseReview: (revisionId: string) => ['admin', 'course-reviews', 'detail', revisionId] as const,
  courses: ['admin', 'courses'] as const,
  courseSearch: (filters: Pick<AdminCoursesQuery, 'q' | 'status' | 'ownerId'>) =>
    ['admin', 'courses', 'search', filters] as const,
  categories: ['admin', 'categories'] as const,
};

/** `GET /me`. `quiet`: a 401 means "signed out" instead of redirecting to login. */
export function useMe({
  enabled = true,
  quiet = false,
}: { enabled?: boolean; quiet?: boolean } = {}) {
  return useQuery<MeResponse>({
    queryKey: queryKeys.me,
    queryFn: () => api('/me', { schema: MeResponseSchema, quiet }),
    enabled,
  });
}
