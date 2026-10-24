'use client';

import {
  PREVIEWABLE_LECTURE_TYPES,
  type LandingLecture,
  type LandingSection,
  type LectureType,
} from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { useRef, useState } from 'react';

import { usePurchaseState } from '@/lib/commerce/hooks';

import {
  describeDuration,
  formatClock,
  formatTotalDuration,
  LECTURE_TYPE_LABELS,
  pluralize,
} from '@/lib/catalog/format';

import { PreviewDialog } from './preview-dialog';

/**
 * The curriculum accordion of the landing page: sections (native `<details>`, keyboard and
 * screen-reader friendly without any script) → lectures with type, duration and a "Preview"
 * button for free-preview lectures, which opens the preview dialog.
 *
 * Entitled viewers (an ACTIVE enrollment, or the owner: `GET /me/purchase-states`) open every
 * video and article lecture the same way (Phase 4, until the Phase 5 player); the API decides
 * (a revoked enrollment answers 403 `lecture_locked`), this only offers the button.
 */

export function isPreviewable(lecture: LandingLecture): boolean {
  return (
    lecture.isPreview &&
    (PREVIEWABLE_LECTURE_TYPES as readonly LectureType[]).includes(lecture.type)
  );
}

/** A lecture this viewer can open: a free preview, or any playable lecture when entitled. */
export function isOpenable(lecture: LandingLecture, entitled: boolean): boolean {
  if (isPreviewable(lecture)) return true;
  return entitled && (PREVIEWABLE_LECTURE_TYPES as readonly LectureType[]).includes(lecture.type);
}

export function sectionTotals(section: LandingSection): { lectures: number; seconds: number } {
  return {
    lectures: section.lectures.length,
    seconds: section.lectures.reduce((sum, lecture) => sum + (lecture.durationSeconds ?? 0), 0),
  };
}

export function CurriculumOutline({
  courseId,
  courseTitle,
  hasThumbnail,
  sections,
  signedIn = false,
}: {
  courseId: string;
  courseTitle: string;
  /** `CourseLanding.hasThumbnail`: no poster request when false. */
  hasThumbnail?: boolean | undefined;
  sections: readonly LandingSection[];
  /** Signed-in viewers may be entitled to every lecture (purchase state). */
  signedIn?: boolean;
}) {
  const purchase = usePurchaseState(courseId, signedIn);
  const entitled = purchase.data ? purchase.data.enrolled || purchase.data.isOwner : false;
  const [allOpen, setAllOpen] = useState<boolean | null>(null);
  // The lecture stays set while the dialog closes, so the content unmounts cleanly; `open` drives it.
  const [preview, setPreview] = useState<{ lecture: LandingLecture; open: boolean } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  if (sections.length === 0) {
    return <p className="text-sm text-muted-foreground">The curriculum is not available yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-0"
          onClick={() => setAllOpen((open) => !(open ?? false))}
        >
          {allOpen ? 'Collapse all sections' : 'Expand all sections'}
        </Button>
      </div>
      <ol className="overflow-hidden rounded-lg border" aria-label="Course sections">
        {sections.map((section, index) => {
          const totals = sectionTotals(section);
          return (
            <li key={section.id} className="border-b last:border-b-0">
              <details
                // Uncontrolled after the first render unless "expand/collapse all" was used.
                open={allOpen ?? index === 0}
                className="group"
              >
                <summary className="flex cursor-pointer list-none items-center gap-3 bg-muted/50 px-4 py-3 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="size-4 shrink-0 transition-transform group-open:rotate-180"
                    aria-hidden="true"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                  <span className="flex-1 font-medium">{section.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {pluralize(totals.lectures, 'lecture')}
                    {totals.seconds > 0 ? ` · ${formatTotalDuration(totals.seconds)}` : ''}
                  </span>
                </summary>
                {section.objective ? (
                  <p className="px-4 pt-3 text-sm text-muted-foreground">{section.objective}</p>
                ) : null}
                <ul className="flex flex-col py-2">
                  {section.lectures.map((lecture) => (
                    <LectureRow
                      key={lecture.id}
                      lecture={lecture}
                      entitled={entitled}
                      onPreview={(trigger) => {
                        triggerRef.current = trigger;
                        setPreview({ lecture, open: true });
                      }}
                    />
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ol>
      <PreviewDialog
        courseId={courseId}
        courseTitle={courseTitle}
        hasThumbnail={hasThumbnail}
        entitled={entitled}
        lecture={preview?.lecture ?? null}
        open={preview?.open ?? false}
        onOpenChange={(open) => setPreview((current) => (current ? { ...current, open } : null))}
        returnFocusTo={triggerRef}
      />
    </div>
  );
}

function LectureRow({
  lecture,
  entitled,
  onPreview,
}: {
  lecture: LandingLecture;
  entitled: boolean;
  onPreview: (trigger: HTMLElement) => void;
}) {
  const previewable = isPreviewable(lecture);
  const openable = isOpenable(lecture, entitled);
  return (
    <li
      data-testid="lecture-row"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm"
    >
      <LectureTypeIcon type={lecture.type} />
      <span className="sr-only">{LECTURE_TYPE_LABELS[lecture.type]}:</span>
      {openable ? (
        <button
          type="button"
          onClick={(event) => onPreview(event.currentTarget)}
          className="min-w-0 flex-1 rounded-sm text-left text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-haspopup="dialog"
        >
          {lecture.title}
          <span className="sr-only">
            {previewable ? ' (free preview, opens a player)' : ' (opens the lecture)'}
          </span>
        </button>
      ) : (
        <span className="min-w-0 flex-1">{lecture.title}</span>
      )}
      {previewable ? (
        <Badge variant="secondary" aria-hidden="true">
          Preview
        </Badge>
      ) : null}
      {lecture.durationSeconds !== null ? (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          <span aria-hidden="true">{formatClock(lecture.durationSeconds)}</span>
          <span className="sr-only">{describeDuration(lecture.durationSeconds)}</span>
        </span>
      ) : null}
    </li>
  );
}

function LectureTypeIcon({ type }: { type: LectureType }) {
  const paths: Record<LectureType, string> = {
    VIDEO: 'M5 4.5v15l13-7.5z',
    ARTICLE: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h3',
    RESOURCE: 'M12 4v11m0 0-4-4m4 4 4-4M5 20h14',
    // TODO(P5-T8): final quiz icon; QUIZ lectures arrive with the Phase 5 catalog (P5-T6).
    QUIZ: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinejoin="round"
      strokeLinecap="round"
      className="size-4 shrink-0 text-muted-foreground"
      aria-hidden="true"
      data-type={type}
    >
      <path d={paths[type]} />
    </svg>
  );
}
