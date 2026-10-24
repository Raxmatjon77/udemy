import {
  AnnouncementPageSchema,
  CertificatePageSchema,
  CompletionStateSchema,
  NotePageSchema,
  NoteSchema,
  PlayerBootstrapSchema,
  ProgressAckSchema,
  PublicArticleSchema,
  QuizAttemptDetailSchema,
  QuizAttemptPageSchema,
  QuizAttemptSchema,
  SignedUrlSchema,
  SubmitQuizAttemptResponseSchema,
  type AnnouncementPage,
  type CertificatePage,
  type ClientCompletionCause,
  type CompletionState,
  type CreateNoteRequest,
  type Note,
  type NotePage,
  type PlayerBootstrap,
  type ProgressAck,
  type PublicArticle,
  type QuizAnswer,
  type QuizAttempt,
  type QuizAttemptDetail,
  type QuizAttemptPage,
  type RecordHeartbeatRequest,
  type SignedUrl,
  type SubmitQuizAttemptResponse,
  type UpdateNoteRequest,
} from '@udemy/contracts';

import { api, queryString } from '../api';

/**
 * Browser calls of the Phase 5 learning routes (learning experience design §8 "Student"),
 * through this app's BFF (`/api/proxy/*`). Every response is parsed with its contracts schema.
 */

const id = (value: string) => encodeURIComponent(value);
const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});

const course = (courseId: string) => `/me/courses/${id(courseId)}`;
const lecture = (courseId: string, lectureId: string) =>
  `${course(courseId)}/lectures/${id(lectureId)}`;

/** TanStack Query keys of the learning screens (invalidate by prefix). */
export const learningKeys = {
  all: ['learning'] as const,
  bootstrap: (courseId: string) => ['learning', 'bootstrap', courseId] as const,
  article: (courseId: string, lectureId: string) =>
    ['learning', 'article', courseId, lectureId] as const,
  notes: (courseId: string) => ['learning', 'notes', courseId] as const,
  attempts: (courseId: string, lectureId: string) =>
    ['learning', 'attempts', courseId, lectureId] as const,
  attempt: (attemptId: string) => ['learning', 'attempt', attemptId] as const,
  announcements: (courseId: string) => ['learning', 'announcements', courseId] as const,
  certificates: ['learning', 'certificates'] as const,
};

/** `GET /me/courses/:courseId/learn` (403 `enrollment_required`, 404). */
export function fetchPlayerBootstrap(
  courseId: string,
  signal?: AbortSignal,
): Promise<PlayerBootstrap> {
  return api(`${course(courseId)}/learn`, {
    schema: PlayerBootstrapSchema,
    ...signalOf(signal),
  });
}

/** `PUT …/progress`. `keepalive` lets the request outlive the page (pagehide flush). */
export function sendHeartbeat(
  courseId: string,
  lectureId: string,
  body: RecordHeartbeatRequest,
  options: { keepalive?: boolean } = {},
): Promise<ProgressAck> {
  return api(`${lecture(courseId, lectureId)}/progress`, {
    method: 'PUT',
    json: body,
    schema: ProgressAckSchema,
    ...(options.keepalive ? { keepalive: true } : {}),
  });
}

/** `POST …/completion {cause}` (ARTICLE_READ, RESOURCE_OPENED, MANUAL; idempotent). */
export function completeLecture(
  courseId: string,
  lectureId: string,
  cause: ClientCompletionCause,
): Promise<CompletionState> {
  return api(`${lecture(courseId, lectureId)}/completion`, {
    method: 'POST',
    json: { cause },
    schema: CompletionStateSchema,
  });
}

/** `DELETE …/completion` (un-tick; never revokes a course completion or certificate). */
export function uncompleteLecture(courseId: string, lectureId: string): Promise<CompletionState> {
  return api(`${lecture(courseId, lectureId)}/completion`, {
    method: 'DELETE',
    schema: CompletionStateSchema,
  });
}

/** The live article (`GET /catalog/courses/:courseId/lectures/:lectureId/article`, entitled). */
export function fetchArticle(
  courseId: string,
  lectureId: string,
  signal?: AbortSignal,
): Promise<PublicArticle> {
  return api(`/catalog/courses/${id(courseId)}/lectures/${id(lectureId)}/article`, {
    schema: PublicArticleSchema,
    ...signalOf(signal),
  });
}

