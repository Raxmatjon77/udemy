// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { MyCoursePageSchema } from '@udemy/contracts';
import {
  FIXTURE_IDS,
  LEARNING_FIXTURE_IDS,
  type LearningMockStore,
} from '@udemy/contracts/testing';

import { asStudent, COURSE, enrollStudent, installLearning } from '@/test/learning';
import { proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { QaInbox } from './qa-inbox';

setupMockApi();

const COURSE2 = FIXTURE_IDS.course2;
const NOW = '2026-10-10T10:00:00.000Z';

/** `GET /instructor/courses` (catalog, not part of the Phase 5 mock). */
function myCourses() {
  server.use(
    http.get(proxy('/instructor/courses'), () =>
      HttpResponse.json(
        MyCoursePageSchema.parse({
          items: [
            { id: COURSE, slug: 'complete-typescript', title: 'Complete TypeScript' },
            { id: COURSE2, slug: 'postgres-in-depth', title: 'PostgreSQL in Depth' },
            { id: FIXTURE_IDS.freeCourse, slug: 'draft', title: 'A draft course', status: 'DRAFT' },
          ].map((c) => ({
            status: 'PUBLISHED',
            badge: 'LIVE',
            thumbnailAssetId: null,
            firstPublishedAt: NOW,
            updatedAt: NOW,
            ...c,
          })),
          nextCursor: null,
        }),
      ),
    ),
  );
}

function ask(store: LearningMockStore, title: string, courseId = COURSE, lectureId?: string) {
  return asStudent(store, () =>
    store.askQuestion(courseId, {
      title,
      bodyMd: `Details about **${title}**`,
      ...(lectureId ? { lectureId } : {}),
    }),
  );
}

function setup(seed: (store: LearningMockStore) => void = () => {}) {
  const store = installLearning();
  enrollStudent(store, COURSE);
  enrollStudent(store, COURSE2);
  // A second learner (named "Root Admin" in the default users) who answers questions.
  enrollStudent(store, COURSE, FIXTURE_IDS.admin);
  myCourses();
  seed(store);
  const user = userEvent.setup();
  return { store, user };
}

const questionItem = (title: string) => screen.findByRole('listitem', { name: title });

describe('<QaInbox>', () => {
  it('lists unanswered questions first, with course and lecture', async () => {
    setup((s) => {
      ask(s, 'Why does narrowing fail here?', COURSE, LEARNING_FIXTURE_IDS.lectureVideo);
      const answered = ask(s, 'Is there a cheat sheet?');
      asStudent(
        s,
        () => s.postAnswer(COURSE, answered.id, 'Yes, in section 2.'),
        FIXTURE_IDS.admin,
      );
    });
    renderWithClient(<QaInbox />);
    const item = await questionItem('Why does narrowing fail here?');
    expect(within(item).getByText('Complete TypeScript · Welcome')).toBeTruthy();
    expect(within(item).getByText('0 answers')).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: 'Is there a cheat sheet?' })).toBeNull();
    expect((screen.getByLabelText('Show') as HTMLSelectElement).value).toBe('unanswered');
  });

  it('answers as the instructor (badge), which takes the question off the unanswered list', async () => {
    const { store, user } = setup((s) => {
      ask(s, 'How do I type a reducer?');
    });
    renderWithClient(<QaInbox />);
    const item = await questionItem('How do I type a reducer?');
    await user.click(
      within(item).getByRole('button', { name: 'Open question “How do I type a reducer?”' }),
    );
    expect(await within(item).findByText('No answers yet. Be the first to answer.')).toBeTruthy();
    const form = within(item).getByRole('form', { name: 'Your answer' });
    expect(within(form).getByText('Instructor')).toBeTruthy();

    await user.type(within(form).getByLabelText('Your answer'), 'Use a **discriminated union**.');
    await user.click(within(form).getByRole('button', { name: 'Post answer' }));

    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'How do I type a reducer?' })).toBeNull(),
    );
    expect(await screen.findByText('No unanswered questions. Nice work!')).toBeTruthy();
    const [question] = store.listQuestions(COURSE, { sort: 'recent' });
    const [answer] = store.listAnswers(COURSE, question!.id);
    expect(answer).toMatchObject({ bodyMd: 'Use a **discriminated union**.', byInstructor: true });
  });

  it('accepts an answer and removes the acceptance again', async () => {
    const { store, user } = setup((s) => {
      const q = ask(s, 'Generic constraints?');
      asStudent(s, () => s.postAnswer(COURSE, q.id, 'Use `extends`.'), FIXTURE_IDS.admin);
    });
    renderWithClient(<QaInbox initialStatus="all" />);
    const item = await questionItem('Generic constraints?');
    expect(within(item).getByText('1 answer')).toBeTruthy();
    await user.click(within(item).getByRole('button', { name: /Open question/ }));
    const answer = await within(item).findByRole('listitem', { name: 'Answer by Root Admin' });
    await user.click(within(answer).getByRole('button', { name: 'Accept answer' }));

    const accepted = await within(item).findByRole('listitem', {
      name: 'Answer by Root Admin, accepted',
    });
    expect(within(accepted).getByText('Accepted answer')).toBeTruthy();
    expect(await within(item).findByText('Answer accepted')).toBeTruthy();
    expect(store.listQuestions(COURSE, { sort: 'recent' })[0]!.resolved).toBe(true);

    await user.click(within(accepted).getByRole('button', { name: 'Remove acceptance' }));
    await waitFor(() =>
      expect(store.listQuestions(COURSE, { sort: 'recent' })[0]!.resolved).toBe(false),
    );
  });

  it('filters by course (only published courses are offered)', async () => {
    const { user } = setup((s) => {
      ask(s, 'TypeScript question here');
      ask(s, 'Postgres index question', COURSE2);
    });
    renderWithClient(<QaInbox />);
    await questionItem('TypeScript question here');
    const select = screen.getByLabelText('Course');
    await within(select).findByRole('option', { name: 'PostgreSQL in Depth' });
    expect(within(select).queryByRole('option', { name: 'A draft course' })).toBeNull();
    await user.selectOptions(select, COURSE2);
    expect(await questionItem('Postgres index question')).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'TypeScript question here' })).toBeNull(),
    );
  });

  it('starts from the course and status of the link', async () => {
    setup((s) => {
      ask(s, 'TypeScript question here');
      ask(s, 'Postgres index question', COURSE2);
    });
    renderWithClient(<QaInbox initialCourseId={COURSE2} initialStatus="all" />);
    expect(await questionItem('Postgres index question')).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: 'TypeScript question here' })).toBeNull();
    expect((screen.getByLabelText('Show') as HTMLSelectElement).value).toBe('all');
  });
});
