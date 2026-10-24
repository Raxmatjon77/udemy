import type { TimestampKeyset } from '../learning-cursor';
import type { DB, Executor, Transaction } from '@udemy/db';

export interface NoteRecord {
  readonly id: string;
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly positionSeconds: number | null;
  readonly bodyMd: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Keyset of `created_at` (exact SQL text, P2 §14) and the id. */
export type NoteKeyset = TimestampKeyset;

export interface NotePageRow {
  readonly note: NoteRecord;
  readonly keyset: NoteKeyset;
}

export interface NewNote {
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly positionSeconds: number | null;
  readonly bodyMd: string;
}

/** `bodyMd` / `positionSeconds` when present; `positionSeconds: null` clears the timestamp. */
export interface NotePatch {
  readonly bodyMd?: string;
  readonly positionSeconds?: number | null;
}

/**
 * `learning.notes` (private, hard-deleted by the owner). Every read and write is scoped to the
 * owner's user id (IDOR): a foreign id behaves exactly like an unknown one.
 */
export abstract class NotesRepository {
  /**
   * The `note` two-int advisory lock of (user, course) (`NOTES_CAP_LOCK_CLASS`), then the note
   * count in a new statement (READ COMMITTED: a parallel create that committed first is seen).
   */
  abstract lockCapAndCount(trx: Transaction<DB>, userId: string, courseId: string): Promise<number>;

  abstract insert(trx: Transaction<DB>, note: NewNote): Promise<NoteRecord>;

  abstract findOwn(userId: string, noteId: string, ex?: Executor): Promise<NoteRecord | null>;

  /** null when the note is not (or no longer) the user's. */
  abstract update(
    userId: string,
    noteId: string,
    patch: NotePatch,
    ex?: Executor,
  ): Promise<NoteRecord | null>;

  /** true when the user's note was deleted. */
  abstract delete(userId: string, noteId: string, ex?: Executor): Promise<boolean>;

  /** Keyset `(created_at DESC, id DESC)`, optionally one lecture; `limit` rows at most. */
  abstract listPage(
    input: {
      readonly userId: string;
      readonly courseId: string;
      readonly lectureId: string | null;
      readonly after: NoteKeyset | null;
      readonly limit: number;
    },
    ex?: Executor,
  ): Promise<NotePageRow[]>;

  /** `notes.user_id`, or null when the note does not exist (ownership resolver). */
  abstract ownerOf(noteId: string): Promise<string | null>;
}
