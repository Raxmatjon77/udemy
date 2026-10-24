// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { LEARNING_FIXTURE_IDS } from '@udemy/contracts/testing';

import { COURSE, installLearning } from '@/test/learning';
import { problem, proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { QuizEditor, questionIssue } from './quiz-editor';

setupMockApi();

const LECTURE = LEARNING_FIXTURE_IDS.lectureQuiz;
const Q1 = LEARNING_FIXTURE_IDS.quizQuestion1;

function setup(options: { status?: 'IN_REVIEW' } = {}) {
  const store = installLearning();
  if (options.status) store.commerce.courses.get(COURSE)!.status = options.status;
  const user = userEvent.setup();
  renderWithClient(<QuizEditor courseId={COURSE} lectureId={LECTURE} readOnly={false} />);
  const quiz = () => store.quizAuthoring(COURSE, LECTURE);
  return { store, user, quiz };
}

const questionCard = (number: number) =>
  screen.findByRole('listitem', { name: `Question ${number}` });

describe('questionIssue', () => {
  it('explains why a question is incomplete', () => {
    expect(questionIssue('SINGLE_CHOICE', [{ isCorrect: true }])).toBe('Add 2 to 6 options.');
    expect(questionIssue('SINGLE_CHOICE', [{ isCorrect: true }, { isCorrect: true }])).toBe(
      'Mark exactly one option as correct.',
    );
    expect(questionIssue('MULTIPLE_CHOICE', [{ isCorrect: false }, { isCorrect: false }])).toBe(
      'Mark at least one option as correct.',
    );
    expect(questionIssue('MULTIPLE_CHOICE', [{ isCorrect: true }, { isCorrect: true }])).toBeNull();
  });
});

describe('<QuizEditor>', () => {
  it('shows the pass mark and every question with its options and correct answers', async () => {
    setup();
    const first = await questionCard(1);
    expect(within(first).getByText('Single choice')).toBeTruthy();
    expect(within(first).getByText('constant')).toBeTruthy();
    const options = within(first).getByRole('list', { name: 'Options of question 1' });
    const correct = within(options).getByText('const').closest('li')!;
    expect(within(correct).getByText('Correct')).toBeTruthy();
    expect(within(first).getByText('Explanation')).toBeTruthy();
    expect(within(await questionCard(2)).getByText('Multiple choice')).toBeTruthy();
    expect((screen.getByLabelText('Pass mark (%)') as HTMLInputElement).value).toBe('70');
  });

  it('saves the pass mark and rejects values outside 1–100', async () => {
    const { user, quiz } = setup();
    const input = await screen.findByLabelText('Pass mark (%)');
    await user.clear(input);
    await user.type(input, '120');
    await user.click(screen.getByRole('button', { name: 'Save pass mark' }));
    expect(await screen.findByText('Enter a whole number from 1 to 100.')).toBeTruthy();

    await user.clear(input);
    await user.type(input, '80');
    await user.click(screen.getByRole('button', { name: 'Save pass mark' }));
    expect(await screen.findByText('Pass mark saved.')).toBeTruthy();
    expect(quiz().passPct).toBe(80);
  });

  it('adds a single-choice question with its options and the correct one marked', async () => {
    const { user, quiz } = setup();
    await questionCard(3);
    await user.click(screen.getByRole('button', { name: 'Add question' }));
    const form = screen.getByRole('form', { name: 'Question' });
    await user.type(within(form).getByLabelText('Question'), 'What does `tsc` do?');
    await user.type(within(form).getByLabelText('Option 1'), 'Compiles TypeScript');
    await user.type(within(form).getByLabelText('Option 2'), 'Runs tests');
    await user.click(within(form).getByLabelText('Option 1 is correct'));
    await user.type(within(form).getByLabelText(/Explanation/), 'It is the compiler.');
    await user.click(within(form).getByRole('button', { name: 'Add question' }));

    const card = await questionCard(4);
    expect(within(card).getByText('Compiles TypeScript')).toBeTruthy();
    expect(within(card).queryByText('Incomplete')).toBeNull();
    const added = quiz().questions[3]!;
    expect(added).toMatchObject({
      kind: 'SINGLE_CHOICE',
      promptMd: 'What does `tsc` do?',
      explanationMd: 'It is the compiler.',
      complete: true,
      options: [
        { position: 0, text: 'Compiles TypeScript', isCorrect: true },
        { position: 1, text: 'Runs tests', isCorrect: false },
      ],
    });
  });

  it('needs at least two options, and saves a draft without a correct answer as incomplete', async () => {
    const { user, quiz } = setup();
    await questionCard(3);
    await user.click(screen.getByRole('button', { name: 'Add question' }));
    const form = screen.getByRole('form', { name: 'Question' });
    await user.type(within(form).getByLabelText('Question'), 'Pick the odd one out');
    await user.type(within(form).getByLabelText('Option 1'), 'A');
    await user.click(within(form).getByRole('button', { name: 'Add question' }));
    expect(await within(form).findByText(/Add at least 2 options/)).toBeTruthy();
    expect(quiz().questions).toHaveLength(3);

    await user.type(within(form).getByLabelText('Option 2'), 'B');
    expect(
      within(form).getByText(/Not complete yet: Mark exactly one option as correct/),
    ).toBeTruthy();
    await user.click(within(form).getByRole('button', { name: 'Add question' }));

    const card = await questionCard(4);
    expect(within(card).getByText('Incomplete')).toBeTruthy();
    expect(within(card).getByText('Mark exactly one option as correct.')).toBeTruthy();
    expect(screen.getByText(/1 question is not complete yet/)).toBeTruthy();
    expect(quiz().questions[3]!.complete).toBe(false);
  });

  it('edits a question: switches to multiple choice and marks a second correct option', async () => {
    const { user, quiz } = setup();
    await user.click(await screen.findByRole('button', { name: 'Edit question 1' }));
    const form = screen.getByRole('form', { name: 'Question' });
    await user.selectOptions(within(form).getByLabelText('Question type'), 'MULTIPLE_CHOICE');
    await user.click(within(form).getByLabelText('Option 3 is correct'));
    await user.click(within(form).getByRole('button', { name: 'Save question' }));

    await waitFor(() => expect(screen.queryByRole('form', { name: 'Question' })).toBeNull());
    const edited = quiz().questions[0]!;
    expect(edited.kind).toBe('MULTIPLE_CHOICE');
    expect(edited.options.map((o) => o.isCorrect)).toEqual([false, true, true]);
  });

  it('reorders with the move buttons (the full order is sent)', async () => {
    const { user, quiz } = setup();
    await user.click(await screen.findByRole('button', { name: 'Move question 1 down' }));
    await waitFor(() => expect(quiz().questions[1]!.id).toBe(Q1));
    expect(await screen.findByText('Moved question 1 to position 2.')).toBeTruthy();
  });

  it('deletes a question after confirmation', async () => {
    const { user, quiz } = setup();
    await user.click(await screen.findByRole('button', { name: 'Delete question 3' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete question' }));
    await waitFor(() => expect(quiz().questions).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Question 3' })).toBeNull());
  });

  it('is read-only while the course is in review', async () => {
    setup({ status: 'IN_REVIEW' });
    await questionCard(1);
    expect(screen.queryByRole('button', { name: 'Add question' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit question 1' })).toBeNull();
    expect((screen.getByLabelText('Pass mark (%)') as HTMLInputElement).disabled).toBe(true);
  });

  it('shows the rejected markdown of a prompt', async () => {
    const { user } = setup();
    server.use(
      http.patch(proxy(`/courses/${COURSE}/lectures/${LECTURE}/quiz/questions/:id`), () =>
        problem(422, 'markdown_not_allowed', {
          issues: [
            {
              path: 'promptMd',
              line: 1,
              column: 1,
              kind: 'raw_html',
              construct: 'html_inline',
              detail: 'Raw HTML is not allowed.',
            },
          ],
        }),
      ),
    );
    await user.click(await screen.findByRole('button', { name: 'Edit question 1' }));
    const form = screen.getByRole('form', { name: 'Question' });
    const prompt = within(form).getByLabelText('Question');
    await user.clear(prompt);
    await user.type(prompt, '<b>bold</b> question');
    await user.click(within(form).getByRole('button', { name: 'Save question' }));
    expect(
      await within(form).findByText(/formatting that is not allowed\. See the marked lines/),
    ).toBeTruthy();
  });
});
