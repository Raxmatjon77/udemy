import { Injectable } from '@nestjs/common';
import { type DB, type Executor, lockNotesCap, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type NewNote,
  type NotePageRow,
  type NotePatch,
  type NoteRecord,
  type NoteKeyset,
  NotesRepository,
} from '../application/ports/notes.repository';
import { exactUtcText } from './row-mapping';

const NOTE_COLUMNS = [
  'id',
  'userId',
  'courseId',
  'lectureId',
  'positionSeconds',
  'bodyMd',
  'createdAt',
  'updatedAt',
] as const;

/**
 * `learning.notes` (schema doc §1): every statement is scoped to the owner's `user_id`. The cap
 * count runs after the `note` advisory lock (`@udemy/db` `lockNotesCap`); the list is a keyset
 * over `notes_user_id_course_id_created_at_id_idx` / `notes_user_id_lecture_id_created_at_id_idx`.
 * `updated_at` is maintained by the `notes_set_updated_at_trg` trigger.
 */
@Injectable()
export class KyselyNotesRepository extends NotesRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async lockCapAndCount(trx: Transaction<DB>, userId: string, courseId: string): Promise<number> {
    const { noteCount } = await lockNotesCap(trx, userId, courseId);
    return noteCount;
  }

  insert(trx: Transaction<DB>, note: NewNote): Promise<NoteRecord> {
    return trx
      .insertInto('learning.notes')
      .values({
        userId: note.userId,
        courseId: note.courseId,
        lectureId: note.lectureId,
        positionSeconds: note.positionSeconds,
        bodyMd: note.bodyMd,
      })
      .returning(NOTE_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  async findOwn(
    userId: string,
    noteId: string,
    ex: Executor = this.db,
  ): Promise<NoteRecord | null> {
    const row = await ex
      .selectFrom('learning.notes')
      .select(NOTE_COLUMNS)
      .where('id', '=', noteId)
      .where('userId', '=', userId)
      .executeTakeFirst();
    return row ?? null;
  }

  async update(
    userId: string,
    noteId: string,
    patch: NotePatch,
    ex: Executor = this.db,
  ): Promise<NoteRecord | null> {
    const values: { bodyMd?: string; positionSeconds?: number | null } = {};
    if (patch.bodyMd !== undefined) values.bodyMd = patch.bodyMd;
    if (patch.positionSeconds !== undefined) values.positionSeconds = patch.positionSeconds;
    if (Object.keys(values).length === 0) return this.findOwn(userId, noteId, ex);
    const row = await ex
      .updateTable('learning.notes')
      .set(values)
      .where('id', '=', noteId)
      .where('userId', '=', userId)
      .returning(NOTE_COLUMNS)
      .executeTakeFirst();
    return row ?? null;
  }

  async delete(userId: string, noteId: string, ex: Executor = this.db): Promise<boolean> {
    const result = await ex
      .deleteFrom('learning.notes')
      .where('id', '=', noteId)
      .where('userId', '=', userId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  async listPage(
    input: {
      readonly userId: string;
      readonly courseId: string;
      readonly lectureId: string | null;
      readonly after: NoteKeyset | null;
      readonly limit: number;
    },
    ex: Executor = this.db,
  ): Promise<NotePageRow[]> {
    let query = ex
      .selectFrom('learning.notes')
      .select(NOTE_COLUMNS)
      .select(exactUtcText('created_at').as('createdAtKey'))
      .where('userId', '=', input.userId)
      .where('courseId', '=', input.courseId);
    if (input.lectureId !== null) query = query.where('lectureId', '=', input.lectureId);
    if (input.after !== null) {
      query = query.where(
        sql<boolean>`(created_at, id) < (${input.after.at}::timestamptz, ${input.after.id}::uuid)`,
      );
    }
    const rows = await query
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map(({ createdAtKey, ...note }) => ({
      note,
      keyset: { at: createdAtKey, id: note.id },
    }));
  }

  async ownerOf(noteId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('learning.notes')
      .select('userId')
      .where('id', '=', noteId)
      .executeTakeFirst();
    return row?.userId ?? null;
  }
}
