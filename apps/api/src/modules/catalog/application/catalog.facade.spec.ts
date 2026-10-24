import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CatalogFacade,
  LIVE_CURRICULUM_INDEX_MAX_IDS,
  type QuizForAttempt,
} from './catalog.facade';
import { CatalogSettings } from './catalog-settings';
import { LIVE_POINTER_TTL_MS, LiveRevisionCache, LruCache } from './live-revision-cache';
import { CatalogClock } from './ports/catalog-clock';
import { FakePublicCatalogRepository } from './testing/catalog.fakes';
import { type CatalogHarness, createCatalogHarness } from './testing/catalog.harness';

/*
 * The Phase 5 CatalogFacade reads (learning experience design §3) on the in-memory catalog:
 * a course built, submitted and approved through the real use cases, then read through the
 * facade. The answer key must never reach the learner-facing method (D6, Q5).
 */

const OWNER = '00000000-0000-7000-8000-0000000000a1';
const ADMIN = '00000000-0000-7000-8000-0000000000c3';
const DESCRIPTION = `${'This course teaches TypeScript from the ground up. '.repeat(6)}`;
const ARTICLE = 'An article body that is clearly longer than fifty characters in total.';
const EXPLANATION = 'The secret explanation of the answer.';

class FakeClock extends CatalogClock {
  now = Date.UTC(2026, 9, 24, 12, 0, 0);
  nowMs(): number {
    return this.now;
  }
}

