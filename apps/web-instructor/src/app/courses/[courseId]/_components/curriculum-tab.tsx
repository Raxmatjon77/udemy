'use client';

import { useMemo, useState, type FormEvent } from 'react';
import {
  closestCenter,
  closestCorners,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CURRICULUM_LIMITS,
  ErrorCode,
  LECTURE_TYPES,
  LectureTitleSchema,
  SectionTitleSchema,
  type CourseDetail,
  type Curriculum,
  type LectureType,
  type ReorderCurriculumRequest,
} from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import { Input } from '@udemy/ui/components/input';
import { NativeSelect } from '@udemy/ui/components/native-select';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { catalogApi } from '@/lib/catalog-api';
import { catalogKeys, setCurriculumData } from '@/lib/catalog-queries';
import {
  findLecture,
  moveLecture,
  moveSection,
  orderFromCurriculum,
  sameOrder,
  stepLecture,
  stepSection,
  toReorderRequest,
  type CurriculumOrder,
} from '@/lib/curriculum-order';
import { formatMinutes } from '@/lib/format';
import { LECTURE_TYPE_LABELS } from '@/lib/labels';
import { hasCode, problemMessage } from '@/lib/problem';
import { friendlyZodError } from '@/lib/zod-messages';

import {
  lectureDndId,
  sectionDndId,
  SortableLecture,
  SortableSection,
  type DndData,
} from './curriculum-items';

const SCREEN_READER_INSTRUCTIONS =
  'To pick up a section or lecture, press Space or Enter. Use the arrow keys to move it, ' +
  'Space or Enter to drop it in its new place, or Escape to cancel. The Move up and Move ' +
  'down buttons do the same one step at a time.';

function dataOf(item: { data: { current?: unknown } } | null | undefined): DndData | undefined {
  return item?.data.current as DndData | undefined;
}

/**
 * Curriculum tab (design §10): sections and lectures, drag and drop (dnd-kit; pointer and
 * keyboard) across sections plus move buttons. Every change sends the FULL order with
 * `PUT /courses/:id/curriculum/order`; the list shows the new order at once and falls back to
 * the server's on failure. A 409 `order_mismatch` (changed elsewhere) refetches and says so.
 */
