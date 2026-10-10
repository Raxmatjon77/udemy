import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  MEDIA_TERMINAL_STATUSES,
  type AssetView,
  type CourseDetail,
  type Curriculum,
  type MediaAssetStatus,
} from '@udemy/contracts';

import { catalogApi } from './catalog-api';

/** Query keys of the course builder (one place, so invalidation stays consistent). */
export const catalogKeys = {
  categories: ['catalog', 'categories'] as const,
  myCourses: (status: string) => ['instructor', 'courses', status] as const,
  myCoursesAll: ['instructor', 'courses'] as const,
  course: (courseId: string) => ['course', courseId] as const,
  curriculum: (courseId: string) => ['course', courseId, 'curriculum'] as const,
  history: (courseId: string) => ['course', courseId, 'history'] as const,
  article: (courseId: string, lectureId: string) =>
    ['course', courseId, 'article', lectureId] as const,
  asset: (assetId: string) => ['media', 'asset', assetId] as const,
};

/** How often a processing asset is polled (design §10 sequence: every 3 s). */
export const ASSET_POLL_MS = 3_000;

const TERMINAL: ReadonlySet<MediaAssetStatus> = new Set(MEDIA_TERMINAL_STATUSES);

export function isTerminal(status: MediaAssetStatus): boolean {
  return TERMINAL.has(status);
}

export function useCategories() {
  return useQuery({
    queryKey: catalogKeys.categories,
    queryFn: catalogApi.categories,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCourse(courseId: string) {
  return useQuery({
    queryKey: catalogKeys.course(courseId),
    queryFn: () => catalogApi.course(courseId),
  });
}

export function useCurriculum(courseId: string) {
  return useQuery({
    queryKey: catalogKeys.curriculum(courseId),
    queryFn: () => catalogApi.curriculum(courseId),
  });
}

export function useCourseHistory(courseId: string) {
  return useQuery({
    queryKey: catalogKeys.history(courseId),
    queryFn: () => catalogApi.history(courseId),
  });
}

/**
 * The live state of an asset: `initial` (embedded in the lecture or course) is shown at once,
 * then `GET /media/assets/:id` is polled every 3 s until READY / FAILED / ABORTED.
 */
export function useAssetStatus(initial: AssetView | null) {
  const assetId = initial?.id ?? '';
  return useQuery({
    queryKey: catalogKeys.asset(assetId),
    queryFn: () => catalogApi.asset(assetId),
    enabled: initial !== null && !isTerminal(initial.status),
    ...(initial ? { initialData: initial, initialDataUpdatedAt: 0 } : {}),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && isTerminal(status) ? false : ASSET_POLL_MS;
    },
    refetchIntervalInBackground: false,
  });
}

/** Every write bumps `courses.version` and may change readiness: refresh both views. */
export function invalidateCourse(queryClient: QueryClient, courseId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: catalogKeys.course(courseId), exact: true });
}

export function setCourseData(queryClient: QueryClient, course: CourseDetail): void {
  queryClient.setQueryData(catalogKeys.course(course.id), course);
  void queryClient.invalidateQueries({ queryKey: catalogKeys.myCoursesAll });
}

export function setCurriculumData(queryClient: QueryClient, curriculum: Curriculum): void {
  queryClient.setQueryData(catalogKeys.curriculum(curriculum.courseId), curriculum);
}