/** Every key name anywhere in a JSON tree. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
  }
  return [];
}

describe('CatalogFacade: Phase 5 live curriculum and quiz reads', () => {
  let h: CatalogHarness;
  let clock: FakeClock;
  let catalog: FakePublicCatalogRepository;
  let facade: CatalogFacade;
  let courseId: string;
  let sectionId: string;
  let videoId: string;
  let articleId: string;
  let quizId: string;
  let questionIds: string[];
  let revisionId: string;
  let outlineLoads: ReturnType<typeof vi.spyOn>;
  let quizLoads: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    h = createCatalogHarness(new CatalogSettings({ minLectures: 2, minVideoSeconds: 0 }));
    h.people.people.set(OWNER, { displayName: 'Owner Name', banned: false });
    const group = await h.createCategory.execute({ name: 'Development' });
    const leafId = (await h.createCategory.execute({ name: 'Web', parentId: group.id })).id;
    courseId = (await h.createCourse.execute({ ownerId: OWNER, title: 'Facade course' })).id;
    const as = { actorId: OWNER, courseId };
    await h.updateCourse.execute({
      ...as,
      changes: {
        subtitle: 'A subtitle for the course',
        descriptionMd: DESCRIPTION,
        language: 'en',
        level: 'BEGINNER',
        categoryId: leafId,
        outcomes: ['One', 'Two', 'Three', 'Four'],
      },
    });
    const thumb = h.media.addAsset({ ownerId: OWNER, purpose: 'COURSE_THUMBNAIL' });
    await h.setThumbnail.execute({ ...as, assetId: thumb.id });
    sectionId = (await h.addSection.execute({ ...as, title: 'Section one' })).id;
    videoId = (await h.addLecture.execute({ ...as, sectionId, type: 'VIDEO', title: 'Video' })).id;
    const video = h.media.addAsset({ ownerId: OWNER, purpose: 'LECTURE_VIDEO' });
    await h.attachMedia.execute({ ...as, lectureId: videoId, assetId: video.id });
    articleId = (await h.addLecture.execute({ ...as, sectionId, type: 'ARTICLE', title: 'Art' }))
      .id;
    await h.saveArticle.execute({ ...as, lectureId: articleId, bodyMd: ARTICLE });
    quizId = (await h.addLecture.execute({ ...as, sectionId, type: 'QUIZ', title: 'Quiz' })).id;
    await h.updateQuizSettings.execute({ ...as, lectureId: quizId, passPct: 75 });
    questionIds = [];
    for (const [kind, correct] of [
      ['SINGLE_CHOICE', [false, true]],
      ['MULTIPLE_CHOICE', [true, false, true]],
    ] as const) {
      const q = await h.addQuizQuestion.execute({
        ...as,
        lectureId: quizId,
        kind,
        promptMd: `Question ${kind}`,
        explanationMd: EXPLANATION,
      });
      await h.putQuizOptions.execute({
        ...as,
        lectureId: quizId,
        questionId: q.id,
        options: correct.map((isCorrect, i) => ({ text: `Option ${i}`, isCorrect })),
      });
      questionIds.push(q.id);
    }
    revisionId = (await h.submit.execute({ actorId: OWNER, courseId })).revisionId;
    await h.approve.execute({ actorId: ADMIN, courseId, revisionId });

    clock = new FakeClock();
    catalog = new FakePublicCatalogRepository(h.world);
    outlineLoads = vi.spyOn(h.revisions, 'findOutlines');
    quizLoads = vi.spyOn(h.revisions, 'findQuiz');
    facade = new CatalogFacade(
      catalog,
      h.revisions,
      h.media.asFacade(),
      new LiveRevisionCache(clock),
    );
  });

  it('getLiveCurriculum: the live outline by id, quiz summary only', async () => {
    const curriculum = await facade.getLiveCurriculum(courseId);
    expect(curriculum).toEqual({
      courseId,
      ownerId: OWNER,
      status: 'PUBLISHED',
      liveRevisionId: revisionId,
      slug: expect.any(String) as string,
      title: 'Facade course',
      sections: [
        {
          id: sectionId,
          title: 'Section one',
          lectures: [
            {
              id: videoId,
              type: 'VIDEO',
              title: 'Video',
              durationSeconds: 600,
              isPreview: false,
              mediaAssetId: expect.any(String) as string,
              quiz: null,
            },
            {
              id: articleId,
              type: 'ARTICLE',
              title: 'Art',
              durationSeconds: null,
              isPreview: false,
              mediaAssetId: null,
              quiz: null,
            },
            {
              id: quizId,
              type: 'QUIZ',
              title: 'Quiz',
              durationSeconds: null,
              isPreview: false,
              mediaAssetId: null,
              quiz: { questionCount: 2, passPct: 75 },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(curriculum)).not.toMatch(/isCorrect|explanation|Option 0/);
    expect(Object.isFrozen(curriculum)).toBe(true);
    expect(await facade.getLiveCurriculum('not-a-uuid')).toBeNull();
  });

  it('the live curriculum follows a new live revision; working-copy edits never show', async () => {
    await h.updateQuizSettings.execute({
      actorId: OWNER,
      courseId,
      lectureId: quizId,
      passPct: 90,
    });
    const stale = await facade.getLiveCurriculum(courseId);
    expect(stale?.sections[0]?.lectures[2]?.quiz).toEqual({ questionCount: 2, passPct: 75 });
    const r2 = (await h.submit.execute({ actorId: OWNER, courseId })).revisionId;
    await h.approve.execute({ actorId: ADMIN, courseId, revisionId: r2 });
    const fresh = await facade.getLiveCurriculum(courseId);
    expect(fresh?.liveRevisionId).toBe(r2);
    expect(fresh?.sections[0]?.lectures[2]?.quiz).toEqual({ questionCount: 2, passPct: 90 });
  });

  it('revision outlines are cached (LRU): one load per revision, whatever the method', async () => {
    await facade.getLiveCurriculum(courseId);
    await facade.getLiveCurriculum(courseId);
    await facade.getLiveLecture(courseId, videoId);
    await facade.getLiveCurriculumIndex([courseId]);
    expect(outlineLoads).toHaveBeenCalledTimes(1);
  });

  it('getLiveLecture: the hot path caches the live pointer for 30 s; with ex it reads fresh', async () => {
    expect(await facade.getLiveLecture(courseId, videoId)).toEqual({
      courseId,
      ownerId: OWNER,
      status: 'PUBLISHED',
      liveRevisionId: revisionId,
      lectureId: videoId,
      type: 'VIDEO',
      durationSeconds: 600,
      mediaAssetId: expect.any(String) as string,
    });
    const reads = catalog.findLiveCourseCalls;
    await facade.getLiveLecture(courseId, quizId);
    expect(catalog.findLiveCourseCalls).toBe(reads); // cached pointer

    // archive: seen only after the TTL (or at once inside a transaction)
    const stored = h.world.state.courses.get(courseId);
    if (stored === undefined) throw new Error('fixture');
    stored.status = 'ARCHIVED';
    expect((await facade.getLiveLecture(courseId, videoId))?.status).toBe('PUBLISHED');
    const trx = {} as never;
    expect((await facade.getLiveLecture(courseId, videoId, trx))?.status).toBe('ARCHIVED');
    clock.now += LIVE_POINTER_TTL_MS - 1;
    expect((await facade.getLiveLecture(courseId, videoId))?.status).toBe('PUBLISHED');
    clock.now += 1;
    expect((await facade.getLiveLecture(courseId, videoId))?.status).toBe('ARCHIVED');
  });

  it('getLiveLecture: null for a lecture outside the live revision or an unknown course', async () => {
    const draft = await h.addLecture.execute({
      actorId: OWNER,
      courseId,
      sectionId,
      type: 'VIDEO',
      title: 'Draft only',
    });
    expect(await facade.getLiveLecture(courseId, draft.id)).toBeNull();
    expect(await facade.getLiveLecture('00000000-0000-7000-8000-00000000ffff', videoId)).toBeNull();
    // a failed lookup never caches a pointer
    expect(await facade.getLiveLecture('00000000-0000-7000-8000-00000000ffff', videoId)).toBeNull();
  });

  it('getLiveCurriculumIndex: lecture ids and video seconds; at most 48 ids', async () => {
    const index = await facade.getLiveCurriculumIndex([
      courseId,
      courseId,
      '00000000-0000-7000-8000-00000000ffff',
      'not-a-uuid',
    ]);
    expect([...index.entries()]).toEqual([
      [
        courseId,
        {
          liveRevisionId: revisionId,
          lectureIds: [videoId, articleId, quizId],
          videoSecondsTotal: 600,
        },
      ],
    ]);
    const tooMany = Array.from(
      { length: LIVE_CURRICULUM_INDEX_MAX_IDS + 1 },
      (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    await expect(facade.getLiveCurriculumIndex(tooMany)).rejects.toBeInstanceOf(RangeError);
  });

  describe('quizzes: the learner view never carries the answer key', () => {
    it('getQuizForAttempt: questions and option texts of the live revision, nothing else', async () => {
      const attempt = await facade.getQuizForAttempt(courseId, quizId);
      expect(attempt).toEqual<QuizForAttempt>({
        revisionId,
        passPct: 75,
        questions: [
          {
            id: questionIds[0] ?? '',
            position: 0,
            kind: 'SINGLE_CHOICE',
            promptMd: 'Question SINGLE_CHOICE',
            options: [
              { position: 0, text: 'Option 0' },
              { position: 1, text: 'Option 1' },
            ],
          },
          {
            id: questionIds[1] ?? '',
            position: 1,
            kind: 'MULTIPLE_CHOICE',
            promptMd: 'Question MULTIPLE_CHOICE',
            options: [
              { position: 0, text: 'Option 0' },
              { position: 1, text: 'Option 1' },
              { position: 2, text: 'Option 2' },
            ],
          },
        ],
      });
      const keys = keysOf(attempt);
      for (const forbidden of ['isCorrect', 'correct', 'explanationMd']) {
        expect(keys).not.toContain(forbidden);
      }
      expect(JSON.stringify(attempt)).not.toContain(EXPLANATION);
    });

    it('getQuizForAttempt stays key-free after the key was cached by grading', async () => {
      await facade.getQuizAnswerKey(revisionId, quizId); // warms the shared quiz cache
      const attempt = await facade.getQuizForAttempt(courseId, quizId);
      expect(JSON.stringify(attempt)).not.toMatch(/isCorrect|"correct"|explanation/i);
      expect(quizLoads).toHaveBeenCalledTimes(1);
    });

    it('getQuizForAttempt: null for non-QUIZ, non-live and unknown lectures', async () => {
      expect(await facade.getQuizForAttempt(courseId, videoId)).toBeNull();
      expect(await facade.getQuizForAttempt(courseId, articleId)).toBeNull();
      expect(
        await facade.getQuizForAttempt('00000000-0000-7000-8000-00000000ffff', quizId),
      ).toBeNull();
      const draftQuiz = await h.addLecture.execute({
        actorId: OWNER,
        courseId,
        sectionId,
        type: 'QUIZ',
        title: 'Not approved yet',
      });
      expect(await facade.getQuizForAttempt(courseId, draftQuiz.id)).toBeNull();
    });

    it('getQuizAnswerKey: the key of THAT revision, even after a newer revision went live', async () => {
      const key = await facade.getQuizAnswerKey(revisionId, quizId);
      expect(key).toEqual({
        revisionId,
        lectureId: quizId,
        passPct: 75,
        questions: [
          {
            id: questionIds[0],
            position: 0,
            kind: 'SINGLE_CHOICE',
            correct: [1],
            explanationMd: EXPLANATION,
          },
          {
            id: questionIds[1],
            position: 1,
            kind: 'MULTIPLE_CHOICE',
            correct: [0, 2],
            explanationMd: EXPLANATION,
          },
        ],
      });

      // a new revision flips the first key; the old revision's key is unchanged
      const [first] = questionIds;
      if (first === undefined) throw new Error('fixture');
      await h.putQuizOptions.execute({
        actorId: OWNER,
        courseId,
        lectureId: quizId,
        questionId: first,
        options: [
          { text: 'Option 0', isCorrect: true },
          { text: 'Option 1', isCorrect: false },
        ],
      });
      const r2 = (await h.submit.execute({ actorId: OWNER, courseId })).revisionId;
      await h.approve.execute({ actorId: ADMIN, courseId, revisionId: r2 });
      expect((await facade.getQuizAnswerKey(revisionId, quizId))?.questions[0]?.correct).toEqual([
        1,
      ]);
      expect((await facade.getQuizAnswerKey(r2, quizId))?.questions[0]?.correct).toEqual([0]);
      expect((await facade.getQuizForAttempt(courseId, quizId))?.revisionId).toBe(r2);
      expect(await facade.getQuizAnswerKey(revisionId, videoId)).toBeNull();
    });

    it('callers get copies: mutating a returned key does not corrupt the cache', async () => {
      const key = await facade.getQuizAnswerKey(revisionId, quizId);
      (key?.questions[0]?.correct as number[]).push(0);
      expect((await facade.getQuizAnswerKey(revisionId, quizId))?.questions[0]?.correct).toEqual([
        1,
      ]);
      expect(quizLoads).toHaveBeenCalledTimes(1);
    });
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry beyond its size', () => {
    const lru = new LruCache<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1); // a is now the most recent
    lru.set('c', 3);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);
    expect(lru.size).toBe(2);
    expect(() => new LruCache(0)).toThrow(RangeError);
  });
});
