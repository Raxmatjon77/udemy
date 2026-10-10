import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { SalesSummaryQuery } from '@udemy/contracts';

import { commerceApi } from './commerce-api';

/** Query keys of instructor commerce (one place, so invalidation stays consistent). */
export const commerceKeys = {
  pricing: (courseId: string) => ['course', courseId, 'pricing'] as const,
  coupons: (courseId: string) => ['course', courseId, 'coupons'] as const,
  salesAll: ['instructor', 'sales'] as const,
  salesSummary: (range: SalesSummaryQuery) =>
    ['instructor', 'sales', 'summary', range.from, range.to] as const,
  recentSales: ['instructor', 'sales', 'recent'] as const,
};

export function useCoursePricing(courseId: string) {
  return useQuery({
    queryKey: commerceKeys.pricing(courseId),
    queryFn: () => commerceApi.pricing(courseId),
  });
}

/** Coupon pages, newest first (keyset). */
export function useCourseCoupons(courseId: string) {
  return useInfiniteQuery({
    queryKey: commerceKeys.coupons(courseId),
    queryFn: ({ pageParam }) => commerceApi.coupons(courseId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function useSalesSummary(range: SalesSummaryQuery) {
  return useQuery({
    queryKey: commerceKeys.salesSummary(range),
    queryFn: () => commerceApi.salesSummary(range),
  });
}

/** Recent sales, `paidAt DESC, id DESC` (keyset). */
export function useRecentSales() {
  return useInfiniteQuery({
    queryKey: commerceKeys.recentSales,
    queryFn: ({ pageParam }) => commerceApi.recentSales({ cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}
