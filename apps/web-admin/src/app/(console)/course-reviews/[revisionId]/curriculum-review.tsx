'use client';

import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  ErrorCode,
  RevisionLectureDownloadResponseSchema,
  type AssetView,
  type RevisionDiff,
  type RevisionLecture,
  type RevisionSection,
} from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';

import { LecturePlayer } from '@/components/lecture-player';
import { api } from '@/lib/api';
import { startDownload } from '@/lib/download';
import { formatDuration, formatTotalDuration } from '@/lib/format';
import { LECTURE_TYPE_LABEL, MEDIA_STATUS_LABEL } from '@/lib/labels';
import { problemMessage, type MessageOverrides } from '@/lib/problem';

import { ChangeBadges } from './change-badges';
import { RevisionQuizPreview } from './revision-quiz';
import type { DiffIndex } from './revision-diff';

/** Admin playback of a lecture inside a revision under review (design §8). */
export function revisionPlaylistUrl(revisionId: string, lectureId: string): string {
  return `/api/proxy/admin/course-revisions/${encodeURIComponent(revisionId)}/lectures/${encodeURIComponent(lectureId)}/hls/master.m3u8`;
}

/** `GET /admin/course-revisions/:rid/lectures/:lid/download` (a RESOURCE file of the revision). */
export function revisionDownloadPath(revisionId: string, lectureId: string): string {
  return `/admin/course-revisions/${encodeURIComponent(revisionId)}/lectures/${encodeURIComponent(lectureId)}/download`;
}

const DOWNLOAD_MESSAGES: MessageOverrides = {
  [ErrorCode.MediaNotReady]: 'This file is not ready to download (it is still being processed).',
  [ErrorCode.LectureTypeMismatch]: 'Only resource lectures have a file to download.',
  [ErrorCode.NotFound]: 'This file is not part of the revision any more (it may have been purged).',
  [ErrorCode.LectureNotFound]: 'This lecture is not part of this revision.',
  [ErrorCode.Forbidden]: 'You do not have permission to download files of courses under review.',
};