export function CurriculumTab({
  course,
  curriculum,
  readOnly,
  onOpenLecture,
}: {
  course: CourseDetail;
  curriculum: Curriculum;
  readOnly: boolean;
  onOpenLecture: (lectureId: string) => void;
}) {
  const queryClient = useQueryClient();
  const courseId = course.id;
  const serverOrder = useMemo(() => orderFromCurriculum(curriculum), [curriculum]);
  /** Optimistic order while a reorder is in flight (or during a drag). */
  const [localOrder, setLocalOrder] = useState<CurriculumOrder | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const order = localOrder ?? serverOrder;

  const sections = useMemo(
    () => new Map(curriculum.sections.map((section) => [section.id, section])),
    [curriculum],
  );
  const lectures = useMemo(
    () =>
      new Map(
        curriculum.sections.flatMap((section) => section.lectures.map((l) => [l.id, l] as const)),
      ),
    [curriculum],
  );

  const refreshCourse = () =>
    queryClient.invalidateQueries({ queryKey: catalogKeys.course(courseId), exact: true });
  const refreshCurriculum = () =>
    queryClient.invalidateQueries({ queryKey: catalogKeys.curriculum(courseId), exact: true });

  function handleWriteError(error: unknown) {
    if (hasCode(error, ErrorCode.CourseInReview) || hasCode(error, ErrorCode.CourseNotEditable)) {
      void refreshCourse();
    }
    if (
      hasCode(error, ErrorCode.SectionNotFound) ||
      hasCode(error, ErrorCode.LectureNotFound) ||
      hasCode(error, ErrorCode.OrderMismatch)
    ) {
      void refreshCurriculum();
    }
    setNotice({ kind: 'error', text: problemMessage(error) });
  }

  const reorder = useMutation({
    mutationFn: (body: ReorderCurriculumRequest) => catalogApi.reorder(courseId, body),
    onSuccess: (updated) => {
      setCurriculumData(queryClient, updated);
      void refreshCourse();
    },
    onError: handleWriteError,
    onSettled: () => setLocalOrder(null),
  });

  function commit(next: CurriculumOrder, message: string) {
    if (sameOrder(next, serverOrder)) {
      setLocalOrder(null);
      return;
    }
    setNotice(null);
    setLocalOrder(next);
    setAnnouncement(message);
    reorder.mutate(toReorderRequest(next));
  }

  /* ---- labels for announcements ---- */

  const sectionTitle = (id: string) => sections.get(id)?.title ?? 'section';
  const lectureTitle = (id: string) => lectures.get(id)?.title ?? 'lecture';
  function describe(id: UniqueIdentifier, current: CurriculumOrder): string {
    const [kind, raw] = String(id).split(':') as [string, string];
    if (kind === 'section') {
      const index = current.findIndex((s) => s.id === raw);
      return `section “${sectionTitle(raw)}”, position ${index + 1} of ${current.length}`;
    }
    if (kind === 'drop') return `the lecture list of section “${sectionTitle(raw)}”`;
    const at = findLecture(current, raw);
    if (!at) return `lecture “${lectureTitle(raw)}”`;
    return `lecture “${lectureTitle(raw)}”, position ${at.index + 1} in section “${sectionTitle(current[at.sectionIndex]!.id)}”`;
  }

  /* ---- move buttons ---- */

  function stepSectionBy(sectionId: string, delta: -1 | 1) {
    const next = stepSection(order, sectionId, delta);
    commit(
      next,
      `Moved section “${sectionTitle(sectionId)}” to position ${next.findIndex((s) => s.id === sectionId) + 1}.`,
    );
  }
  function stepLectureBy(lectureId: string, delta: -1 | 1) {
    const next = stepLecture(order, lectureId, delta);
    const at = findLecture(next, lectureId);
    commit(
      next,
      at
        ? `Moved lecture “${lectureTitle(lectureId)}” to position ${at.index + 1} in section “${sectionTitle(next[at.sectionIndex]!.id)}”.`
        : '',
    );
  }

  /* ---- drag and drop ---- */

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** Sections only collide with sections; lectures with lectures and section bodies. */
  const collisionDetection: CollisionDetection = (args) => {
    const type = dataOf(args.active)?.type;
    const droppableContainers = args.droppableContainers.filter((container) => {
      const target = dataOf(container)?.type;
      return type === 'section'
        ? target === 'section'
        : target === 'lecture' || target === 'section-body';
    });
    return type === 'section'
      ? closestCenter({ ...args, droppableContainers })
      : closestCorners({ ...args, droppableContainers });
  };

  function onDragStart(event: DragStartEvent) {
    setDragging(String(event.active.id));
    setLocalOrder(order);
    setNotice(null);
  }

  /** Cross-section lecture moves happen while hovering, so the target list makes room. */
  function onDragOver({ active, over }: DragOverEvent) {
    const from = dataOf(active);
    const to = dataOf(over);
    if (!over || from?.type !== 'lecture' || !to || to.type === 'section') return;
    setLocalOrder((current) => {
      const base = current ?? order;
      const at = findLecture(base, from.lectureId);
      if (!at) return base;
      const targetSectionId =
        to.type === 'section-body'
          ? to.sectionId
          : base[findLecture(base, to.lectureId)?.sectionIndex ?? -1]?.id;
      if (!targetSectionId || targetSectionId === base[at.sectionIndex]!.id) return base;
      const target = base.find((s) => s.id === targetSectionId)!;
      const index =
        to.type === 'lecture' ? target.lectureIds.indexOf(to.lectureId) : target.lectureIds.length;
      return moveLecture(base, from.lectureId, targetSectionId, index);
    });
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setDragging(null);
    const base = localOrder ?? order;
    const from = dataOf(active);
    const to = dataOf(over);
    let next = base;
    if (from?.type === 'section' && to?.type === 'section') {
      next = moveSection(
        base,
        from.sectionId,
        base.findIndex((s) => s.id === to.sectionId),
      );
    } else if (from?.type === 'lecture' && to?.type === 'lecture') {
      const target = findLecture(base, to.lectureId);
      if (target) {
        next = moveLecture(base, from.lectureId, base[target.sectionIndex]!.id, target.index);
      }
    }
    commit(next, '');
  }

  function onDragCancel() {
    setDragging(null);
    setLocalOrder(null);
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${describe(active.id, order)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${describe(active.id, order)} is over ${describe(over.id, order)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${describe(active.id, order)}.`
        : `Dropped ${describe(active.id, order)} in its original place.`,
    onDragCancel: ({ active }) =>
      `Moving was cancelled. ${describe(active.id, serverOrder)} is back in its place.`,
  };

  /* ---- section and lecture CRUD ---- */

  const addSection = useMutation({
    mutationFn: (title: string) => catalogApi.addSection(courseId, { title }),
    onSuccess: () => {
      void refreshCurriculum();
      void refreshCourse();
    },
    onError: handleWriteError,
  });
  const addLecture = useMutation({
    mutationFn: (input: { sectionId: string; type: LectureType; title: string }) =>
      catalogApi.addLecture(courseId, input.sectionId, { type: input.type, title: input.title }),
    onSuccess: () => {
      void refreshCurriculum();
      void refreshCourse();
    },
    onError: handleWriteError,
  });
  const afterDelete = () => {
    void refreshCurriculum();
    void refreshCourse();
  };

  const totals = curriculum.totals;
  const busy = reorder.isPending || dragging !== null;

  return (
    <section aria-labelledby="curriculum-heading" className="grid gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="curriculum-heading" className="text-xl font-semibold">
          Curriculum
        </h2>
        <p className="text-sm text-muted-foreground">
          {totals.sectionCount} sections · {totals.lectureCount} lectures ·{' '}
          {formatMinutes(totals.videoSeconds)} of video · {totals.previewCount} free previews
        </p>
      </div>

      <div role="alert" aria-live="assertive">
        {notice ? (
          <p className={notice.kind === 'error' ? 'text-sm text-destructive' : 'text-sm'}>
            {notice.text}
          </p>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {reorder.isPending ? 'Saving the new order…' : announcement}
      </p>

      {order.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-muted-foreground">
          No sections yet. Add the first section below.
        </p>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: SCREEN_READER_INSTRUCTIONS },
        }}
      >
        <SortableContext
          items={order.map((s) => sectionDndId(s.id))}
          strategy={verticalListSortingStrategy}
        >
          <ol className="grid gap-4" aria-label="Sections" aria-busy={busy}>
            {order.map((entry, sectionIndex) => {
              const section = sections.get(entry.id);
              if (!section) return null;
              return (
                <SortableSection
                  key={entry.id}
                  section={section}
                  number={sectionIndex + 1}
                  readOnly={readOnly}
                  canMoveUp={!busy && sectionIndex > 0}
                  canMoveDown={!busy && sectionIndex < order.length - 1}
                  onMoveUp={() => stepSectionBy(entry.id, -1)}
                  onMoveDown={() => stepSectionBy(entry.id, 1)}
                  actions={
                    <SectionActions
                      courseId={courseId}
                      sectionId={entry.id}
                      title={section.title}
                      lectureCount={entry.lectureIds.length}
                      onChanged={afterDelete}
                      onError={handleWriteError}
                    />
                  }
                  footer={
                    readOnly ? null : (
                      <AddLectureForm
                        sectionNumber={sectionIndex + 1}
                        pending={
                          addLecture.isPending && addLecture.variables?.sectionId === entry.id
                        }
                        disabled={
                          entry.lectureIds.length >= CURRICULUM_LIMITS.maxLecturesPerSection
                        }
                        onAdd={(type, title) =>
                          addLecture.mutateAsync({ sectionId: entry.id, type, title })
                        }
                      />
                    )
                  }
                >
                  <SortableContext
                    items={entry.lectureIds.map(lectureDndId)}
                    strategy={verticalListSortingStrategy}
                  >
                    {entry.lectureIds.length === 0 ? (
                      <li className="px-2 py-2 text-sm text-muted-foreground">
                        No lectures in this section yet.
                      </li>
                    ) : null}
                    {entry.lectureIds.map((lectureId, index) => {
                      const lecture = lectures.get(lectureId);
                      if (!lecture) return null;
                      const first = sectionIndex === 0 && index === 0;
                      const last =
                        sectionIndex === order.length - 1 && index === entry.lectureIds.length - 1;
                      return (
                        <SortableLecture
                          key={lectureId}
                          lecture={lecture}
                          number={index + 1}
                          readOnly={readOnly}
                          canMoveUp={!busy && !first}
                          canMoveDown={!busy && !last}
                          onMoveUp={() => stepLectureBy(lectureId, -1)}
                          onMoveDown={() => stepLectureBy(lectureId, 1)}
                          onOpen={() => onOpenLecture(lectureId)}
                          deleteButton={
                            <ConfirmDialog
                              trigger={
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  aria-label={`Delete lecture “${lecture.title}”`}
                                >
                                  ✕
                                </Button>
                              }
                              title="Delete this lecture?"
                              description={`“${lecture.title}” and its content are removed from the course.`}
                              confirmLabel="Delete lecture"
                              pendingLabel="Deleting…"
                              onConfirm={async () => {
                                await catalogApi.deleteLecture(courseId, lectureId);
                                afterDelete();
                              }}
                            />
                          }
                        />
                      );
                    })}
                  </SortableContext>
                </SortableSection>
              );
            })}
          </ol>
        </SortableContext>
      </DndContext>

      {readOnly ? null : (
        <AddSectionForm
          pending={addSection.isPending}
          disabled={order.length >= CURRICULUM_LIMITS.maxSectionsPerCourse}
          onAdd={(title) => addSection.mutateAsync(title)}
        />
      )}
    </section>
  );
}

function SectionActions({
  courseId,
  sectionId,
  title,
  lectureCount,
  onChanged,
  onError,
}: {
  courseId: string;
  sectionId: string;
  title: string;
  lectureCount: number;
  onChanged: () => void;
  onError: (error: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (next: string) => catalogApi.updateSection(courseId, sectionId, { title: next }),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
    onError,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = SectionTitleSchema.safeParse(value, { error: friendlyZodError });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid title');
      return;
    }
    setError(null);
    rename.mutate(parsed.data);
  }

  if (editing) {
    const id = `rename-${sectionId}`;
    return (
      <form onSubmit={submit} className="flex items-center gap-2" noValidate>
        <label htmlFor={id} className="sr-only">
          Section title
        </label>
        <Input
          id={id}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={80}
          autoFocus
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          className="h-8 w-56"
        />
        {error ? (
          <span id={`${id}-error`} className="text-xs text-destructive">
            {error}
          </span>
        ) : null}
        <Button type="submit" size="sm" disabled={rename.isPending}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </form>
    );
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          setValue(title);
          setEditing(true);
        }}
        aria-label={`Rename section “${title}”`}
      >
        Rename
      </Button>
      <ConfirmDialog
        trigger={
          <Button type="button" size="sm" variant="ghost" aria-label={`Delete section “${title}”`}>
            Delete
          </Button>
        }
        title="Delete this section?"
        description={
          lectureCount > 0
            ? `“${title}” and its ${lectureCount} lecture(s) are removed from the course.`
            : `“${title}” is removed from the course.`
        }
        confirmLabel="Delete section"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          await catalogApi.deleteSection(courseId, sectionId);
          onChanged();
        }}
      />
    </>
  );
}

function AddSectionForm({
  pending,
  disabled,
  onAdd,
}: {
  pending: boolean;
  disabled: boolean;
  onAdd: (title: string) => Promise<unknown>;
}) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = SectionTitleSchema.safeParse(title, { error: friendlyZodError });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid title');
      return;
    }
    setError(null);
    try {
      await onAdd(parsed.data);
      setTitle('');
    } catch {
      // Shown by the tab's notice.
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      className="grid gap-2 rounded-lg border border-dashed p-4"
    >
      <label htmlFor="new-section-title" className="text-sm font-medium">
        New section
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="new-section-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="e.g. Getting started"
          maxLength={80}
          className="max-w-md"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'new-section-title-error' : undefined}
          disabled={disabled}
        />
        <Button type="submit" variant="outline" disabled={pending || disabled}>
          Add section
        </Button>
      </div>
      {error ? (
        <p id="new-section-title-error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function AddLectureForm({
  sectionNumber,
  pending,
  disabled,
  onAdd,
}: {
  sectionNumber: number;
  pending: boolean;
  disabled: boolean;
  onAdd: (type: LectureType, title: string) => Promise<unknown>;
}) {
  const [type, setType] = useState<LectureType>('VIDEO');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const base = `new-lecture-${sectionNumber}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = LectureTitleSchema.safeParse(title, { error: friendlyZodError });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid title');
      return;
    }
    setError(null);
    try {
      await onAdd(type, parsed.data);
      setTitle('');
    } catch {
      // Shown by the tab's notice.
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${base}-type`} className="sr-only">
          Lecture type for section {sectionNumber}
        </label>
        <NativeSelect
          id={`${base}-type`}
          value={type}
          onChange={(event) => setType(event.target.value as LectureType)}
          className="h-8 w-32"
          disabled={disabled}
        >
          {LECTURE_TYPES.map((value) => (
            <option key={value} value={value}>
              {LECTURE_TYPE_LABELS[value]}
            </option>
          ))}
        </NativeSelect>
        <label htmlFor={`${base}-title`} className="sr-only">
          New lecture title for section {sectionNumber}
        </label>
        <Input
          id={`${base}-title`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="New lecture title"
          maxLength={80}
          className="h-8 max-w-sm"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${base}-error` : undefined}
          disabled={disabled}
        />
        <Button type="submit" size="sm" variant="outline" disabled={pending || disabled}>
          Add lecture
        </Button>
      </div>
      {error ? (
        <p id={`${base}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
