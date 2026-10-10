import {
  COURSE_LANGUAGE_LABELS,
  COURSE_LEVEL_LABELS,
  type CourseLanguage,
  type CourseLevel,
  type LectureType,
  type ThumbnailVariant,
} from '@udemy/contracts';

/** Display helpers of the public catalog (isomorphic: server and client components). */

/** The stable same-origin image route (302 to a presigned MinIO URL, see app/media). */
export function thumbnailPath(courseId: string, variant: ThumbnailVariant = 'w480'): string {
  return `/media/course-thumbnail/${encodeURIComponent(courseId)}?variant=${variant}`;
}

/** Master playlist of a live preview lecture, through this app's BFF proxy. */
export function previewPlaylistPath(courseId: string, lectureId: string): string {
  return `/api/proxy/catalog/courses/${encodeURIComponent(courseId)}/lectures/${encodeURIComponent(lectureId)}/hls/master.m3u8`;
}

export function levelLabel(level: CourseLevel | null): string | null {
  return level ? COURSE_LEVEL_LABELS[level] : null;
}

export function languageLabel(language: CourseLanguage | null): string | null {
  return language ? COURSE_LANGUAGE_LABELS[language] : null;
}

/** Course totals: "3h 05m total", "45m total", "under 1m". */
export function formatTotalDuration(seconds: number): string {
  if (seconds <= 0) return '0m';
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 1) return 'under 1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/** A lecture length as a clock: "4:05", "1:02:03". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/** Spoken form of a clock for screen readers: "4 minutes 5 seconds". */
export function describeDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const parts: string[] = [];
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (sec || parts.length === 0) parts.push(`${sec} second${sec === 1 ? '' : 's'}`);
  return parts.join(' ');
}

export const LECTURE_TYPE_LABELS: Readonly<Record<LectureType, string>> = {
  VIDEO: 'Video',
  ARTICLE: 'Article',
  RESOURCE: 'Resource',
};

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
