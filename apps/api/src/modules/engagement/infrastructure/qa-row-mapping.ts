import { sql } from '@udemy/db';
import type { AnnouncementRecord } from '../domain/announcement';
import type { AnswerRecord, QuestionRecord } from '../domain/qa';
import { moderationStatusOf } from './row-mapping';

/** Raw `RETURNING` / select list of `engagement.questions` (CamelCasePlugin maps the keys). */
export const QUESTION_COLUMNS = sql.raw(
  'id, course_id, lecture_id, author_id, title, body_md, accepted_answer_id, moderation_status, ' +
    'upvote_count, answer_count, last_activity_at, created_at, edited_at, deleted_at',
);

export const ANSWER_COLUMNS = sql.raw(
  'id, question_id, author_id, body_md, upvote_count, moderation_status, created_at, edited_at, deleted_at',
);

export const ANNOUNCEMENT_COLUMNS = sql.raw(
  'id, course_id, author_id, title, body_md, send_email, created_at',
);

export interface QuestionRow {
  id: string;
  courseId: string;
  lectureId: string | null;
  authorId: string;
  title: string;
  bodyMd: string;
  acceptedAnswerId: string | null;
  moderationStatus: string;
  upvoteCount: number;
  answerCount: number;
  lastActivityAt: Date;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface AnswerRow {
  id: string;
  questionId: string;
  authorId: string;
  bodyMd: string;
  upvoteCount: number;
  moderationStatus: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface AnnouncementRow {
  id: string;
  courseId: string;
  authorId: string;
  title: string;
  bodyMd: string;
  sendEmail: boolean;
  createdAt: Date;
}

export function toQuestionRecord(row: QuestionRow): QuestionRecord {
  return {
    id: row.id,
    courseId: row.courseId,
    lectureId: row.lectureId,
    authorId: row.authorId,
    title: row.title,
    bodyMd: row.bodyMd,
    acceptedAnswerId: row.acceptedAnswerId,
    moderationStatus: moderationStatusOf(row.moderationStatus, 'questions.moderation_status'),
    upvoteCount: row.upvoteCount,
    answerCount: row.answerCount,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
  };
}

export function toAnswerRecord(row: AnswerRow): AnswerRecord {
  return {
    id: row.id,
    questionId: row.questionId,
    authorId: row.authorId,
    bodyMd: row.bodyMd,
    upvoteCount: row.upvoteCount,
    moderationStatus: moderationStatusOf(row.moderationStatus, 'answers.moderation_status'),
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
  };
}

export function toAnnouncementRecord(row: AnnouncementRow): AnnouncementRecord {
  return {
    id: row.id,
    courseId: row.courseId,
    authorId: row.authorId,
    title: row.title,
    bodyMd: row.bodyMd,
    sendEmail: row.sendEmail,
    createdAt: row.createdAt,
  };
}
