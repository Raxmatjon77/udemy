'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  COURSE_LANGUAGE_LABELS,
  COURSE_LEVEL_LABELS,
  RevisionReviewSchema,
  type AssetView,
  type RevisionCategory,
  type RevisionDiffField,
  type RevisionReview as RevisionReviewData,
} from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Badge } from '@udemy/ui/components/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@udemy/ui/components/card';
import { Skeleton } from '@udemy/ui/components/skeleton';

import { QueryError } from '@/components/query-error';
import { api } from '@/lib/api';
import { formatDateTime, formatTotalDuration } from '@/lib/format';
import {
  COURSE_STATUS_LABEL,
  MEDIA_STATUS_LABEL,
  REVISION_DIFF_FIELD_LABEL,
  REVISION_KIND_LABEL,
  REVISION_STATE_LABEL,
} from '@/lib/labels';
import { queryKeys } from '@/lib/queries';

import { ChangeBadges } from './change-badges';
import { CurriculumReview, RemovedItems } from './curriculum-review';
import { FieldChanges } from './field-changes';
import { ReviewDecision } from './review-decision';
import { indexDiff, type DiffIndex } from './revision-diff';

function Field({
  label,
  field,
  diff,
  children,
}: {
  label: string;
  field: RevisionDiffField;
  diff: DiffIndex;
  children: ReactNode;
}) {
  const changed = diff.fieldChanged(field);
  return (
    <div className="grid gap-1" data-field={field} data-changed={changed || undefined}>
      <dt className="flex items-center gap-2 font-medium">
        {label}
        <ChangeBadges changes={changed ? ['changed'] : []} />
      </dt>
      <dd className="text-muted-foreground">{children}</dd>
    </div>
  );
}

function BulletList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <>{empty}</>;
  return (
    <ul className="grid list-disc gap-1 pl-5 text-foreground">
      {items.map((item, i) => (
        <li key={`${i}-${item}`}>{item}</li>
      ))}
    </ul>
  );
}

/** The revision's pinned thumbnail through the admin signed-redirect image route. */
export function revisionThumbnailUrl(revisionId: string, variant: 'w480' | 'w750' = 'w480') {
  return `/media/revision-thumbnail/${encodeURIComponent(revisionId)}?variant=${variant}`;
}

