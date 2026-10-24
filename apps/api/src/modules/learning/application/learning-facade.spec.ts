import { describe, expect, it } from 'vitest';
import {
  ARTICLE,
  COURSE,
  curriculumOf,
  learningHarness,
  lecture,
  OTHER_STUDENT,
  STUDENT,
  VIDEO,
} from './testing/learning.fakes';

const OTHER_COURSE = '01900000-0000-7000-8000-00000000c002';
const EMPTY_COURSE = '01900000-0000-7000-8000-00000000c003';

describe('LearningFacade', () => {
  it('completedLectureCount counts completions of LIVE lectures only (the review gate)', async () => {
    const h = learningHarness();
    expect(await h.facade.completedLectureCount(STUDENT, COURSE)).toBe(0);
    h.completions.seedCompletion(STUDENT, COURSE, VIDEO, 'VIDEO', 'VIDEO_WATCHED');
    h.completions.seedCompletion(STUDENT, COURSE, ARTICLE, 'ARTICLE', 'MANUAL');
    expect(await h.facade.completedLectureCount(STUDENT, COURSE)).toBe(2);
    // a revision removed the article: it stops counting
    h.catalog.curricula.set(COURSE, curriculumOf([lecture(VIDEO, 'VIDEO')]));
    expect(await h.facade.completedLectureCount(STUDENT, COURSE)).toBe(1);
    expect(await h.facade.completedLectureCount(OTHER_STUDENT, COURSE)).toBe(0);
    expect(await h.facade.completedLectureCount(STUDENT, OTHER_COURSE)).toBe(0);
    expect(await h.facade.completedLectureCount('nope', COURSE)).toBe(0);
  });

  it('getConsumption passes the live curriculum to the consumption query', async () => {
    const h = learningHarness();
    h.completions.seedCompletion(STUDENT, COURSE, VIDEO, 'VIDEO', 'VIDEO_WATCHED');
    expect(await h.facade.getConsumption(STUDENT, COURSE)).toEqual({
      videoSecondsWatched: 0,
      videoSecondsTotal: 100,
      completedLectures: 1,
      totalLectures: 4,
      courseCompletedAt: null,
      certificateStatus: null,
    });
    expect(await h.facade.getConsumption(STUDENT, OTHER_COURSE)).toMatchObject({
      totalLectures: 0,
      videoSecondsTotal: 0,
    });
    expect(await h.facade.getConsumption('nope', COURSE)).toMatchObject({ totalLectures: 0 });
  });
});

describe('LearningProgressReader (COURSE_PROGRESS)', () => {
  it('reports ⌊completed ∩ live / live × 100⌋, 0 included; unknown courses are absent', async () => {
    const h = learningHarness();
    h.catalog.curricula.set(EMPTY_COURSE, { ...curriculumOf([]), courseId: EMPTY_COURSE });
    h.completions.seedCompletion(STUDENT, COURSE, VIDEO, 'VIDEO', 'VIDEO_WATCHED');
    const percents = await h.reader.getPercents(STUDENT, [COURSE, OTHER_COURSE, EMPTY_COURSE]);
    expect(percents).toEqual(
      new Map([
        [COURSE, 25],
        [EMPTY_COURSE, 0],
      ]),
    );
    expect(await h.reader.getPercents('nope', [COURSE])).toEqual(new Map());
  });

  it('asks catalog in chunks of at most 48 courses', async () => {
    const h = learningHarness();
    const ids = Array.from(
      { length: 100 },
      (_, i) => `01900000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    await h.reader.getPercents(STUDENT, ids);
    expect(h.catalog.indexCalls.map((c) => c.length)).toEqual([48, 48, 4]);
  });
});