/** A RESOURCE lecture's presigned download (`GET /catalog/…/download`, entitled). */
export function fetchDownload(courseId: string, lectureId: string): Promise<SignedUrl> {
  return api(`/catalog/courses/${id(courseId)}/lectures/${id(lectureId)}/download`, {
    schema: SignedUrlSchema,
  });
}

/** Master playlist of a live lecture through the BFF (entitled viewers get every lecture). */
export function lecturePlaylistPath(courseId: string, lectureId: string): string {
  return `/api/proxy/catalog/courses/${id(courseId)}/lectures/${id(lectureId)}/hls/master.m3u8`;
}

/* ------------------------------------------------------------------ notes */

export function fetchNotes(
  courseId: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<NotePage> {
  return api(`${course(courseId)}/notes${queryString({ cursor })}`, {
    schema: NotePageSchema,
    ...signalOf(signal),
  });
}

export function createNote(courseId: string, body: CreateNoteRequest): Promise<Note> {
  return api(`${course(courseId)}/notes`, { method: 'POST', json: body, schema: NoteSchema });
}

export function updateNote(noteId: string, body: UpdateNoteRequest): Promise<Note> {
  return api(`/me/notes/${id(noteId)}`, { method: 'PATCH', json: body, schema: NoteSchema });
}

export function deleteNote(noteId: string): Promise<void> {
  return api(`/me/notes/${id(noteId)}`, { method: 'DELETE' });
}

/* ------------------------------------------------------------------ quizzes */

/** 201 a new attempt, or 200 the open attempt of the live revision (resume). No keys. */
export function startQuizAttempt(courseId: string, lectureId: string): Promise<QuizAttempt> {
  return api(`${lecture(courseId, lectureId)}/quiz-attempts`, {
    method: 'POST',
    schema: QuizAttemptSchema,
  });
}

export function fetchQuizAttempts(
  courseId: string,
  lectureId: string,
  signal?: AbortSignal,
): Promise<QuizAttemptPage> {
  return api(`${lecture(courseId, lectureId)}/quiz-attempts`, {
    schema: QuizAttemptPageSchema,
    ...signalOf(signal),
  });
}

export function fetchQuizAttempt(
  attemptId: string,
  signal?: AbortSignal,
): Promise<QuizAttemptDetail> {
  return api(`/me/quiz-attempts/${id(attemptId)}`, {
    schema: QuizAttemptDetailSchema,
    ...signalOf(signal),
  });
}

export function submitQuizAttempt(
  attemptId: string,
  answers: QuizAnswer[],
): Promise<SubmitQuizAttemptResponse> {
  return api(`/me/quiz-attempts/${id(attemptId)}/submit`, {
    method: 'POST',
    json: { answers },
    schema: SubmitQuizAttemptResponseSchema,
  });
}

/* ------------------------------------------------------------------ announcements */

export function fetchAnnouncements(
  courseId: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<AnnouncementPage> {
  return api(`${course(courseId)}/announcements${queryString({ cursor })}`, {
    schema: AnnouncementPageSchema,
    ...signalOf(signal),
  });
}

/* ------------------------------------------------------------------ certificates */

export function fetchMyCertificates(
  cursor: string | null,
  signal?: AbortSignal,
): Promise<CertificatePage> {
  return api(`/me/certificates${queryString({ cursor })}`, {
    schema: CertificatePageSchema,
    ...signalOf(signal),
  });
}

/** The presigned PDF of one of my certificates (409 `certificate_pdf_pending`). */
export function fetchMyCertificatePdf(certificateId: string): Promise<SignedUrl> {
  return api(`/me/certificates/${id(certificateId)}/pdf`, { schema: SignedUrlSchema });
}

/** The public PDF of an ACTIVE certificate (anyone with the code; quiet: no login redirect). */
export function fetchPublicCertificatePdf(code: string): Promise<SignedUrl> {
  return api(`/certificates/${id(code)}/pdf`, { schema: SignedUrlSchema, quiet: true });
}
