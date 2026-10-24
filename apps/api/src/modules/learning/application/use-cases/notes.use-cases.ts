import { Injectable } from '@nestjs/common';
import type { Note, NotePage } from '@udemy/contracts';
import { CatalogFacade } from '../../../catalog';
import { NoteNotFound } from '../../domain/learning.errors';
import { assertMarkdownAllowed, assertNoteCapacity, assertNotePosition } from '../../domain/notes';
import { isUuid, LearnerAccess, liveLecturesOf } from '../learner-access';
import { decodeLearningCursor, pageOf } from '../learning-cursor';
import { LearningRateLimiter } from '../ports/learning-rate-limiter';
import { type NoteRecord, NotesRepository } from '../ports/notes.repository';
import { TransactionRunner } from '../ports/transaction-runner';

/** The private note as the owner sees it. */
export function toNoteView(note: NoteRecord): Note {
  return {
    id: note.id,
    courseId: note.courseId,
    lectureId: note.lectureId,
    positionSeconds: note.positionSeconds,
    bodyMd: note.bodyMd,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

export interface ListNotesInput {
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId?: string;
  readonly cursor?: string;
  /** 1–50 (the request schema enforces it). */
  readonly limit: number;
}

/**
 * `ListNotes` (design §5; `GET /me/courses/:courseId/notes?lectureId=&cursor=`): the caller's
 * notes of the course, newest first (keyset `(created_at DESC, id DESC)`), optionally of one
 * lecture. Requires an ACTIVE enrollment (D9: kept but inaccessible after a revoke).
 *
 * Errors: 404 `course_not_found`, 403 `enrollment_required`, 422 `validation_failed` (cursor).
 */
@Injectable()
export class ListNotesQuery {
  constructor(
    private readonly access: LearnerAccess,
    private readonly notes: NotesRepository,
  ) {}

  async execute(input: ListNotesInput): Promise<NotePage> {
    const curriculum = await this.access.curriculum(input.courseId);
    await this.access.requireLearner(input.userId, curriculum.courseId);
    const after = input.cursor === undefined ? null : decodeLearningCursor(input.cursor);
    const lectureId = input.lectureId === undefined ? null : input.lectureId.toLowerCase();
    const rows = await this.notes.listPage({
      userId: input.userId,
      courseId: curriculum.courseId,
      lectureId,
      after,
      limit: input.limit + 1,
    });
    return pageOf(
      rows,
      input.limit,
      (row) => row.keyset,
      (row) => toNoteView(row.note),
    );
  }
}

export interface CreateNoteInput {
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly positionSeconds?: number;
  readonly bodyMd: string;
}

/**
 * `CreateNote` (design §5; `POST /me/courses/:courseId/notes`): requires an ACTIVE enrollment,
 * a lecture of the LIVE revision (a lecture of another course is 404 through this path), a
 * timestamp only within a video's duration, and safe markdown. At most 500 notes per course:
 * counted under the `note` (user, course) advisory lock, so parallel creates cannot overshoot.
 *
 * Errors: 404 `course_not_found` / `lecture_not_found`, 403 `enrollment_required`,
 * 422 `markdown_not_allowed` / `note_limit_exceeded` / `validation_failed`, 429.
 */
@Injectable()
export class CreateNoteCommand {
  constructor(
    private readonly rateLimiter: LearningRateLimiter,
    private readonly access: LearnerAccess,
    private readonly notes: NotesRepository,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: CreateNoteInput): Promise<Note> {
    await this.rateLimiter.hit('noteWrite', input.userId);
    const curriculum = await this.access.curriculum(input.courseId);
    const lecture = this.access.lecture(curriculum, input.lectureId);
    await this.access.requireLearner(input.userId, curriculum.courseId);
    assertNotePosition(lecture, input.positionSeconds);
    assertMarkdownAllowed('bodyMd', input.bodyMd);

    const note = await this.tx.run(async (trx) => {
      const count = await this.notes.lockCapAndCount(trx, input.userId, curriculum.courseId);
      assertNoteCapacity(count);
      return this.notes.insert(trx, {
        userId: input.userId,
        courseId: curriculum.courseId,
        lectureId: lecture.id,
        positionSeconds: input.positionSeconds ?? null,
        bodyMd: input.bodyMd,
      });
    });
    return toNoteView(note);
  }
}

export interface UpdateNoteInput {
  readonly userId: string;
  readonly noteId: string;
  readonly bodyMd?: string;
  /** `null` clears the timestamp. */
  readonly positionSeconds?: number | null;
}

/**
 * `UpdateNote` (`PATCH /me/notes/:noteId`, Pol `note:manage`): the owner may edit after a
 * revoke (D9), so there is no enrollment check. A new timestamp must fit the note's lecture as
 * it is in the CURRENT live revision (a lecture that left the curriculum only allows clearing).
 *
 * Errors: 404 `note_not_found`, 422 `markdown_not_allowed` / `validation_failed`, 429.
 */
@Injectable()
export class UpdateNoteCommand {
  constructor(
    private readonly rateLimiter: LearningRateLimiter,
    private readonly catalog: CatalogFacade,
    private readonly notes: NotesRepository,
  ) {}

  async execute(input: UpdateNoteInput): Promise<Note> {
    await this.rateLimiter.hit('noteWrite', input.userId);
    const current = isUuid(input.noteId)
      ? await this.notes.findOwn(input.userId, input.noteId)
      : null;
    if (current === null) throw new NoteNotFound();
    if (input.bodyMd !== undefined) assertMarkdownAllowed('bodyMd', input.bodyMd);
    if (input.positionSeconds !== undefined && input.positionSeconds !== null) {
      const curriculum = await this.catalog.getLiveCurriculum(current.courseId);
      const lecture =
        curriculum === null
          ? undefined
          : liveLecturesOf(curriculum).find((l) => l.id === current.lectureId);
      assertNotePosition(lecture ?? null, input.positionSeconds);
    }
    const updated = await this.notes.update(input.userId, current.id, {
      ...(input.bodyMd === undefined ? {} : { bodyMd: input.bodyMd }),
      ...(input.positionSeconds === undefined ? {} : { positionSeconds: input.positionSeconds }),
    });
    if (updated === null) throw new NoteNotFound();
    return toNoteView(updated);
  }
}

/**
 * `DeleteNote` (`DELETE /me/notes/:noteId`, Pol `note:manage`): a hard delete by the owner,
 * allowed after a revoke (D9).
 *
 * Errors: 404 `note_not_found`, 429.
 */
@Injectable()
export class DeleteNoteCommand {
  constructor(
    private readonly rateLimiter: LearningRateLimiter,
    private readonly notes: NotesRepository,
  ) {}

  async execute(input: { readonly userId: string; readonly noteId: string }): Promise<void> {
    await this.rateLimiter.hit('noteWrite', input.userId);
    const deleted = isUuid(input.noteId)
      ? await this.notes.delete(input.userId, input.noteId)
      : false;
    if (!deleted) throw new NoteNotFound();
  }
}