function ResourceDownload({
  revisionId,
  lecture,
  asset,
}: {
  revisionId: string;
  lecture: RevisionLecture;
  asset: AssetView;
}) {
  const download = useMutation({
    mutationFn: () =>
      api(revisionDownloadPath(revisionId, lecture.id), {
        schema: RevisionLectureDownloadResponseSchema,
      }),
    onSuccess: ({ url }) => startDownload(url),
  });
  const ready = asset.status === 'READY' && !asset.purged;
  return (
    <div className="grid gap-2">
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!ready || download.isPending}
          onClick={() => download.mutate()}
          aria-label={`Download ${asset.originalFilename}`}
        >
          {download.isPending ? 'Preparing download…' : 'Download file'}
        </Button>
      </div>
      {download.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(download.error, DOWNLOAD_MESSAGES)}
        </p>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function LecturePreview({
  revisionId,
  lecture,
  asset,
}: {
  revisionId: string;
  lecture: RevisionLecture;
  asset: AssetView | undefined;
}) {
  const description = lecture.descriptionMd ? (
    <MarkdownView
      source={lecture.descriptionMd}
      idPrefix={`lecture-${lecture.id}-description-`}
      className="text-sm"
    />
  ) : null;

  if (lecture.type === 'QUIZ') {
    return (
      <div className="grid gap-4">
        {description}
        <RevisionQuizPreview
          revisionId={revisionId}
          lectureId={lecture.id}
          summary={lecture.quiz}
        />
      </div>
    );
  }

  if (lecture.type === 'ARTICLE') {
    return (
      <div className="grid gap-4">
        {description}
        {lecture.articleBodyMd ? (
          <article
            aria-label={`Article: ${lecture.title}`}
            className="rounded-md border bg-background p-4"
          >
            <MarkdownView source={lecture.articleBodyMd} idPrefix={`lecture-${lecture.id}-`} />
          </article>
        ) : (
          <p className="text-sm text-muted-foreground">This article is empty.</p>
        )}
      </div>
    );
  }

  let media;
  if (!asset) {
    media = <p className="text-sm text-muted-foreground">No file attached.</p>;
  } else if (lecture.type === 'VIDEO' && asset.status === 'READY') {
    media = (
      <LecturePlayer
        src={revisionPlaylistUrl(revisionId, lecture.id)}
        title={lecture.title}
        className="max-w-2xl"
      />
    );
  } else if (lecture.type === 'VIDEO') {
    media = (
      <p className="text-sm text-muted-foreground">
        The video cannot be played: {MEDIA_STATUS_LABEL[asset.status].toLowerCase()}
        {asset.purged ? ' (purged)' : ''}.
      </p>
    );
  } else {
    media = (
      <div className="grid gap-2">
        <p className="text-sm text-muted-foreground">
          File: <span className="font-medium text-foreground">{asset.originalFilename}</span> (
          {formatBytes(asset.sizeBytes)}, {MEDIA_STATUS_LABEL[asset.status].toLowerCase()}
          {asset.purged ? ', purged' : ''})
        </p>
        {lecture.type === 'RESOURCE' ? (
          <ResourceDownload revisionId={revisionId} lecture={lecture} asset={asset} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {media}
      {description}
    </div>
  );
}

function LectureRow({
  revisionId,
  lecture,
  index,
  assets,
  diff,
}: {
  revisionId: string;
  lecture: RevisionLecture;
  index: number;
  assets: ReadonlyMap<string, AssetView>;
  diff: DiffIndex;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const asset = lecture.mediaAssetId ? assets.get(lecture.mediaAssetId) : undefined;
  const changes = diff.lecture(lecture.id);
  const previewLabel =
    lecture.type === 'VIDEO'
      ? 'Play'
      : lecture.type === 'ARTICLE'
        ? 'Read'
        : lecture.type === 'QUIZ'
          ? 'Questions'
          : 'Details';

  return (
    <li className="grid gap-3 py-3" data-testid={`lecture-${lecture.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="w-6 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
          {index + 1}.
        </span>
        <span className="min-w-0 flex-1 font-medium break-words">{lecture.title}</span>
        <Badge variant="outline">{LECTURE_TYPE_LABEL[lecture.type]}</Badge>
        {lecture.isPreview ? <Badge variant="secondary">Free preview</Badge> : null}
        <ChangeBadges changes={changes} />
        {lecture.durationSeconds !== null ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            <span className="sr-only">Duration </span>
            {formatDuration(lecture.durationSeconds)}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${open ? 'Hide' : previewLabel} ${lecture.title}`}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Hide' : previewLabel}
        </Button>
      </div>
      <div id={panelId} hidden={!open} className="pl-9">
        {open ? <LecturePreview revisionId={revisionId} lecture={lecture} asset={asset} /> : null}
      </div>
    </li>
  );
}

function SectionBlock({
  revisionId,
  section,
  index,
  assets,
  diff,
}: {
  revisionId: string;
  section: RevisionSection;
  index: number;
  assets: ReadonlyMap<string, AssetView>;
  diff: DiffIndex;
}) {
  const headingId = useId();
  const seconds = section.lectures.reduce((sum, l) => sum + (l.durationSeconds ?? 0), 0);
  return (
    <section aria-labelledby={headingId} className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/50 px-4 py-3">
        <h3 id={headingId} className="min-w-0 flex-1 font-semibold break-words">
          Section {index + 1}: {section.title}
        </h3>
        <ChangeBadges changes={diff.section(section.id)} />
        <span className="text-xs text-muted-foreground">
          {section.lectures.length} lecture{section.lectures.length === 1 ? '' : 's'}
          {seconds > 0 ? ` · ${formatTotalDuration(seconds)}` : ''}
        </span>
        {section.objective ? (
          <p className="basis-full text-sm text-muted-foreground">{section.objective}</p>
        ) : null}
      </div>
      {section.lectures.length > 0 ? (
        <ol className="divide-y px-4">
          {section.lectures.map((lecture, i) => (
            <LectureRow
              key={lecture.id}
              revisionId={revisionId}
              lecture={lecture}
              index={i}
              assets={assets}
              diff={diff}
            />
          ))}
        </ol>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">No lectures.</p>
      )}
    </section>
  );
}

export function CurriculumReview({
  revisionId,
  sections,
  assets,
  diff,
}: {
  revisionId: string;
  sections: RevisionSection[];
  assets: AssetView[];
  diff: DiffIndex;
}) {
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  if (sections.length === 0) {
    return <p className="text-sm text-muted-foreground">This revision has no sections.</p>;
  }
  return (
    <div className="grid gap-4">
      {sections.map((section, i) => (
        <SectionBlock
          key={section.id}
          revisionId={revisionId}
          section={section}
          index={i}
          assets={assetMap}
          diff={diff}
        />
      ))}
    </div>
  );
}

/** Sections and lectures in the live revision that this revision drops (titles from the diff). */
export function RemovedItems({ diff }: { diff: RevisionDiff }) {
  const { sections, lectures } = diff;
  if (sections.removed.length === 0 && lectures.removed.length === 0) return null;
  return (
    <div className="grid gap-3 text-sm">
      {sections.removed.length > 0 ? (
        <div className="grid gap-1">
          <h3 className="font-medium">Removed sections</h3>
          <ul className="grid gap-1">
            {sections.removed.map((section) => (
              <li key={section.id} className="flex items-center gap-2">
                <Badge variant="destructive">Removed</Badge>
                <span className="line-through decoration-destructive/60">{section.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {lectures.removed.length > 0 ? (
        <div className="grid gap-1">
          <h3 className="font-medium">Removed lectures</h3>
          <ul className="grid gap-1">
            {lectures.removed.map((lecture) => (
              <li key={lecture.id} className="flex flex-wrap items-center gap-2">
                <Badge variant="destructive">Removed</Badge>
                <span className="line-through decoration-destructive/60">{lecture.title}</span>
                <Badge variant="outline">{LECTURE_TYPE_LABEL[lecture.type]}</Badge>
                {lecture.sectionTitle ? (
                  <span className="text-muted-foreground">in section “{lecture.sectionTitle}”</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
