import { ANNOUNCEMENT_LIMITS } from '@udemy/contracts';

/** An instructor announcement (D18): immutable, soft delete. */
export interface AnnouncementRecord {
  readonly id: string;
  readonly courseId: string;
  readonly authorId: string;
  readonly title: string;
  readonly bodyMd: string;
  readonly sendEmail: boolean;
  readonly createdAt: Date;
}

export interface AnnouncementQuotaState {
  readonly limit: number;
  readonly used: number;
  readonly windowDays: number;
  /** When the next post is allowed; null while `used < limit`. */
  readonly nextAvailableAt: Date | null;
}

const DAY_MS = 86_400_000;

/**
 * The per-course quota (D18, P5-D11): at most `perCourse` announcements in any rolling
 * `windowDays`, deleted ones included (deleting does not refund quota). `createdAts` are the
 * creation times of the course's announcements inside the window. When the quota is used up,
 * the next post is allowed once the oldest post that keeps it full leaves the window.
 */
export function announcementQuota(createdAts: readonly Date[]): AnnouncementQuotaState {
  const { perCourse, windowDays } = ANNOUNCEMENT_LIMITS;
  const ascending = [...createdAts].sort((a, b) => a.getTime() - b.getTime());
  const used = ascending.length;
  const blocking = used >= perCourse ? ascending[used - perCourse] : undefined;
  return {
    limit: perCourse,
    used,
    windowDays,
    nextAvailableAt:
      blocking === undefined ? null : new Date(blocking.getTime() + windowDays * DAY_MS),
  };
}
