// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { RevisionSectionSchema } from '@udemy/contracts';
import { LEARNING_FIXTURE_IDS, makeRevisionQuiz } from '@udemy/contracts/testing';

import { installLearning } from '@/test/learning';
import { proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { CurriculumReview } from './curriculum-review';
import type { DiffIndex } from './revision-diff';
import { revisionQuizPath } from './revision-quiz';

setupMockApi();

const REVISION = LEARNING_FIXTURE_IDS.revision;
const QUIZ_LECTURE = LEARNING_FIXTURE_IDS.lectureQuiz;

const NO_DIFF: DiffIndex = {
  hasBase: false,
  fieldChanged: () => false,
  section: () => [],
  lecture: () => [],
  isEmpty: true,
};

function sections() {
  return [
    RevisionSectionSchema.parse({
      id: LEARNING_FIXTURE_IDS.section1,
      position: 0,
      title: 'Basics',
      objective: null,
      lectures: [
        {
          id: QUIZ_LECTURE,
          sectionId: LEARNING_FIXTURE_IDS.section1,
          position: 0,
          type: 'QUIZ',
          title: 'Check your understanding',
          descriptionMd: null,
          isPreview: false,
          mediaAssetId: null,
          durationSeconds: null,
          articleBodyMd: null,
          quiz: { passPct: 70, questionCount: 3 },
        },
      ],
    }),
  ];
}

function renderReview() {
  return renderWithClient(
    <CurriculumReview revisionId={REVISION} sections={sections()} assets={[]} diff={NO_DIFF} />,
  );
}

describe('revision quiz view', () => {
  it('loads the quiz with its answer keys only when the lecture is opened', async () => {
    // The default mock curricula carry this quiz in the live revision of the fixture course.
    const store = installLearning();
    const expected = store.revisionQuiz(REVISION, QUIZ_LECTURE);
    let calls = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith(revisionQuizPath(REVISION, QUIZ_LECTURE))) calls += 1;
    });
    const { user } = renderReview();
    expect(calls).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Questions Check your understanding' }));
    const list = await screen.findByRole('list', { name: 'Quiz questions' });
    expect(
      screen.getByText(`${expected.questions.length} questions · pass mark ${expected.passPct}%`),
    ).toBeTruthy();
    expect(within(list).getByText('Question 1')).toBeTruthy();

    const first = expected.questions[0]!;
    const options = within(list).getByRole('list', { name: 'Options of question 1' });
    const correct = first.options.filter((o) => o.isCorrect);
    expect(within(options).getAllByText('Correct')).toHaveLength(correct.length);
    for (const option of correct) {
      expect(within(options).getByText(option.text).closest('li')!.textContent).toContain(
        'Correct',
      );
    }
    server.events.removeAllListeners();
  });

  it('shows explanations and the kind of each question', async () => {
    installLearning();
    const quiz = makeRevisionQuiz({
      questions: [
        {
          id: LEARNING_FIXTURE_IDS.quizQuestion1,
          position: 0,
          kind: 'MULTIPLE_CHOICE',
          promptMd: 'Pick the **primitive** types',
          explanationMd: 'Objects are not primitives.',
          options: [
            { position: 0, text: 'string', isCorrect: true },
            { position: 1, text: 'number', isCorrect: true },
            { position: 2, text: 'Date', isCorrect: false },
          ],
        },
      ],
    });
    server.use(
      http.get(proxy(revisionQuizPath(REVISION, QUIZ_LECTURE)), () => HttpResponse.json(quiz)),
    );
    const { user } = renderReview();
    await user.click(screen.getByRole('button', { name: 'Questions Check your understanding' }));
    const list = await screen.findByRole('list', { name: 'Quiz questions' });
    expect(within(list).getByText('Multiple choice')).toBeTruthy();
    expect(within(list).getByText('primitive').tagName).toBe('STRONG');
    expect(within(list).getByText('Objects are not primitives.')).toBeTruthy();
    expect(within(list).getByText('Date').closest('li')!.textContent).not.toContain('Correct');
  });

  it('explains an error', async () => {
    installLearning();
    server.use(
      http.get(proxy(revisionQuizPath(REVISION, QUIZ_LECTURE)), () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'x', status: 404, code: 'lecture_not_found' },
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    const { user } = renderReview();
    await user.click(screen.getByRole('button', { name: 'Questions Check your understanding' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This quiz is not part of this revision.',
    );
  });
});
