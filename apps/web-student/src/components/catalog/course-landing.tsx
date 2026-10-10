import type { CourseLanding, PublicProfile } from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';

import { categoryHref } from '@/lib/catalog/categories';
import { formatTotalDuration, languageLabel, levelLabel, pluralize } from '@/lib/catalog/format';
import { formatDate } from '@/lib/format';

import { Breadcrumbs } from './category-nav';
import { CourseThumbnail } from './course-thumbnail';
import { CurriculumOutline } from './curriculum-outline';

/**
 * The course landing page body (design §10): everything comes from the live revision the API
 * returns. Rendered on the server; the curriculum (preview dialog) is the only client island.
 */
export function CourseLandingView({ landing }: { landing: CourseLanding }) {
  const level = levelLabel(landing.level);
  const language = languageLabel(landing.language);
  const { totals } = landing;

  return (
    <main className="flex flex-col">
      <section aria-labelledby="course-title" className="bg-foreground text-background">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex flex-col gap-4">
            {landing.categoryPath.length > 0 ? (
              <div className="[&_a]:text-background/80 [&_a:hover]:text-background [&_ol]:text-background/70 [&_span[aria-current]]:text-background">
                <Breadcrumbs
                  items={[
                    { label: 'Courses', href: '/courses' },
                    ...landing.categoryPath.map((category) => ({
                      label: category.name,
                      href: categoryHref(category.slug),
                    })),
                  ]}
                />
              </div>
            ) : null}
            <h1
              id="course-title"
              className="text-3xl font-bold tracking-tight text-balance sm:text-4xl"
            >
              {landing.title}
            </h1>
            {landing.subtitle ? (
              <p className="text-lg text-pretty text-background/85">{landing.subtitle}</p>
            ) : null}
            {landing.instructor ? (
              <p className="text-sm text-background/85">
                Created by <span className="font-medium">{landing.instructor.displayName}</span>
              </p>
            ) : null}
            <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-background/85">
              {level ? (
                <div className="flex gap-1.5">
                  <dt>Level:</dt>
                  <dd className="font-medium">{level}</dd>
                </div>
              ) : null}
              {language ? (
                <div className="flex gap-1.5">
                  <dt>Language:</dt>
                  <dd className="font-medium" lang={landing.language ?? undefined}>
                    {language}
                  </dd>
                </div>
              ) : null}
              <div className="flex gap-1.5">
                <dt>Last updated:</dt>
                <dd className="font-medium">
                  <time dateTime={landing.lastUpdatedAt}>{formatDate(landing.lastUpdatedAt)}</time>
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="order-2 flex min-w-0 flex-col gap-10 lg:order-1">
          {landing.outcomes.length > 0 ? (
            <section aria-labelledby="outcomes-title" className="rounded-lg border p-6">
              <h2 id="outcomes-title" className="mb-4 text-xl font-semibold">
                What you&apos;ll learn
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {landing.outcomes.map((outcome, index) => (
                  <li key={index} className="flex gap-2 text-sm">
                    <CheckIcon />
                    <span>{outcome}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="curriculum-title" className="flex flex-col gap-3">
            <h2 id="curriculum-title" className="text-xl font-semibold">
              Course content
            </h2>
            <p data-testid="curriculum-totals" className="text-sm text-muted-foreground">
              {pluralize(totals.sectionCount, 'section')} ·{' '}
              {pluralize(totals.lectureCount, 'lecture')}
              {totals.videoSeconds > 0
                ? ` · ${formatTotalDuration(totals.videoSeconds)} total length`
                : ''}
            </p>
            <CurriculumOutline
              courseId={landing.id}
              courseTitle={landing.title}
              hasThumbnail={landing.hasThumbnail}
              sections={landing.sections}
            />
          </section>

          {landing.requirements.length > 0 ? (
            <section aria-labelledby="requirements-title">
              <h2 id="requirements-title" className="mb-3 text-xl font-semibold">
                Requirements
              </h2>
              <ul className="ml-5 list-disc space-y-1 text-sm">
                {landing.requirements.map((requirement, index) => (
                  <li key={index}>{requirement}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {landing.descriptionMd ? (
            <section aria-labelledby="description-title">
              <h2 id="description-title" className="mb-3 text-xl font-semibold">
                Description
              </h2>
              <MarkdownView source={landing.descriptionMd} idPrefix="description-" />
            </section>
          ) : null}

          {landing.instructor ? <InstructorCard instructor={landing.instructor} /> : null}
        </div>

        <aside
          aria-label="Enrollment"
          className="order-1 lg:sticky lg:top-6 lg:order-2 lg:self-start"
        >
          <div className="overflow-hidden rounded-lg border bg-card shadow-md">
            <CourseThumbnail
              courseId={landing.id}
              title={landing.title}
              hasThumbnail={landing.hasThumbnail}
              variant="w750"
              priority
              sizes="(min-width: 1024px) 20rem, 100vw"
            />
            <div className="flex flex-col gap-3 p-5">
              <EnrollmentCta />
              <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                <li>{pluralize(totals.lectureCount, 'lecture')}</li>
                {totals.videoSeconds > 0 ? (
                  <li>{formatTotalDuration(totals.videoSeconds)} of on-demand video</li>
                ) : null}
                {level ? <li>{level}</li> : null}
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

/** No prices or checkout before Phase 4 (design D4): a disabled CTA that says so. */
export function EnrollmentCta() {
  return (
    <div className="flex flex-col gap-2">
      <Button size="lg" disabled aria-describedby="enrollment-note" className="w-full">
        Enrollment opens soon
      </Button>
      <p id="enrollment-note" className="text-xs text-muted-foreground">
        Enrollment and pricing are not available yet. You can already watch the free previews.
      </p>
    </div>
  );
}

export function InstructorCard({ instructor }: { instructor: PublicProfile }) {
  return (
    <section
      aria-labelledby="instructor-title"
      data-testid="instructor-card"
      className="flex flex-col gap-3"
    >
      <h2 id="instructor-title" className="text-xl font-semibold">
        Instructor
      </h2>
      <div className="flex items-start gap-4">
        {/* Initials, not `avatarUrl`: an arbitrary avatar host is not in the CSP img-src. */}
        <span
          aria-hidden="true"
          className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-foreground"
        >
          {instructor.displayName
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase())
            .join('')}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-semibold">{instructor.displayName}</p>
          {instructor.headline ? (
            <p className="text-sm text-muted-foreground">{instructor.headline}</p>
          ) : null}
          {instructor.isInstructor ? (
            <Badge variant="outline" className="mt-1">
              Instructor
            </Badge>
          ) : null}
          {instructor.bio ? (
            <p className="mt-2 text-sm whitespace-pre-line">{instructor.bio}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 size-4 shrink-0 text-primary"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
