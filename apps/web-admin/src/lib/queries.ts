import { useQuery } from '@tanstack/react-query';
import {
  MeResponseSchema,
  type AdminCoursesQuery,
  type AdminOrdersQuery,
  type AdminUsersQuery,
  type InstructorApplicationStatus,
  type MeResponse,
  type RefundQueueStatus,
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
  orders: ['admin', 'orders'] as const,
  orderSearch: (filters: OrderFilters) => ['admin', 'orders', 'search', filters] as const,
  order: (id: string) => ['admin', 'orders', 'detail', id] as const,
  refunds: ['admin', 'refunds'] as const,
  refundQueue: (status: RefundQueueStatus) => ['admin', 'refunds', 'queue', status] as const,
  coupons: ['admin', 'coupons'] as const,
  userEnrollments: (userId: string) => ['admin', 'enrollments', 'user', userId] as const,
  pickerUsers: ['admin', 'picker', 'users'] as const,
  pickerCourses: ['admin', 'picker', 'courses'] as const,
};

/** The `/admin/orders` filters the UI drives (paging is the query's own). */
export type OrderFilters = Pick<
  AdminOrdersQuery,
  'q' | 'status' | 'userId' | 'courseId' | 'from' | 'to'
>;

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
