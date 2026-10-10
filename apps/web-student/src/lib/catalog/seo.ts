import type { CourseLanding } from '@udemy/contracts';
import type { Metadata } from 'next';

import { levelLabel, thumbnailPath } from './format';

/**
 * SEO for the course landing page: `generateMetadata` output and the schema.org `Course`
 * JSON-LD. Pure functions of the landing data and this app's public origin (`APP_ORIGIN`),
 * so every URL in them is absolute and canonical.
 */

export const SITE_NAME = 'Udemy';
const DESCRIPTION_MAX = 160;

/** The w750 thumbnail as rendered by the transcoder (apps/transcoder media-pipeline). */
export const OG_IMAGE_SIZE = { width: 750, height: 422 } as const;

export function courseUrl(origin: string, slug: string): string {
  return `${origin}/course/${encodeURIComponent(slug)}`;
}

/** Markdown reduced to plain text, good enough for a meta description. */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Subtitle first (written as a pitch), else the start of the description. */
export function courseDescription(landing: CourseLanding): string {
  const text =
    landing.subtitle?.trim() ||
    (landing.descriptionMd ? markdownToPlainText(landing.descriptionMd) : '') ||
    `${landing.title}: an online course on ${SITE_NAME}.`;
  return truncate(text, DESCRIPTION_MAX);
}

export function courseMetadata(landing: CourseLanding, origin: string): Metadata {
  const url = courseUrl(origin, landing.slug);
  const description = courseDescription(landing);
  const image = {
    url: `${origin}${thumbnailPath(landing.id, 'w750')}`,
    ...OG_IMAGE_SIZE,
    alt: landing.title,
  };
  return {
    title: landing.title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      url,
      title: landing.title,
      description,
      images: [image],
      ...(landing.language ? { locale: landing.language.replace('-', '_') } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: landing.title,
      description,
      images: [image.url],
    },
  };
}

/** ISO 8601 duration of the video content (`PT3H5M`), or undefined when there is none. */
export function isoDuration(seconds: number): string | undefined {
  const minutes = Math.round(seconds / 60);
  if (minutes <= 0) return undefined;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `PT${hours ? `${hours}H` : ''}${rest ? `${rest}M` : ''}`;
}

/**
 * schema.org `Course` (https://schema.org/Course, Google "Course info" rich results). No
 * `offers`: there are no prices before Phase 4. The instructor is omitted when the API hides
 * them (banned or unknown).
 */
export function courseJsonLd(landing: CourseLanding, origin: string): Record<string, unknown> {
  const url = courseUrl(origin, landing.slug);
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Course',
    '@id': url,
    url,
    name: landing.title,
    description: courseDescription(landing),
    image: `${origin}${thumbnailPath(landing.id, 'w750')}`,
    provider: { '@type': 'Organization', name: SITE_NAME, sameAs: origin },
    datePublished: landing.publishedAt,
    dateModified: landing.lastUpdatedAt,
  };
  if (landing.language) data.inLanguage = landing.language;
  const level = levelLabel(landing.level);
  if (level) data.educationalLevel = level;
  if (landing.instructor) {
    data.instructor = { '@type': 'Person', name: landing.instructor.displayName };
    data.creator = data.instructor;
  }
  if (landing.outcomes.length > 0) data.teaches = landing.outcomes;
  if (landing.requirements.length > 0) data.coursePrerequisites = landing.requirements;
  const leaf = landing.categoryPath.at(-1);
  if (leaf) data.about = leaf.name;
  const duration = isoDuration(landing.totals.videoSeconds);
  if (duration) data.timeRequired = duration;
  return data;
}

/**
 * JSON for an inline `<script type="application/ld+json">`. `<`, `>` and `&` are escaped as
 * `<`…, so text such as `</script>` in a course title cannot end the element; U+2028/2029
 * are escaped for old JSON-in-JS parsers. The result is still valid JSON with the same value.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
