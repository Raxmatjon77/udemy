import { CourseLandingSchema } from '@udemy/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { UsersFacade } from '../../../users';
import { CatalogSettings } from '../catalog-settings';
import { FakePublicCatalogRepository } from '../testing/catalog.fakes';
import { createCatalogHarness } from '../testing/catalog.harness';
import { GetCourseLandingQuery } from './get-course-landing.query';

const OWNER = '00000000-0000-7000-8000-0000000000a1';
const ADMIN = '00000000-0000-7000-8000-0000000000c3';
const DESCRIPTION = `${'This course teaches TypeScript from the ground up. '.repeat(6)}`;
const ARTICLE = 'An article body that is clearly longer than fifty characters in total.';

/*
 * The public landing outline with a QUIZ lecture (Phase 5 D6): the quiz shows by title and
 * type only. The landing never even loads quiz content, so no answer key can leak into the
 * public, SEO-indexed page.
 */
describe('GetCourseLanding: QUIZ lectures in the public outline', () => {
  it('lists the quiz by title and type; no quiz content is loaded or rendered', async () => {
    const h = createCatalogHarness(new CatalogSettings({ minLectures: 2, minVideoSeconds: 0 }));
    h.people.people.set(OWNER, { displayName: 'Owner', banned: false });
    const group = await h.createCategory.execute({ name: 'Development' });
    const leafId = (await h.createCategory.execute({ name: 'Web', parentId: group.id })).id;
    const course = await h.createCourse.execute({ ownerId: OWNER, title: 'Landing course' });
    const as = { actorId: OWNER, courseId: course.id };
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
    const sectionId = (await h.addSection.execute({ ...as, title: 'Section' })).id;
    const article = await h.addLecture.execute({ ...as, sectionId, type: 'ARTICLE', title: 'A' });
    await h.saveArticle.execute({ ...as, lectureId: article.id, bodyMd: ARTICLE });
    const quiz = await h.addLecture.execute({ ...as, sectionId, type: 'QUIZ', title: 'Quiz' });
    const question = await h.addQuizQuestion.execute({
      ...as,
      lectureId: quiz.id,
      kind: 'SINGLE_CHOICE',
      promptMd: 'Secret prompt',
      explanationMd: 'Secret explanation',
    });
    await h.putQuizOptions.execute({
      ...as,
      lectureId: quiz.id,
      questionId: question.id,
      options: [
        { text: 'Secret right', isCorrect: true },
        { text: 'Secret wrong', isCorrect: false },
      ],
    });
    const { revisionId } = await h.submit.execute({ actorId: OWNER, courseId: course.id });
    await h.approve.execute({ actorId: ADMIN, courseId: course.id, revisionId });

    const findById = vi.spyOn(h.revisions, 'findById');
    const users = { getPublicProfile: () => Promise.resolve(null) } as unknown as UsersFacade;
    const landing = await new GetCourseLandingQuery(
      new FakePublicCatalogRepository(h.world),
      h.revisions,
      users,
      h.media.asFacade(),
    ).execute(course.slug);

    expect(findById).toHaveBeenCalledWith(revisionId, undefined, {
      articleBodies: false,
      quizzes: false,
    });
    expect(CourseLandingSchema.parse(landing)).toEqual(landing);
    expect(landing.sections[0]?.lectures).toEqual([
      { id: article.id, title: 'A', type: 'ARTICLE', durationSeconds: null, isPreview: false },
      { id: quiz.id, title: 'Quiz', type: 'QUIZ', durationSeconds: null, isPreview: false },
    ]);
    expect(landing.totals).toEqual({ sectionCount: 1, lectureCount: 2, videoSeconds: 0 });
    expect(JSON.stringify(landing)).not.toMatch(/Secret|isCorrect|explanation|passPct/);
  });
});
