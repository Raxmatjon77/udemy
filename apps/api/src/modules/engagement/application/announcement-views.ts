import type { Announcement, AnnouncementQuota, PersonRef } from '@udemy/contracts';
import type { AnnouncementQuotaState, AnnouncementRecord } from '../domain/announcement';
import { personOf } from './people';

export function toAnnouncement(
  a: AnnouncementRecord,
  people: ReadonlyMap<string, PersonRef>,
): Announcement {
  return {
    id: a.id,
    courseId: a.courseId,
    title: a.title,
    bodyMd: a.bodyMd,
    author: personOf(people, a.authorId),
    sendEmail: a.sendEmail,
    createdAt: a.createdAt.toISOString(),
  };
}

export function toAnnouncementQuota(quota: AnnouncementQuotaState): AnnouncementQuota {
  return {
    limit: quota.limit,
    used: quota.used,
    windowDays: quota.windowDays,
    nextAvailableAt: quota.nextAvailableAt === null ? null : quota.nextAvailableAt.toISOString(),
  };
}
