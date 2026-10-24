import {
  QuizAuthoringSchema,
  QuizQuestionAuthoringSchema,
  RevisionReviewSchema,
} from '@udemy/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CourseInReview,
  CourseNotFound,
  LectureNotFound,
  LectureTypeMismatch,
  MarkdownNotAllowed,
  NothingToReview,
  OrderMismatch,
  PreviewNotAllowed,
  QuizLimitExceeded,
  QuizOptionsInvalid,
  QuizQuestionNotFound,
} from '../../domain/catalog.errors';
import { CatalogSettings } from '../catalog-settings';
import { type CatalogHarness, createCatalogHarness } from '../testing/catalog.harness';

const OWNER = '00000000-0000-7000-8000-0000000000a1';
const OTHER = '00000000-0000-7000-8000-0000000000b2';
const ADMIN = '00000000-0000-7000-8000-0000000000c3';
const DESCRIPTION = `${'This course teaches TypeScript from the ground up. '.repeat(6)}`;
const ARTICLE = 'An article body that is clearly longer than fifty characters in total.';

describe('QUIZ lectures: working copy, readiness, snapshot (use cases with fakes)', () => {
  let h: CatalogHarness;
  let courseId: string;
  let sectionId: string;
  let quizId: string;
  let leafId: string;

  beforeEach(async () => {
    h = createCatalogHarness(new CatalogSettings({ minLectures: 2, minVideoSeconds: 0 }));
    const group = await h.createCategory.execute({ name: 'Development' });
    leafId = (await h.createCategory.execute({ name: 'Web Development', parentId: group.id })).id;
    courseId = (await h.createCourse.execute({ ownerId: OWNER, title: 'Quiz course title' })).id;
    sectionId = (await h.addSection.execute({ ...as(), title: 'Section' })).id;
    quizId = (
      await h.addLecture.execute({ ...as(), sectionId, type: 'QUIZ', title: 'Check yourself' })
    ).id;
    h.people.people.set(OWNER, { displayName: 'Owner Name', banned: false });
    h.people.people.set(ADMIN, { displayName: 'Admin Name', banned: false });
  });

  function as(actorId = OWNER): { actorId: string; courseId: string } {
    return { actorId, courseId };
  }
  const quiz = (lectureId = quizId) => ({ ...as(), lectureId });

  async function addCompleteQuestion(promptMd = 'Pick the right one'): Promise<string> {
    const question = await h.addQuizQuestion.execute({
      ...quiz(),
      kind: 'SINGLE_CHOICE',
      promptMd,
      explanationMd: 'Because it is right.',
    });
    await h.putQuizOptions.execute({
      ...quiz(),
      questionId: question.id,
      options: [
        { text: 'Right', isCorrect: true },
        { text: 'Wrong', isCorrect: false },
      ],
    });
    return question.id;
  }

  /** Header, thumbnail, outcomes and an article: everything but the quiz is ready. */
  async function makeRestReady(): Promise<void> {
    await h.updateCourse.execute({
      ...as(),
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
    await h.setThumbnail.execute({ ...as(), assetId: thumb.id });
    const article = await h.addLecture.execute({
      ...as(),
      sectionId,
      type: 'ARTICLE',
      title: 'Article',
    });
    await h.saveArticle.execute({ ...as(), lectureId: article.id, bodyMd: ARTICLE });
  }

  it('AddLecture QUIZ: creates the settings row (pass 70) and reports the quiz summary', async () => {
    expect(h.world.state.quizzes.get(quizId)?.passPct).toBe(70);
    const curriculum = await h.getCurriculum.execute(courseId);
    const lecture = curriculum.sections[0]?.lectures[0];
    expect(lecture).toMatchObject({
      type: 'QUIZ',
      mediaAssetId: null,
      asset: null,
      articleLength: null,
      quiz: { passPct: 70, questionCount: 0 },
    });
    const video = await h.addLecture.execute({ ...as(), sectionId, type: 'VIDEO', title: 'V' });
    expect(video.quiz).toBeNull();
  });

  it('GetQuiz: the working copy with its answer key (contract shape)', async () => {
    const questionId = await addCompleteQuestion();
    const view = await h.getQuiz.execute({ courseId, lectureId: quizId });
    expect(QuizAuthoringSchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({
      courseId,
      lectureId: quizId,
      locked: false,
      passPct: 70,
      questions: [
        {
          id: questionId,
          position: 0,
          kind: 'SINGLE_CHOICE',
          explanationMd: 'Because it is right.',
          complete: true,
          options: [
            { position: 0, text: 'Right', isCorrect: true },
            { position: 1, text: 'Wrong', isCorrect: false },
          ],
        },
      ],
    });
  });

  it('every quiz write bumps the course version and the quiz updatedAt', async () => {
    const before = (await h.getQuiz.execute({ courseId, lectureId: quizId })).version;
    const settings = await h.updateQuizSettings.execute({ ...quiz(), passPct: 85 });
    expect(settings).toMatchObject({ passPct: 85, version: before + 1 });
    const q = await h.addQuizQuestion.execute({
      ...quiz(),
      kind: 'MULTIPLE_CHOICE',
      promptMd: 'P',
    });
    expect(QuizQuestionAuthoringSchema.parse(q)).toEqual(q);
    expect(q).toMatchObject({ position: 0, options: [], complete: false, explanationMd: null });
    await h.updateQuizQuestion.execute({ ...quiz(), questionId: q.id, patch: { promptMd: 'Q' } });
    await h.putQuizOptions.execute({
      ...quiz(),
      questionId: q.id,
      options: [
        { text: 'a', isCorrect: true },
        { text: 'b', isCorrect: true },
      ],
    });
    await h.deleteQuizQuestion.execute({ ...quiz(), questionId: q.id });
    const after = await h.getQuiz.execute({ courseId, lectureId: quizId });
    expect(after.version).toBe(before + 5);
    expect(after.questions).toEqual([]);
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(settings.updatedAt));
  });

  it('questions: appended in order, deleted with the gap closed, reordered as a permutation', async () => {
    const ids: string[] = [];
    for (const prompt of ['one', 'two', 'three']) {
      ids.push(
        (await h.addQuizQuestion.execute({ ...quiz(), kind: 'SINGLE_CHOICE', promptMd: prompt }))
          .id,
      );
    }
    const [a, b, c] = ids as [string, string, string];
    await h.deleteQuizQuestion.execute({ ...quiz(), questionId: b });
    let view = await h.getQuiz.execute({ courseId, lectureId: quizId });
    expect(view.questions.map((q) => [q.id, q.position])).toEqual([
      [a, 0],
      [c, 1],
    ]);
    view = await h.reorderQuizQuestions.execute({ ...quiz(), questionIds: [c, a] });
    expect(view.questions.map((q) => q.promptMd)).toEqual(['three', 'one']);
    await expect(
      h.reorderQuizQuestions.execute({ ...quiz(), questionIds: [a] }),
    ).rejects.toBeInstanceOf(OrderMismatch);
    await expect(
      h.reorderQuizQuestions.execute({ ...quiz(), questionIds: [a, b] }),
    ).rejects.toBeInstanceOf(OrderMismatch);
  });

  it('kind changes keep the options; completeness follows the kind', async () => {
    const q = await h.addQuizQuestion.execute({
      ...quiz(),
      kind: 'MULTIPLE_CHOICE',
      promptMd: 'P',
    });
    const twoCorrect = await h.putQuizOptions.execute({
      ...quiz(),
      questionId: q.id,
      options: [
        { text: 'a', isCorrect: true },
        { text: 'b', isCorrect: true },
      ],
    });
    expect(twoCorrect.complete).toBe(true);
    const single = await h.updateQuizQuestion.execute({
      ...quiz(),
      questionId: q.id,
      patch: { kind: 'SINGLE_CHOICE', explanationMd: 'Now with an explanation' },
    });
    expect(single).toMatchObject({ kind: 'SINGLE_CHOICE', complete: false });
    expect(single.options).toHaveLength(2);
    const cleared = await h.updateQuizQuestion.execute({
      ...quiz(),
      questionId: q.id,
      patch: { explanationMd: null },
    });
    expect(cleared.explanationMd).toBeNull();
  });

  it('limits and validation: 50 questions, options, markdown', async () => {
    for (let i = 0; i < 50; i += 1) {
      await h.addQuizQuestion.execute({ ...quiz(), kind: 'SINGLE_CHOICE', promptMd: `Q${i}` });
    }
    await expect(
      h.addQuizQuestion.execute({ ...quiz(), kind: 'SINGLE_CHOICE', promptMd: 'one too many' }),
    ).rejects.toBeInstanceOf(QuizLimitExceeded);
    const [first] = (await h.getQuiz.execute({ courseId, lectureId: quizId })).questions;
    if (first === undefined) throw new Error('fixture');
    await expect(
      h.putQuizOptions.execute({
        ...quiz(),
        questionId: first.id,
        options: [{ text: 'alone', isCorrect: true }],
      }),
    ).rejects.toBeInstanceOf(QuizOptionsInvalid);
    await expect(
      h.putQuizOptions.execute({
        ...quiz(),
        questionId: first.id,
        options: [
          { text: 'Same', isCorrect: true },
          { text: 'SAME', isCorrect: false },
        ],
      }),
    ).rejects.toBeInstanceOf(QuizOptionsInvalid);
    for (const field of ['promptMd', 'explanationMd'] as const) {
      await expect(
        h.addQuizQuestion.execute({
          ...as(),
          lectureId: quizId,
          kind: 'SINGLE_CHOICE',
          promptMd: 'fine',
          [field]: '<script>alert(1)</script>',
        }),
      ).rejects.toBeInstanceOf(MarkdownNotAllowed);
      await expect(
        h.updateQuizQuestion.execute({
          ...quiz(),
          questionId: first.id,
          patch: { [field]: '![img](https://x.test/a.png)' },
        }),
      ).rejects.toBeInstanceOf(MarkdownNotAllowed);
    }
  });

  it('scoping: other types are 422, other courses/quizzes are 404, others cannot write', async () => {
    const video = await h.addLecture.execute({ ...as(), sectionId, type: 'VIDEO', title: 'V' });
    await expect(h.getQuiz.execute({ courseId, lectureId: video.id })).rejects.toBeInstanceOf(
      LectureTypeMismatch,
    );
    await expect(
      h.addQuizQuestion.execute({ ...quiz(video.id), kind: 'SINGLE_CHOICE', promptMd: 'x' }),
    ).rejects.toBeInstanceOf(LectureTypeMismatch);

    // another course's quiz and question
    const otherCourse = (await h.createCourse.execute({ ownerId: OTHER, title: 'Other course' }))
      .id;
    const otherSection = (
      await h.addSection.execute({ actorId: OTHER, courseId: otherCourse, title: 'S' })
    ).id;
    const otherQuiz = (
      await h.addLecture.execute({
        actorId: OTHER,
        courseId: otherCourse,
        sectionId: otherSection,
        type: 'QUIZ',
        title: 'Q',
      })
    ).id;
    const otherQuestion = (
      await h.addQuizQuestion.execute({
        actorId: OTHER,
        courseId: otherCourse,
        lectureId: otherQuiz,
        kind: 'SINGLE_CHOICE',
        promptMd: 'Theirs',
      })
    ).id;
    await expect(h.getQuiz.execute({ courseId, lectureId: otherQuiz })).rejects.toBeInstanceOf(
      LectureNotFound,
    );
    await expect(
      h.updateQuizQuestion.execute({
        ...quiz(),
        questionId: otherQuestion,
        patch: { promptMd: 'x' },
      }),
    ).rejects.toBeInstanceOf(QuizQuestionNotFound);
    await expect(
      h.deleteQuizQuestion.execute({ ...quiz(), questionId: otherQuestion }),
    ).rejects.toBeInstanceOf(QuizQuestionNotFound);
    await expect(
      h.putQuizOptions.execute({
        ...quiz(),
        questionId: otherQuestion,
        options: [
          { text: 'a', isCorrect: true },
          { text: 'b', isCorrect: false },
        ],
      }),
    ).rejects.toBeInstanceOf(QuizQuestionNotFound);
    // a non-owner writing (a misrouted policy) is "not found"
    await expect(
      h.updateQuizSettings.execute({ ...quiz(), actorId: OTHER, passPct: 10 }),
    ).rejects.toBeInstanceOf(CourseNotFound);
    expect(h.world.state.quizQuestions.get(otherQuestion)?.promptMd).toBe('Theirs');
  });

  it('a quiz is never a preview and never takes media', async () => {
    await expect(
      h.updateLecture.execute({ ...as(), lectureId: quizId, patch: { isPreview: true } }),
    ).rejects.toBeInstanceOf(PreviewNotAllowed);
    const asset = h.media.addAsset({ ownerId: OWNER, purpose: 'LECTURE_VIDEO' });
    await expect(
      h.attachMedia.execute({ ...as(), lectureId: quizId, assetId: asset.id }),
    ).rejects.toBeInstanceOf(LectureTypeMismatch);
  });

  it('deleting the lecture or its section removes the quiz (cascade)', async () => {
    await addCompleteQuestion();
    await h.deleteLecture.execute({ ...as(), lectureId: quizId });
    expect(h.world.state.quizzes.size).toBe(0);
    expect(h.world.state.quizQuestions.size).toBe(0);
  });

  it('readiness: QUIZ_EMPTY, then QUIZ_QUESTION_INVALID, then ready', async () => {
    await makeRestReady();
    const codes = async (): Promise<string[]> =>
      (await h.getCourse.execute(courseId)).readiness.issues.map((i) => i.code);
    expect(await codes()).toEqual(['QUIZ_EMPTY']);
    const q = await h.addQuizQuestion.execute({ ...quiz(), kind: 'SINGLE_CHOICE', promptMd: 'P' });
    expect(await codes()).toEqual(['QUIZ_QUESTION_INVALID']);
    await h.putQuizOptions.execute({
      ...quiz(),
      questionId: q.id,
      options: [
        { text: 'a', isCorrect: true },
        { text: 'b', isCorrect: false },
      ],
    });
    expect(await codes()).toEqual([]);
  });

  it('submit snapshots the quiz WITH its key; edits are locked while in review', async () => {
    await makeRestReady();
    const questionId = await addCompleteQuestion();
    await h.updateQuizSettings.execute({ ...quiz(), passPct: 60 });
    const { revisionId } = await h.submit.execute({ actorId: OWNER, courseId });

    const snapshot = h.world.state.snapshots.get(revisionId);
    expect(snapshot?.lectures.get(quizId)?.quiz).toEqual({
      passPct: 60,
      questions: [
        {
          id: questionId,
          kind: 'SINGLE_CHOICE',
          promptMd: 'Pick the right one',
          explanationMd: 'Because it is right.',
          options: [
            { text: 'Right', isCorrect: true },
            { text: 'Wrong', isCorrect: false },
          ],
        },
      ],
    });
    expect((await h.getQuiz.execute({ courseId, lectureId: quizId })).locked).toBe(true);
    await expect(h.updateQuizSettings.execute({ ...quiz(), passPct: 70 })).rejects.toBeInstanceOf(
      CourseInReview,
    );
    await expect(
      h.addQuizQuestion.execute({ ...quiz(), kind: 'SINGLE_CHOICE', promptMd: 'late' }),
    ).rejects.toBeInstanceOf(CourseInReview);

    // the admin review carries the summary only, never the questions or the key
    const review = await h.revisionReview.execute(revisionId);
    expect(RevisionReviewSchema.parse(review)).toEqual(review);
    const reviewed = review.revision.sections[0]?.lectures.find((l) => l.id === quizId);
    expect(reviewed?.quiz).toEqual({ passPct: 60, questionCount: 1 });
    expect(JSON.stringify(review)).not.toMatch(/isCorrect|Because it is right/);
  });

  it('after approval: an unchanged quiz is nothing_to_review; a key change is a diffed change', async () => {
    await makeRestReady();
    await addCompleteQuestion();
    const r1 = await h.submit.execute({ actorId: OWNER, courseId });
    await h.approve.execute({ actorId: ADMIN, courseId, revisionId: r1.revisionId });
    expect((await h.getCourse.execute(courseId)).hasUnpublishedChanges).toBe(false);
    await expect(h.submit.execute({ actorId: OWNER, courseId })).rejects.toBeInstanceOf(
      NothingToReview,
    );

    // flip the key: a reviewable change of the quiz lecture
    const [question] = (await h.getQuiz.execute({ courseId, lectureId: quizId })).questions;
    if (question === undefined) throw new Error('fixture');
    await h.putQuizOptions.execute({
      ...quiz(),
      questionId: question.id,
      options: [
        { text: 'Right', isCorrect: false },
        { text: 'Wrong', isCorrect: true },
      ],
    });
    expect((await h.getCourse.execute(courseId)).hasUnpublishedChanges).toBe(true);
    const r2 = await h.submit.execute({ actorId: OWNER, courseId });
    const review = await h.revisionReview.execute(r2.revisionId);
    expect(review.diff.baseRevisionId).toBe(r1.revisionId);
    expect(review.diff.lectures.changed).toEqual([quizId]);
  });
});
