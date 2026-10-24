import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import LearnPage from './page';

const COURSE = '0199c9a1-7d2e-7c4a-9b1e-00000000c001';
const LECTURE = '0199c9a1-7d2e-7c4a-9b1e-000000001e01';

function props(lectureId: string[] | undefined, search: Record<string, string> = {}) {
  return {
    params: Promise.resolve({ courseId: COURSE, ...(lectureId ? { lectureId } : {}) }),
    searchParams: Promise.resolve(search),
  };
}

/** The `<CoursePlayer>` props the page renders (`main > CoursePlayer`). */
async function playerProps(p: ReturnType<typeof props>) {
  const page = (await LearnPage(p as never)) as ReactElement<{ children: ReactElement }>;
  const player = page.props.children;
  expect(isValidElement(player)).toBe(true);
  return player.props as { courseId: string; lectureId: string | null; startAt: number | null };
}

describe('/learn/[courseId]/[[...lectureId]]', () => {
  it('opens the resume lecture, a given lecture, and a ?t= position', async () => {
    expect(await playerProps(props(undefined))).toEqual({
      courseId: COURSE,
      lectureId: null,
      startAt: null,
    });
    expect(await playerProps(props([LECTURE], { t: '83' }))).toEqual({
      courseId: COURSE,
      lectureId: LECTURE,
      startAt: 83,
    });
    expect((await playerProps(props([LECTURE], { t: '-5' }))).startAt).toBeNull();
  });

  it('is a 404 for ids that are not UUIDs (the API is never asked)', async () => {
    await expect(
      LearnPage({
        params: Promise.resolve({ courseId: 'nope' }),
        searchParams: Promise.resolve({}),
      } as never),
    ).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    await expect(LearnPage(props(['nope']) as never)).rejects.toThrow(/404/);
    await expect(LearnPage(props([LECTURE, LECTURE]) as never)).rejects.toThrow(/404/);
  });
});
