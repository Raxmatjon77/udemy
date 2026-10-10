import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CourseLandingView } from '@/components/catalog/course-landing';
import { JsonLd } from '@/components/catalog/json-ld';
import { appOrigin, cspNonce } from '@/lib/catalog/request';
import { courseJsonLd, courseMetadata } from '@/lib/catalog/seo';
import { getCourseLanding } from '@/lib/catalog/server';

/**
 * `/course/{slug}`: the public landing page of a published course (design §10).
 *
 * Rendered per request, not ISR: the CSP nonce makes every page dynamic (design §14, P2-T14).
 * `getCourseLanding` is memoised per request, so the metadata and the page share one API call.
 * Unknown, unpublished or taken-down slugs are a 404 (the API answers `course_not_found`).
 */
export async function generateMetadata({ params }: PageProps<'/course/[slug]'>): Promise<Metadata> {
  const { slug } = await params;
  const landing = await getCourseLanding(slug);
  if (!landing) return { title: 'Course not found', robots: { index: false } };
  return courseMetadata(landing, appOrigin());
}

export default async function CoursePage({ params }: PageProps<'/course/[slug]'>) {
  const { slug } = await params;
  const landing = await getCourseLanding(slug);
  if (!landing) notFound();

  return (
    <>
      <JsonLd data={courseJsonLd(landing, appOrigin())} nonce={await cspNonce()} />
      <CourseLandingView landing={landing} />
    </>
  );
}
