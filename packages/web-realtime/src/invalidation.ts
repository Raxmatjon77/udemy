import type { RealtimeServerEvent } from '@udemy/contracts';

/** TanStack Query key roots the realtime hints invalidate (apps must use these prefixes). */
export const REALTIME_QUERY_ROOTS = {
  notifications: ['notifications'] as const,
  qa: (courseId: string) => ['qa', courseId] as const,
  asset: (assetId: string) => ['asset', assetId] as const,
} as const;

function field(payload: unknown, name: string): string | null {
  if (payload && typeof payload === 'object' && name in payload) {
    const value = (payload as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/** The query keys a (validated) server event invalidates (design §10). */
export function realtimeInvalidationKeys(
  event: RealtimeServerEvent,
  payload: unknown,
): readonly (readonly unknown[])[] {
  switch (event) {
    case 'notification.created':
    case 'notification.unread':
      return [REALTIME_QUERY_ROOTS.notifications];
    case 'qa.changed': {
      const courseId = field(payload, 'courseId');
      return courseId ? [REALTIME_QUERY_ROOTS.qa(courseId)] : [];
    }
    case 'media.changed': {
      const assetId = field(payload, 'assetId');
      return assetId ? [REALTIME_QUERY_ROOTS.asset(assetId)] : [];
    }
    case 'session.reauth':
      return [];
  }
}
