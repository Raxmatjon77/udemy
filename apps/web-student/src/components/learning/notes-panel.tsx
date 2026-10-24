'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  ErrorCode,
  LEARNING_LIMITS,
  type Note,
  type NotePage,
  type PlayerBootstrap,
  type PlayerLecture,
} from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Button } from '@udemy/ui/components/button';
import { Label } from '@udemy/ui/components/label';
import { Spinner } from '@udemy/ui/components/spinner';
import { Textarea } from '@udemy/ui/components/textarea';
import { useId, useState } from 'react';

import { formatClock } from '@/lib/catalog/format';
import { allLectures } from '@/lib/learning/cache';
import {
  createNote,
  deleteNote,
  fetchNotes,
  learningKeys,
  updateNote,
} from '@/lib/learning/client';
import { problemMessage } from '@/lib/problem';

/**
 * Private, timestamped notes (design §10 Notes tab). A note on a VIDEO lecture records the
 * current playback position; clicking its timestamp seeks there (or opens that lecture at that
 * second). Bodies are markdown, rendered with the sanitized `MarkdownView`.
 */

const NOTE_MESSAGES = {
  [ErrorCode.NoteLimitExceeded]: `You can keep up to ${LEARNING_LIMITS.maxNotesPerCourse} notes per course.`,
  [ErrorCode.MarkdownNotAllowed]: 'Notes support basic Markdown only (no HTML or images).',
};

export function NotesPanel({
  bootstrap,
  lecture,
  currentTime,
  onSeek,
}: {
  bootstrap: PlayerBootstrap;
  lecture: PlayerLecture;
  /** The current playback position of the open video lecture (null for other types). */
  currentTime: () => number | null;
  /** Seek to `seconds` in `lectureId` (the player navigates when it is another lecture). */
  onSeek: (lectureId: string, seconds: number) => void;
}) {
  const courseId = bootstrap.courseId;
  const queryClient = useQueryClient();
  const preview = bootstrap.mode === 'PREVIEW';
  const [scope, setScope] = useState<'lecture' | 'course'>('lecture');
  const [body, setBody] = useState('');
  const bodyId = useId();

  const notes = useInfiniteQuery<
    NotePage,
    Error,
    InfiniteData<NotePage, string | null>,
    ReturnType<typeof learningKeys.notes>,
    string | null
  >({
    queryKey: learningKeys.notes(courseId),
    queryFn: ({ pageParam, signal }) => fetchNotes(courseId, pageParam, signal),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !preview,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: learningKeys.notes(courseId) });

  const create = useMutation({
    mutationFn: () => {
      const at = lecture.type === 'VIDEO' ? currentTime() : null;
      return createNote(courseId, {
        lectureId: lecture.id,
        bodyMd: body.trim(),
        ...(at === null ? {} : { positionSeconds: Math.floor(at) }),
      });
    },
    onSuccess: () => {
      setBody('');
      void refresh();
    },
  });

  if (preview) {
    return (
      <p className="text-sm text-muted-foreground">Notes are not available in preview mode.</p>
    );
  }

  const titles = new Map(allLectures(bootstrap).map((l) => [l.id, l.title]));
  const items = (notes.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (note) => scope === 'course' || note.lectureId === lecture.id,
  );
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (body.trim()) create.mutate();
        }}
      >
        <Label htmlFor={bodyId}>
          {lecture.type === 'VIDEO' ? 'New note at the current position' : 'New note'}
        </Label>
        <Textarea
          id={bodyId}
          value={body}
          maxLength={LEARNING_LIMITS.noteBodyMaxChars}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
        />
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={create.isPending || !body.trim()}>
            {create.isPending ? <Spinner className="size-4" /> : null}
            Save note
          </Button>
        </div>
        {create.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {problemMessage(create.error, NOTE_MESSAGES)}
          </p>
        ) : null}
      </form>

      <div role="group" aria-label="Show notes" className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={scope === 'lecture' ? 'secondary' : 'ghost'}
          aria-pressed={scope === 'lecture'}
          onClick={() => setScope('lecture')}
        >
          This lecture
        </Button>
        <Button
          type="button"
          size="sm"
          variant={scope === 'course' ? 'secondary' : 'ghost'}
          aria-pressed={scope === 'course'}
          onClick={() => setScope('course')}
        >
          All lectures
        </Button>
      </div>

      {notes.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading notes…
        </p>
      ) : notes.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(notes.error)}
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes yet.</p>
      ) : (
        <ul aria-label="Your notes" className="flex flex-col gap-3">
          {items.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              lectureTitle={scope === 'course' ? (titles.get(note.lectureId) ?? null) : null}
              onSeek={onSeek}
              onChanged={() => void refresh()}
            />
          ))}
        </ul>
      )}
      {notes.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={notes.isFetchingNextPage}
          onClick={() => void notes.fetchNextPage()}
        >
          Load more notes
        </Button>
      ) : null}
    </div>
  );
}

function NoteItem({
  note,
  lectureTitle,
  onSeek,
  onChanged,
}: {
  note: Note;
  lectureTitle: string | null;
  onSeek: (lectureId: string, seconds: number) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.bodyMd);
  const editId = useId();
  const save = useMutation({
    mutationFn: () => updateNote(note.id, { bodyMd: draft.trim() }),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });
  const remove = useMutation({ mutationFn: () => deleteNote(note.id), onSuccess: onChanged });

  return (
    <li data-testid="note" className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {note.positionSeconds !== null ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            aria-label={`Go to ${formatClock(note.positionSeconds)}`}
            onClick={() => onSeek(note.lectureId, note.positionSeconds!)}
          >
            {formatClock(note.positionSeconds)}
          </Button>
        ) : null}
        {lectureTitle ? (
          <span className="text-xs text-muted-foreground">{lectureTitle}</span>
        ) : null}
        <span className="ml-auto flex gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Cancel' : 'Edit'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete
          </Button>
        </span>
      </div>
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) save.mutate();
          }}
        >
          <Label htmlFor={editId} className="sr-only">
            Edit note
          </Label>
          <Textarea
            id={editId}
            value={draft}
            maxLength={LEARNING_LIMITS.noteBodyMaxChars}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
          />
          <Button type="submit" size="sm" className="self-start" disabled={save.isPending}>
            Save changes
          </Button>
          {save.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {problemMessage(save.error, NOTE_MESSAGES)}
            </p>
          ) : null}
        </form>
      ) : (
        <MarkdownView source={note.bodyMd} idPrefix={`note-${note.id}-`} />
      )}
      {remove.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(remove.error)}
        </p>
      ) : null}
    </li>
  );
}
