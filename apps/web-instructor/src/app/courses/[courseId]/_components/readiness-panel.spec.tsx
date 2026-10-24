// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CourseReadinessIssueSchema } from '@udemy/contracts';

import { curriculum, IDS, lecture } from '@/test/fixtures';

import { ReadinessPanel } from './readiness-panel';

const quizCurriculum = () =>
  curriculum({
    sections: [
      {
        id: IDS.sectionA,
        title: 'Basics',
        objective: null,
        position: 0,
        updatedAt: '2026-10-10T10:00:00.000Z',
        lectures: [
          lecture({
            id: IDS.lecture1,
            sectionId: IDS.sectionA,
            position: 0,
            type: 'QUIZ',
            title: 'Check yourself',
            quiz: { passPct: 70, questionCount: 0 },
          }),
        ],
      },
    ],
    totals: { sectionCount: 1, lectureCount: 1, previewCount: 0, videoSeconds: 0 },
  });

const issue = (code: 'QUIZ_EMPTY' | 'QUIZ_QUESTION_INVALID') =>
  CourseReadinessIssueSchema.parse({
    code,
    sectionId: IDS.sectionA,
    lectureId: IDS.lecture1,
    required: null,
    actual: null,
  });

describe('<ReadinessPanel> quiz issues (Phase 5)', () => {
  it('names the quiz lecture and opens its quiz editor', async () => {
    const onNavigate = vi.fn();
    render(
      <ReadinessPanel
        issues={[issue('QUIZ_EMPTY'), issue('QUIZ_QUESTION_INVALID')]}
        curriculum={quizCurriculum()}
        onNavigate={onNavigate}
      />,
    );
    expect(
      screen.getByText('“Check yourself”: the quiz has no questions. Add at least one.'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        '“Check yourself”: a quiz question needs 2–6 options and its correct answer(s) marked.',
      ),
    ).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: /^Open quiz editor/ });
    expect(buttons).toHaveLength(2);
    await userEvent.setup().click(buttons[0]!);
    expect(onNavigate).toHaveBeenCalledWith({
      tab: 'curriculum',
      sectionId: IDS.sectionA,
      lectureId: IDS.lecture1,
    });
  });
});
