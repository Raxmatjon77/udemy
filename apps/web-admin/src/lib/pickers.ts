import { AdminCoursePageSchema, AdminUserPageSchema } from '@udemy/contracts';

import type { PickerOption } from '@/components/search-picker';

import { api, queryString } from './api';
import { COURSE_STATUS_LABEL } from './labels';

const LIMIT = 10;

/** `GET /admin/users?q=` (name or email, ≥ 3 characters) as picker options. */
export async function searchUsers(term: string): Promise<PickerOption[]> {
  const page = await api(`/admin/users${queryString({ q: term, limit: LIMIT })}`, {
    schema: AdminUserPageSchema,
  });
  return page.items.map((user) => ({ id: user.id, label: user.displayName, detail: user.email }));
}

/** `GET /admin/courses?q=` (title or slug, ≥ 3 characters) as picker options. */
export async function searchCourses(term: string): Promise<PickerOption[]> {
  const page = await api(`/admin/courses${queryString({ q: term, limit: LIMIT })}`, {
    schema: AdminCoursePageSchema,
  });
  return page.items.map((course) => ({
    id: course.id,
    label: course.title,
    detail: `${COURSE_STATUS_LABEL[course.status]} · ${course.owner.displayName}`,
  }));
}
