'use client';

import type { ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CurriculumSection, Lecture } from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { cn } from '@udemy/ui/lib/utils';

import { formatDuration } from '@/lib/format';
import { LECTURE_TYPE_LABELS, MEDIA_STATUS_LABELS } from '@/lib/labels';

/* Sortable ids are namespaced so sections and lectures never collide. */
export const sectionDndId = (id: string) => `section:${id}`;
export const lectureDndId = (id: string) => `lecture:${id}`;
export const sectionDropId = (id: string) => `drop:${id}`;

export type DndData =
  | { type: 'section'; sectionId: string }
  | { type: 'lecture'; lectureId: string }
  | { type: 'section-body'; sectionId: string };

function DragHandle({ label, ...props }: { label: string } & Record<string, unknown>) {
  return (
    <button
      type="button"
      aria-label={label}
      className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing"
      {...props}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-4">
        <circle cx="9" cy="6" r="1.5" />
        <circle cx="15" cy="6" r="1.5" />
        <circle cx="9" cy="12" r="1.5" />
        <circle cx="15" cy="12" r="1.5" />
        <circle cx="9" cy="18" r="1.5" />
        <circle cx="15" cy="18" r="1.5" />
      </svg>
    </button>
  );
}

function lectureSummary(lecture: Lecture): string {
  if (lecture.type === 'ARTICLE') {
    return lecture.articleLength ? `${lecture.articleLength} characters` : 'Empty article';
  }
  const asset = lecture.asset;
  if (!asset) return lecture.type === 'VIDEO' ? 'No video yet' : 'No file yet';
  if (asset.status === 'READY' && asset.durationSeconds !== null) {
    return `${MEDIA_STATUS_LABELS.READY} · ${formatDuration(asset.durationSeconds)}`;
  }
  if (asset.status === 'PROCESSING' && asset.progressPct !== null) {
    return `${MEDIA_STATUS_LABELS.PROCESSING} ${asset.progressPct}%`;
  }
  return MEDIA_STATUS_LABELS[asset.status];
}

export function SortableLecture({
  lecture,
  number,
  readOnly,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onOpen,
  deleteButton,
}: {
  lecture: Lecture;
  number: number;
  readOnly: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onOpen: () => void;
  deleteButton: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: lectureDndId(lecture.id),
    data: { type: 'lecture', lectureId: lecture.id } satisfies DndData,
    disabled: readOnly,
  });
  const failed = lecture.asset?.status === 'FAILED';

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'flex items-center gap-2 rounded-md border bg-background px-2 py-1.5',
        isDragging && 'z-10 opacity-70 shadow-md',
      )}
      data-lecture-id={lecture.id}
    >
      {readOnly ? null : (
        <DragHandle label={`Reorder lecture ${number}: ${lecture.title}`} {...attributes} {...listeners} />
      )}
      <Badge variant="outline" className="w-20 shrink-0">
        {LECTURE_TYPE_LABELS[lecture.type]}
      </Badge>
      <button
        type="button"
        id={`lecture-${lecture.id}`}
        onClick={onOpen}
        className="min-w-0 flex-1 truncate rounded-sm text-left text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="sr-only">Lecture {number}: </span>
        {lecture.title}
      </button>
      {lecture.isPreview ? <Badge variant="secondary">Preview</Badge> : null}
      <span className={cn('hidden shrink-0 text-xs sm:inline', failed ? 'text-destructive' : 'text-muted-foreground')}>
        {lectureSummary(lecture)}
      </span>
      {readOnly ? null : (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onMoveUp}
            disabled={!canMoveUp}
            aria-label={`Move lecture “${lecture.title}” up`}
          >
            ↑
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onMoveDown}
            disabled={!canMoveDown}
            aria-label={`Move lecture “${lecture.title}” down`}
          >
            ↓
          </Button>
          {deleteButton}
        </>
      )}
    </li>
  );
}

export function SortableSection({
  section,
  number,
  readOnly,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  actions,
  children,
  footer,
}: {
  section: CurriculumSection;
  number: number;
  readOnly: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  actions: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sectionDndId(section.id),
    data: { type: 'section', sectionId: section.id } satisfies DndData,
    disabled: readOnly,
  });
  const { setNodeRef: setBodyRef, isOver } = useDroppable({
    id: sectionDropId(section.id),
    data: { type: 'section-body', sectionId: section.id } satisfies DndData,
    disabled: readOnly,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('grid gap-3 rounded-lg border bg-card p-4', isDragging && 'z-10 opacity-70 shadow-lg')}
      aria-labelledby={`section-${section.id}`}
    >
      <div className="flex items-center gap-2">
        {readOnly ? null : (
          <DragHandle label={`Reorder section ${number}: ${section.title}`} {...attributes} {...listeners} />
        )}
        <h3
          id={`section-${section.id}`}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate rounded-sm font-semibold focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Section {number}: {section.title}
        </h3>
        {readOnly ? null : (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onMoveUp}
              disabled={!canMoveUp}
              aria-label={`Move section “${section.title}” up`}
            >
              ↑
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onMoveDown}
              disabled={!canMoveDown}
              aria-label={`Move section “${section.title}” down`}
            >
              ↓
            </Button>
            {actions}
          </>
        )}
      </div>
      {section.objective ? <p className="text-sm text-muted-foreground">{section.objective}</p> : null}
      <ol
        ref={setBodyRef}
        aria-label={`Lectures of section ${number}`}
        className={cn('grid min-h-10 gap-2 rounded-md', isOver && 'bg-accent/50')}
      >
        {children}
      </ol>
      {footer}
    </li>
  );
}
