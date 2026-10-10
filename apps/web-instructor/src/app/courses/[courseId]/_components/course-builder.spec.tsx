// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  CourseDetailSchema,
  CurriculumSchema,
  ReorderCurriculumRequestSchema,
  UpdateCourseRequestSchema,
  type CourseDetail,
  type Curriculum,
} from '@udemy/contracts';

import { categoryTree, courseDetail, curriculum, history, IDS, lockedCourse } from '@/test/fixtures';
import { problem, proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import type { BuilderTab } from './builder-tabs';
import { CourseBuilder } from './course-builder';

setupMockApi();

interface Counters {
  course: number;
  curriculum: number;
}

/** GET handlers for everything the builder loads; `course`/`curriculum` may change per call. */
function builderApi({
  course = () => courseDetail(),
  curr = () => curriculum(),
}: { course?: (n: number) => CourseDetail; curr?: (n: number) => Curriculum } = {}): Counters {
  const counters: Counters = { course: 0, curriculum: 0 };
  server.use(
    http.get(proxy(`/courses/${IDS.course}`), () => {
      counters.course += 1;
      return HttpResponse.json(CourseDetailSchema.parse(course(counters.course)));
    }),
    http.get(proxy(`/courses/${IDS.course}/curriculum`), () => {
      counters.curriculum += 1;
      return HttpResponse.json(CurriculumSchema.parse(curr(counters.curriculum)));
    }),
    http.get(proxy(`/courses/${IDS.course}/history`), () => HttpResponse.json(history())),
    http.get(proxy('/catalog/categories'), () => HttpResponse.json(categoryTree())),
  );
  return counters;
}

function renderBuilder(initialTab: BuilderTab = 'details') {
  return renderWithClient(<CourseBuilder courseId={IDS.course} initialTab={initialTab} />);
}

describe('curriculum reorder', () => {
  it('sends the FULL order after a move and shows the server result', async () => {
    builderApi();
    let payload: unknown;
    server.use(
      http.put(proxy(`/courses/${IDS.course}/curriculum/order`), async ({ request }) => {
        payload = ReorderCurriculumRequestSchema.parse(await request.json());
        // The server's view after the move: "Setup" is first in "Deep dive".
        const next = curriculum();
        const [a, b] = next.sections;
        const setup = a!.lectures.pop()!;
        b!.lectures.unshift({ ...setup, sectionId: b!.id });
        b!.lectures.forEach((lecture, i) => (lecture.position = i));
        return HttpResponse.json(CurriculumSchema.parse({ ...next, version: 4 }));
      }),
    );
    const user = userEvent.setup();
    renderBuilder('curriculum');

    await user.click(await screen.findByRole('button', { name: 'Move lecture “Setup” down' }));

    await waitFor(() =>
      expect(payload).toEqual({
        sections: [
          { sectionId: IDS.sectionA, lectureIds: [IDS.lecture1] },
          { sectionId: IDS.sectionB, lectureIds: [IDS.lecture2, IDS.lecture3] },
        ],
      }),
    );
    const deepDive = screen.getByRole('list', { name: 'Lectures of section 2' });
    await waitFor(() =>
      expect(within(deepDive).getAllByRole('listitem').map((li) => li.dataset.lectureId)).toEqual([
        IDS.lecture2,
        IDS.lecture3,
      ]),
    );
  });

  it('on 409 order_mismatch refetches the curriculum and tells the user', async () => {
    const counters = builderApi();
    server.use(
      http.put(proxy(`/courses/${IDS.course}/curriculum/order`), () => problem(409, 'order_mismatch')),
    );
    const user = userEvent.setup();
    renderBuilder('curriculum');

    await user.click(await screen.findByRole('button', { name: 'Move section “Deep dive” up' }));

    expect(await screen.findByText(/changed somewhere else\. We reloaded it/)).toBeTruthy();
    await waitFor(() => expect(counters.curriculum).toBe(2));
    // Back to the server order.
    const sections = screen.getByRole('list', { name: 'Sections' });
    expect(within(sections).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Section 1: Getting started',
      'Section 2: Deep dive',
    ]);
  });
});

describe('review lock (D2)', () => {
  it('makes the builder read-only while in review, until withdrawn', async () => {
    builderApi({ course: (n) => (n === 1 ? lockedCourse() : courseDetail()) });
    let withdrawn = 0;
    server.use(
      http.post(proxy(`/courses/${IDS.course}/withdraw`), () => {
        withdrawn += 1;
        return HttpResponse.json(courseDetail());
      }),
    );
    const user = userEvent.setup();
    renderBuilder();

    expect(await screen.findByText('Waiting for review: the course is read-only')).toBeTruthy();
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    expect(title.matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save details' })).toBeNull();
    expect((screen.getByLabelText('Upload image') as HTMLInputElement).disabled).toBe(true);

    await user.click(screen.getByRole('tab', { name: 'Curriculum' }));
    expect(await screen.findByRole('heading', { name: 'Section 1: Getting started' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Reorder / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Move lecture/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add section' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Withdraw to edit' }));
    await waitFor(() => expect(screen.queryByText('Waiting for review: the course is read-only')).toBeNull());
    expect(withdrawn).toBe(1);
    expect(await screen.findByRole('button', { name: 'Add section' })).toBeTruthy();
    expect((screen.getByLabelText('Title') as HTMLInputElement).matches(':disabled')).toBe(false);
  });
});

describe('details: optimistic version', () => {
  it('shows a reload prompt on 409 version_conflict and reloads the latest version', async () => {
    const counters = builderApi({
      course: (n) =>
        n === 1 ? courseDetail() : courseDetail({ version: 5, subtitle: 'Changed in another tab!' }),
    });
    let sent: unknown;
    server.use(
      http.patch(proxy(`/courses/${IDS.course}`), async ({ request }) => {
        sent = UpdateCourseRequestSchema.parse(await request.json());
        return problem(409, 'version_conflict');
      }),
    );
    const user = userEvent.setup();
    renderBuilder();

    const subtitle = (await screen.findByLabelText('Subtitle')) as HTMLInputElement;
    await user.type(subtitle, 'My own subtitle text');
    await user.click(screen.getByRole('button', { name: 'Save details' }));

    expect(await screen.findByText('This course was changed somewhere else')).toBeTruthy();
    expect(sent).toEqual({ subtitle: 'My own subtitle text', expectedVersion: 3 });
    // Editing is blocked until the reload.
    expect(subtitle.matches(':disabled')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Reload latest version' }));
    await waitFor(() => expect(screen.queryByText('This course was changed somewhere else')).toBeNull());
    expect(counters.course).toBe(2);
    expect((screen.getByLabelText('Subtitle') as HTMLInputElement).value).toBe('Changed in another tab!');
  });
});

describe('readiness', () => {
  it('links each issue to the field where it is fixed', async () => {
    builderApi();
    const user = userEvent.setup();
    renderBuilder('review');

    expect(await screen.findByText('Before you can submit (2 items left)')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Submit for review' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Go to details: Add a subtitle.' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Subtitle')));
    expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true');
  });
});
