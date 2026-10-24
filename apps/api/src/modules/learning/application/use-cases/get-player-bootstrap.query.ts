import { Injectable } from '@nestjs/common';
import type {
  PersonRef,
  PlayerBootstrap,
  PlayerLecture,
  PlayerMode,
  PlayerResume,
} from '@udemy/contracts';
import type { LiveCurriculum, LiveCurriculumLecture } from '../../../catalog';
import { UsersFacade } from '../../../users';
import { courseProgressOf } from '../../domain/completion-policy';
import { bucketCountOf, coveragePctOf } from '../../domain/progress-rules';
import { CompletionRecorder } from '../completion-recorder';
import { LearnerAccess, liveLecturesOf } from '../learner-access';
import { LearningSettings } from '../learning-settings';
import {
  type CertificateRef,
  type LectureCompletionRecord,
  LearningRepository,
} from '../ports/learning.repository';
import { ProgressRepository } from '../ports/progress.repository';
import { type LiveLectureProgress, ProgressStore } from '../ports/progress-store';
import { TransactionRunner } from '../ports/transaction-runner';

export interface GetPlayerBootstrapInput {
  readonly userId: string;
  readonly courseId: string;
}

interface LearnerState {
  readonly completions: ReadonlyMap<string, LectureCompletionRecord>;
  readonly progress: ReadonlyMap<string, LiveLectureProgress>;
  readonly resume: PlayerResume | null;
  readonly completedAt: Date | null;
  readonly certificate: CertificateRef | null;
}

const EMPTY_STATE: LearnerState = {
  completions: new Map(),
  progress: new Map(),
  resume: null,
  completedAt: null,
  certificate: null,
};

/** A live VIDEO lecture with everything progress needs (asset and duration). */
function isMeasurableVideo(
  lecture: LiveCurriculumLecture,
): lecture is LiveCurriculumLecture & { mediaAssetId: string; durationSeconds: number } {
  return (
    lecture.type === 'VIDEO' &&
    lecture.mediaAssetId !== null &&
    lecture.durationSeconds !== null &&
    lecture.durationSeconds > 0
  );
}

/**
 * `GetPlayerBootstrap` (design §5; `GET /me/courses/:courseId/learn`): the live curriculum
 * annotated with the learner's completions, positions (the Redis buffer first, then the DB)
 * and coverage; the course progress, the resume point (`course_activity`, else the first
 * incomplete lecture), the permanent completion and the certificate reference.
 *
 * LEARNER: an ACTIVE enrollment. PREVIEW: the owner without one, read-only, with every learner
 * field empty. Anyone else: 403. Lazily runs `EvaluateCourseCompletion` (D5) when the learner
 * has completed every live lecture but has no course completion yet (a revision that removed
 * the last missing lecture), so the GET writes only in that case.
 *
 * Only progress measured against the LIVE asset and duration is shown (D3): a re-uploaded
 * video starts from zero.
 */
@Injectable()
export class GetPlayerBootstrapQuery {
  constructor(
    private readonly access: LearnerAccess,
    private readonly users: UsersFacade,
    private readonly completions: LearningRepository,
    private readonly progressRepo: ProgressRepository,
    private readonly store: ProgressStore,
    private readonly recorder: CompletionRecorder,
    private readonly tx: TransactionRunner,
    private readonly settings: LearningSettings,
  ) {}

  async execute(input: GetPlayerBootstrapInput): Promise<PlayerBootstrap> {
    const curriculum = await this.access.curriculum(input.courseId);
    const mode = await this.access.mode(input.userId, curriculum);
    const [instructor, state] = await Promise.all([
      this.instructorOf(curriculum.ownerId),
      mode === 'LEARNER' ? this.learnerState(input.userId, curriculum) : EMPTY_STATE,
    ]);
    return this.assemble(curriculum, mode, instructor, state);
  }

  private async instructorOf(ownerId: string): Promise<PersonRef | null> {
    const profile = await this.users.getPublicProfile(ownerId);
    return profile === null ? null : { id: profile.id, displayName: profile.displayName };
  }

