import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CourseLandingView } from '@/components/catalog/course-landing';
import { JsonLd } from '@/components/catalog/json-ld';
import { appOrigin, cspNonce } from '@/lib/catalog/request';
import { courseJsonLd, courseMetadata } from '@/lib/catalog/seo';
import { getSession } from '@/lib/auth/session';
import { getCourseLanding } from '@/lib/catalog/server';
import { priceForCourse } from '@/lib/commerce/server';

/**
 * `/course/{slug}`: the public landing page of a published course (design §10).
 *
 * Rendered per request, not ISR: the CSP nonce makes every page dynamic (design §14, P2-T14).
 * `getCourseLanding` is memoised per request, so the metadata and the page share one API call.
 * Unknown, unpublished or taken-down slugs are a 404 (the API answers `course_not_found`).
 * Phase 4: the price comes from the public prices endpoint (anonymous, like the landing); what
 * this visitor may do with it (cart, enrolled, owner) is the client `PurchaseBox`.
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
  const [price, session] = await Promise.all([priceForCourse(landing.id), getSession()]);

  return (
    <>
      <JsonLd data={courseJsonLd(landing, appOrigin())} nonce={await cspNonce()} />
      <CourseLandingView landing={landing} price={price} signedIn={session !== null} />
    </>
  );
}