function Thumbnail({
  revisionId,
  asset,
  assetId,
}: {
  revisionId: string;
  asset: AssetView | undefined;
  assetId: string | null;
}) {
  const [broken, setBroken] = useState(false);
  if (!assetId) return <>None</>;
  if (!asset) return <>Attached, but its details are unavailable.</>;
  const showImage = asset.status === 'READY' && !asset.purged && !broken;
  return (
    <span className="grid gap-2">
      {showImage ? (
        // A 302 to a short-lived presigned URL; next/image would have to fetch MinIO itself.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={revisionThumbnailUrl(revisionId)}
          alt="Course image of this revision"
          referrerPolicy="no-referrer"
          className="aspect-video w-full max-w-xs rounded-md border object-cover"
          onError={() => setBroken(true)}
        />
      ) : null}
      <span className="text-foreground">{asset.originalFilename}</span>
      <span>
        {MEDIA_STATUS_LABEL[asset.status]}
        {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
        {asset.purged ? ' · purged' : ''}
      </span>
      {broken ? <span className="text-xs">The image could not be loaded.</span> : null}
    </span>
  );
}

/** "Development › Web development" (the group is known for newer snapshots only). */
function CategoryName({ category }: { category: RevisionCategory | null }) {
  if (!category) return <>None</>;
  return (
    <span className="text-foreground">
      {category.parent ? (
        <span className="text-muted-foreground">{category.parent.name} › </span>
      ) : null}
      {category.name}
    </span>
  );
}

function DiffSummary({ review, diff }: { review: RevisionReviewData; diff: DiffIndex }) {
  const d = review.diff;
  if (!diff.hasBase) {
    return (
      <p className="text-sm text-muted-foreground">
        This is the first submission of this course, so there is no live version to compare with.
        Review everything below.
      </p>
    );
  }
  if (diff.isEmpty) {
    return <p className="text-sm text-muted-foreground">No differences from the live version.</p>;
  }
  const counts: Array<[string, number]> = [
    ['sections added', d.sections.added.length],
    ['sections changed', d.sections.changed.length],
    ['sections moved', d.sections.moved.length],
    ['sections removed', d.sections.removed.length],
    ['lectures added', d.lectures.added.length],
    ['lectures changed', d.lectures.changed.length],
    ['lectures moved', d.lectures.moved.length],
    ['lectures removed', d.lectures.removed.length],
  ];
  const nonZero = counts.filter(([, n]) => n > 0);
  return (
    <div className="grid gap-4 text-sm">
      {d.fieldChanges && d.fieldChanges.length > 0 ? (
        <div className="grid gap-2">
          <h3 className="font-medium">Changed details</h3>
          <FieldChanges
            changes={d.fieldChanges}
            revision={review.revision}
            assets={new Map(review.assets.map((asset) => [asset.id, asset]))}
          />
        </div>
      ) : d.changedFields.length > 0 ? (
        <div className="grid gap-1">
          <h3 className="font-medium">Changed details</h3>
          <ul className="flex flex-wrap gap-1" aria-label="Changed details">
            {d.changedFields.map((field) => (
              <li key={field}>
                <Badge variant="secondary">{REVISION_DIFF_FIELD_LABEL[field]}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {nonZero.length > 0 ? (
        <div className="grid gap-1">
          <h3 className="font-medium">Curriculum</h3>
          <p className="text-muted-foreground">
            {nonZero.map(([label, n]) => `${n} ${label}`).join(', ')}.
          </p>
        </div>
      ) : null}
      <RemovedItems diff={d} />
    </div>
  );
}

export function RevisionReview({
  revisionId,
  currentUserId,
}: {
  revisionId: string;
  currentUserId: string | null;
}) {
  const query = useQuery({
    queryKey: queryKeys.courseReview(revisionId),
    queryFn: () =>
      api(`/admin/course-revisions/${encodeURIComponent(revisionId)}`, {
        schema: RevisionReviewSchema,
      }),
  });

  if (query.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading revision" className="grid gap-4">
        <Skeleton className="h-9 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!query.data) {
    return <QueryError error={query.error} onRetry={() => void query.refetch()} />;
  }

  const review = query.data;
  const { course, revision } = review;
  const diff = indexDiff(review.diff);
  const assets = new Map(review.assets.map((asset) => [asset.id, asset]));
  const lectures = revision.sections.flatMap((section) => section.lectures);
  const videoSeconds = lectures.reduce((sum, l) => sum + (l.durationSeconds ?? 0), 0);
  const previews = lectures.filter((l) => l.isPreview).length;

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight break-words">
          {revision.title}
          <Badge variant={revision.kind === 'INITIAL' ? 'default' : 'secondary'}>
            {REVISION_KIND_LABEL[revision.kind]}
          </Badge>
          <Badge variant={revision.state === 'PENDING' ? 'outline' : 'secondary'}>
            {REVISION_STATE_LABEL[revision.state]}
          </Badge>
        </h1>
        <p className="text-sm text-muted-foreground">
          Revision {revision.revisionNo} by{' '}
          <Link href={`/users/${revision.submittedBy.id}`} className="underline underline-offset-4">
            {revision.submittedBy.displayName}
          </Link>{' '}
          · submitted{' '}
          <time dateTime={revision.submittedAt}>{formatDateTime(revision.submittedAt)}</time> ·
          course is {COURSE_STATUS_LABEL[course.status].toLowerCase()}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle asChild>
                <h2>Course details</h2>
              </CardTitle>
              <CardDescription>
                {lectures.length} lecture{lectures.length === 1 ? '' : 's'} in{' '}
                {revision.sections.length} section{revision.sections.length === 1 ? '' : 's'}
                {videoSeconds > 0 ? ` · ${formatTotalDuration(videoSeconds)} of video` : ''}
                {previews > 0 ? ` · ${previews} free preview${previews === 1 ? '' : 's'}` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-5 text-sm">
                <Field label="Title" field="title" diff={diff}>
                  <span className="text-foreground">{revision.title}</span>
                </Field>
                <Field label="Subtitle" field="subtitle" diff={diff}>
                  {revision.subtitle ?? 'None'}
                </Field>
                <div className="grid gap-5 sm:grid-cols-3">
                  <Field label="Category" field="categoryId" diff={diff}>
                    <CategoryName category={revision.category} />
                  </Field>
                  <Field label="Language" field="language" diff={diff}>
                    {revision.language ? COURSE_LANGUAGE_LABELS[revision.language] : 'None'}
                  </Field>
                  <Field label="Level" field="level" diff={diff}>
                    {revision.level ? COURSE_LEVEL_LABELS[revision.level] : 'None'}
                  </Field>
                </div>
                <Field label="Thumbnail" field="thumbnailAssetId" diff={diff}>
                  <Thumbnail
                    revisionId={revision.id}
                    assetId={revision.thumbnailAssetId}
                    asset={
                      revision.thumbnailAssetId ? assets.get(revision.thumbnailAssetId) : undefined
                    }
                  />
                </Field>
                <Field label="Description" field="descriptionMd" diff={diff}>
                  {revision.descriptionMd ? (
                    <div className="rounded-md border bg-background p-4 text-foreground">
                      <MarkdownView source={revision.descriptionMd} idPrefix="description-" />
                    </div>
                  ) : (
                    'None'
                  )}
                </Field>
                <Field label="What students will learn" field="outcomes" diff={diff}>
                  <BulletList items={revision.outcomes} empty="None" />
                </Field>
                <Field label="Requirements" field="requirements" diff={diff}>
                  <BulletList items={revision.requirements} empty="None" />
                </Field>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle asChild>
                <h2>Curriculum</h2>
              </CardTitle>
              <CardDescription>
                Play videos and read articles as students would see them.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CurriculumReview
                revisionId={revision.id}
                sections={revision.sections}
                assets={review.assets}
                diff={diff}
              />
            </CardContent>
          </Card>
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle asChild>
                <h2>Decision</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ReviewDecision review={review} currentUserId={currentUserId} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle asChild>
                <h2>Note from the instructor</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {revision.submitterNote ? (
                <p className="text-sm whitespace-pre-line">{revision.submitterNote}</p>
              ) : (
                <p className="text-sm text-muted-foreground">No note.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle asChild>
                <h2>Changes</h2>
              </CardTitle>
              <CardDescription>Compared with the version students see now.</CardDescription>
            </CardHeader>
            <CardContent>
              <DiffSummary review={review} diff={diff} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