  private async learnerState(userId: string, curriculum: LiveCurriculum): Promise<LearnerState> {
    const lectures = liveLecturesOf(curriculum);
    const videos = lectures.filter(isMeasurableVideo);
    const [
      completionRows,
      courseCompletion,
      certificate,
      stored,
      buffered,
      storedActivity,
      bufferedActivity,
    ] = await Promise.all([
      this.completions.listCompletions(userId, curriculum.courseId),
      this.completions.findCourseCompletion(userId, curriculum.courseId),
      this.completions.findCertificate(userId, curriculum.courseId),
      this.progressRepo.listCourseProgress(userId, curriculum.courseId),
      this.store.readBuffered(
        userId,
        videos.map((v) => ({
          lectureId: v.id,
          mediaAssetId: v.mediaAssetId,
          durationSeconds: v.durationSeconds,
        })),
      ),
      this.progressRepo.findActivity(userId, curriculum.courseId),
      this.store.readBufferedActivity(userId, curriculum.courseId),
    ]);

    const completions = new Map(completionRows.map((c) => [c.lectureId, c]));
    let completedAt = courseCompletion?.completedAt ?? null;
    const liveIds = lectures.map((l) => l.id);
    if (
      completedAt === null &&
      liveIds.length > 0 &&
      courseProgressOf(new Set(completions.keys()), liveIds).completed === liveIds.length
    ) {
      const outcome = await this.tx.run((trx) => this.recorder.evaluate(trx, userId, curriculum));
      completedAt = outcome.course.completion?.completedAt ?? null;
    }

    // The DB rows of the live asset, overlaid by the (newer) Redis buffer.
    const progress = new Map<string, LiveLectureProgress>();
    const byId = new Map(videos.map((v) => [v.id, v]));
    for (const row of stored) {
      const video = byId.get(row.lectureId);
      if (
        video === undefined ||
        row.mediaAssetId !== video.mediaAssetId ||
        row.durationSeconds !== video.durationSeconds
      ) {
        continue;
      }
      progress.set(row.lectureId, {
        positionSeconds: row.positionSeconds,
        coveredBuckets: row.coveredBuckets,
        bucketCount: row.bucketCount,
      });
    }
    for (const [lectureId, live] of buffered) progress.set(lectureId, live);

    const resume = this.resumeOf(lectures, completions, progress, [
      storedActivity === null
        ? null
        : { lectureId: storedActivity.lectureId, atMs: storedActivity.accessedAt.getTime() },
      bufferedActivity,
    ]);
    return { completions, progress, resume, completedAt, certificate };
  }

  /** The newest activity on a live lecture, else the first incomplete one, else the first. */
  private resumeOf(
    lectures: readonly LiveCurriculumLecture[],
    completions: ReadonlyMap<string, LectureCompletionRecord>,
    progress: ReadonlyMap<string, LiveLectureProgress>,
    activities: readonly ({ readonly lectureId: string; readonly atMs: number } | null)[],
  ): PlayerResume | null {
    if (lectures.length === 0) return null;
    const live = new Set(lectures.map((l) => l.id));
    const newest = activities
      .filter((a): a is { lectureId: string; atMs: number } => a !== null && live.has(a.lectureId))
      .sort((a, b) => b.atMs - a.atMs)[0];
    const lectureId =
      newest?.lectureId ?? (lectures.find((l) => !completions.has(l.id)) ?? lectures[0]!).id;
    return { lectureId, positionSeconds: progress.get(lectureId)?.positionSeconds ?? null };
  }

  private assemble(
    curriculum: LiveCurriculum,
    mode: PlayerMode,
    instructor: PersonRef | null,
    state: LearnerState,
  ): PlayerBootstrap {
    const liveIds = liveLecturesOf(curriculum).map((l) => l.id);
    const progress = courseProgressOf(new Set(state.completions.keys()), liveIds);
    return {
      courseId: curriculum.courseId,
      slug: curriculum.slug,
      title: curriculum.title,
      status: curriculum.status,
      liveRevisionId: curriculum.liveRevisionId,
      mode,
      instructor,
      sections: curriculum.sections.map((section) => ({
        id: section.id,
        title: section.title,
        lectures: section.lectures.map((lecture) => this.lectureView(lecture, state)),
      })),
      progress,
      resume: state.resume,
      completedAt: state.completedAt?.toISOString() ?? null,
      newContent: state.completedAt !== null && progress.pct < 100,
      certificate: state.certificate,
    };
  }

  private lectureView(lecture: LiveCurriculumLecture, state: LearnerState): PlayerLecture {
    const completion = state.completions.get(lecture.id);
    const progress = lecture.type === 'VIDEO' ? state.progress.get(lecture.id) : undefined;
    const duration = lecture.type === 'VIDEO' ? lecture.durationSeconds : null;
    let coveragePct: number | null = null;
    if (progress !== undefined && duration !== null && duration > 0) {
      const buckets = bucketCountOf(duration, this.settings.bucketSeconds);
      coveragePct = coveragePctOf(Math.min(progress.coveredBuckets, buckets), buckets);
    }
    return {
      id: lecture.id,
      type: lecture.type,
      title: lecture.title,
      durationSeconds: duration,
      isPreview: lecture.isPreview,
      quiz: lecture.type === 'QUIZ' ? lecture.quiz : null,
      completed: completion !== undefined,
      completedAt: completion?.completedAt.toISOString() ?? null,
      positionSeconds:
        progress === undefined || duration === null
          ? null
          : Math.min(Math.max(progress.positionSeconds, 0), duration),
      coveragePct,
    };
  }
}
