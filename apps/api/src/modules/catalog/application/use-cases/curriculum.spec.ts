import { beforeEach, describe, expect, it } from 'vitest';
import { MediaAssetUnusable, MediaPurposeMismatch } from '../../../media';
import {
  CurriculumLimitExceeded,
  LectureNotFound,
  LectureTypeMismatch,
  MarkdownNotAllowed,
  OrderMismatch,
  PreviewNotAllowed,
  SectionNotFound,
} from '../../domain/catalog.errors';
import { CatalogSettings } from '../catalog-settings';
import { type CatalogHarness, createCatalogHarness } from '../testing/catalog.harness';

const OWNER = '00000000-0000-7000-8000-0000000000a1';
const OTHER = '00000000-0000-7000-8000-0000000000b2';

describe('curriculum (use cases with fakes)', () => {
  let h: CatalogHarness;
  let courseId: string;
  let otherCourseId: string;

  beforeEach(async () => {
    h = createCatalogHarness(new CatalogSettings({ minLectures: 1, minVideoSeconds: 0 }));
    courseId = (await h.createCourse.execute({ ownerId: OWNER, title: 'Curriculum course' })).id;
    otherCourseId = (await h.createCourse.execute({ ownerId: OTHER, title: 'Other course' })).id;
  });

  const as = (actorId = OWNER, id = courseId) => ({ actorId, courseId: id });

  it('adds sections and lectures at the end and bumps the course version', async () => {
    const s1 = await h.addSection.execute({ ...as(), title: 'Intro', objective: 'Get going' });
    const s2 = await h.addSection.execute({ ...as(), title: 'Deep dive' });
    const l1 = await h.addLecture.execute({ ...as(), sectionId: s1.id, type: 'VIDEO', title: 'V' });
    const l2 = await h.addLecture.execute({
      ...as(),
      sectionId: s1.id,
      type: 'ARTICLE',
      title: 'A',
    });
    expect([s1.position, s2.position, l1.position, l2.position]).toEqual([0, 1, 0, 1]);
    expect(l2).toMatchObject({ type: 'ARTICLE', articleLength: 0, asset: null, isPreview: false });
    expect(l1.articleLength).toBeNull();

    const curriculum = await h.getCurriculum.execute(courseId);
    expect(curriculum.version).toBe(5);
    expect(curriculum.sections.map((s) => [s.title, s.lectures.map((l) => l.title)])).toEqual([
      ['Intro', ['V', 'A']],
      ['Deep dive', []],
    ]);
    expect(curriculum.totals).toEqual({
      sectionCount: 2,
      lectureCount: 2,
      previewCount: 0,
      videoSeconds: 0,
    });
  });

  it('scopes children by course: a section/lecture of another course is 404', async () => {
    const foreignSection = await h.addSection.execute({ ...as(OTHER, otherCourseId), title: 'X' });
    const foreignLecture = await h.addLecture.execute({
      ...as(OTHER, otherCourseId),
      sectionId: foreignSection.id,
      type: 'ARTICLE',
      title: 'Y',
    });
    await expect(
      h.updateSection.execute({ ...as(), sectionId: foreignSection.id, patch: { title: 'Z' } }),
    ).rejects.toBeInstanceOf(SectionNotFound);
    await expect(
      h.addLecture.execute({ ...as(), sectionId: foreignSection.id, type: 'VIDEO', title: 'Z' }),
    ).rejects.toBeInstanceOf(SectionNotFound);
    await expect(
      h.updateLecture.execute({ ...as(), lectureId: foreignLecture.id, patch: { title: 'Z' } }),
    ).rejects.toBeInstanceOf(LectureNotFound);
    await expect(
      h.getArticle.execute({ courseId, lectureId: foreignLecture.id }),
    ).rejects.toBeInstanceOf(LectureNotFound);
    await expect(
      h.deleteLecture.execute({ ...as(), lectureId: foreignLecture.id }),
    ).rejects.toBeInstanceOf(LectureNotFound);
    expect(h.world.state.lectures.get(foreignLecture.id)?.title).toBe('Y');
  });

  it('enforces the section limit (50)', async () => {
    for (let i = 0; i < 50; i += 1) await h.addSection.execute({ ...as(), title: `S${i}` });
    await expect(h.addSection.execute({ ...as(), title: 'one too many' })).rejects.toBeInstanceOf(
      CurriculumLimitExceeded,
    );
  });

  it('preview flag: VIDEO/ARTICLE only, at most 10', async () => {
    const s = await h.addSection.execute({ ...as(), title: 'S' });
    const resource = await h.addLecture.execute({
      ...as(),
      sectionId: s.id,
      type: 'RESOURCE',
      title: 'R',
    });
    await expect(
      h.updateLecture.execute({ ...as(), lectureId: resource.id, patch: { isPreview: true } }),
    ).rejects.toBeInstanceOf(PreviewNotAllowed);
    const videos = [];
    for (let i = 0; i < 11; i += 1) {
      videos.push(
        await h.addLecture.execute({ ...as(), sectionId: s.id, type: 'VIDEO', title: `V${i}` }),
      );
    }
    for (const v of videos.slice(0, 10)) {
      await h.updateLecture.execute({ ...as(), lectureId: v.id, patch: { isPreview: true } });
    }
    // Re-saving an existing preview is fine; an 11th is not.
    await h.updateLecture.execute({
      ...as(),
      lectureId: videos[0]?.id ?? '',
      patch: { isPreview: true },
    });
    await expect(
      h.updateLecture.execute({
        ...as(),
        lectureId: videos[10]?.id ?? '',
        patch: { isPreview: true },
      }),
    ).rejects.toBeInstanceOf(PreviewNotAllowed);
  });

  it('articles: markdown validated, stored verbatim, only on ARTICLE lectures', async () => {
    const s = await h.addSection.execute({ ...as(), title: 'S' });
    const article = await h.addLecture.execute({
      ...as(),
      sectionId: s.id,
      type: 'ARTICLE',
      title: 'A',
    });
    const video = await h.addLecture.execute({
      ...as(),
      sectionId: s.id,
      type: 'VIDEO',
      title: 'V',
    });
    expect(await h.getArticle.execute({ courseId, lectureId: article.id })).toEqual({
      lectureId: article.id,
      bodyMd: '',
      updatedAt: null,
    });
    const body = '## Heading\n\nSome **bold** text with trailing spaces.  \n';
    const saved = await h.saveArticle.execute({ ...as(), lectureId: article.id, bodyMd: body });
    expect(saved.bodyMd).toBe(body);
    await expect(
      h.saveArticle.execute({ ...as(), lectureId: article.id, bodyMd: '<script>x</script>' }),
    ).rejects.toBeInstanceOf(MarkdownNotAllowed);
    await expect(
      h.saveArticle.execute({ ...as(), lectureId: video.id, bodyMd: 'hi' }),
    ).rejects.toBeInstanceOf(LectureTypeMismatch);
    await expect(h.getArticle.execute({ courseId, lectureId: video.id })).rejects.toBeInstanceOf(
      LectureTypeMismatch,
    );
    const lecture = (await h.getCurriculum.execute(courseId)).sections[0]?.lectures[0];
    expect(lecture?.articleLength).toBe('Heading Some bold text with trailing spaces.'.length);
  });

  it('attach / swap / detach lecture media through the facade (release-then-use)', async () => {
    const s = await h.addSection.execute({ ...as(), title: 'S' });
    const video = await h.addLecture.execute({
      ...as(),
      sectionId: s.id,
      type: 'VIDEO',
      title: 'V',
    });
    const article = await h.addLecture.execute({
      ...as(),
      sectionId: s.id,
      type: 'ARTICLE',
      title: 'A',
    });
    const a1 = h.media.addAsset({ ownerId: OWNER, purpose: 'LECTURE_VIDEO' });
    const a2 = h.media.addAsset({ ownerId: OWNER, purpose: 'LECTURE_VIDEO' });
    const resource = h.media.addAsset({ ownerId: OWNER, purpose: 'LECTURE_RESOURCE' });

    const attached = await h.attachMedia.execute({ ...as(), lectureId: video.id, assetId: a1.id });
    expect(attached).toMatchObject({ mediaAssetId: a1.id, asset: { id: a1.id, status: 'READY' } });
    expect(h.media.usagesOf(a1.id)).toEqual([`catalog.lecture|${video.id}`]);

    await h.attachMedia.execute({ ...as(), lectureId: video.id, assetId: a2.id });
    expect(h.media.usagesOf(a1.id)).toEqual([]);
    expect(h.media.usagesOf(a2.id)).toEqual([`catalog.lecture|${video.id}`]);

    await expect(
      h.attachMedia.execute({ ...as(), lectureId: article.id, assetId: a1.id }),
    ).rejects.toBeInstanceOf(LectureTypeMismatch);
    await expect(
      h.attachMedia.execute({ ...as(), lectureId: video.id, assetId: resource.id }),
    ).rejects.toBeInstanceOf(MediaPurposeMismatch);
    expect(h.media.usagesOf(a2.id)).toEqual([`catalog.lecture|${video.id}`]); // rolled back

    // a2 already belongs to `video`: another lecture cannot take it.
    const second = await h.addLecture.execute({
      ...as(),
      sectionId: s.id,
      type: 'VIDEO',
      title: 'V2',
    });
    await expect(
      h.attachMedia.execute({ ...as(), lectureId: second.id, assetId: a2.id }),
    ).rejects.toBeInstanceOf(MediaAssetUnusable);

    const detached = await h.detachMedia.execute({ ...as(), lectureId: video.id });
    expect(detached).toMatchObject({ mediaAssetId: null, asset: null });
    expect(h.media.usagesOf(a2.id)).toEqual([]);
    expect((await h.detachMedia.execute({ ...as(), lectureId: video.id })).mediaAssetId).toBeNull();
  });

  it('delete section / lecture release media and compact positions', async () => {
    const s1 = await h.addSection.execute({ ...as(), title: 'S1' });
    const s2 = await h.addSection.execute({ ...as(), title: 'S2' });
    const s3 = await h.addSection.execute({ ...as(), title: 'S3' });
    const l1 = await h.addLecture.execute({
      ...as(),
      sectionId: s1.id,
      type: 'VIDEO',
      title: 'L1',
    });
    const l2 = await h.addLecture.execute({
      ...as(),
      sectionId: s1.id,
      type: 'VIDEO',
      title: 'L2',
    });
    const l3 = await h.addLecture.execute({
      ...as(),
      sectionId: s1.id,
      type: 'VIDEO',
      title: 'L3',
    });
    const v = h.media.addAsset({ ownerId: OWNER, purpose: 'LECTURE_VIDEO' });
    const w = h.media.addAsset({ ownerId: OWNER, purpose: 'LECTURE_VIDEO' });
    await h.attachMedia.execute({ ...as(), lectureId: l1.id, assetId: v.id });
    await h.attachMedia.execute({ ...as(), lectureId: l3.id, assetId: w.id });

    await h.deleteLecture.execute({ ...as(), lectureId: l1.id });
    expect(h.media.usagesOf(v.id)).toEqual([]);
    expect(h.world.state.lectures.get(l2.id)?.position).toBe(0);
    expect(h.world.state.lectures.get(l3.id)?.position).toBe(1);

    await h.deleteSection.execute({ ...as(), sectionId: s1.id });
    expect(h.media.usagesOf(w.id)).toEqual([]);
    expect(h.world.state.lectures.size).toBe(0);
    expect(h.world.state.sections.get(s2.id)?.position).toBe(0);
    expect(h.world.state.sections.get(s3.id)?.position).toBe(1);
  });

  it('reorders the whole curriculum (cross-section) or answers order_mismatch', async () => {
    const s1 = await h.addSection.execute({ ...as(), title: 'S1' });
    const s2 = await h.addSection.execute({ ...as(), title: 'S2' });
    const a = await h.addLecture.execute({ ...as(), sectionId: s1.id, type: 'VIDEO', title: 'a' });
    const b = await h.addLecture.execute({ ...as(), sectionId: s1.id, type: 'VIDEO', title: 'b' });
    const c = await h.addLecture.execute({ ...as(), sectionId: s2.id, type: 'VIDEO', title: 'c' });

    const result = await h.reorderCurriculum.execute({
      ...as(),
      sections: [
        { sectionId: s2.id, lectureIds: [b.id, c.id] },
        { sectionId: s1.id, lectureIds: [a.id] },
      ],
    });
    expect(result.sections.map((s) => [s.title, s.lectures.map((l) => l.title)])).toEqual([
      ['S2', ['b', 'c']],
      ['S1', ['a']],
    ]);
    expect(result.sections[0]?.lectures.map((l) => [l.sectionId, l.position])).toEqual([
      [s2.id, 0],
      [s2.id, 1],
    ]);

    // A stale tab still believes b is in S1.
    await expect(
      h.reorderCurriculum.execute({
        ...as(),
        sections: [
          { sectionId: s1.id, lectureIds: [a.id] },
          { sectionId: s2.id, lectureIds: [c.id] },
        ],
      }),
    ).rejects.toBeInstanceOf(OrderMismatch);
    // Another course's ids never match.
    await expect(
      h.reorderCurriculum.execute({ ...as(OTHER, otherCourseId), sections: [] }),
    ).resolves.toMatchObject({ sections: [] });
    await expect(
      h.reorderCurriculum.execute({
        ...as(OTHER, otherCourseId),
        sections: [{ sectionId: s1.id, lectureIds: [] }],
      }),
    ).rejects.toBeInstanceOf(OrderMismatch);
  });

  it('readiness follows the curriculum (thresholds 1 lecture / 0 s here)', async () => {
    const before = await h.getCourse.execute(courseId);
    expect(before.readiness.issues.map((i) => i.code)).toContain('NO_SECTIONS');
    const s = await h.addSection.execute({ ...as(), title: 'S' });
    const lecture = await h.addLecture.execute({
      ...as(),
      sectionId: s.id,
      type: 'VIDEO',
      title: 'V',
    });
    const codes = (await h.getCourse.execute(courseId)).readiness.issues;
    expect(codes).toContainEqual(
      expect.objectContaining({ code: 'LECTURE_MEDIA_MISSING', lectureId: lecture.id }),
    );
    expect(codes.map((i) => i.code)).not.toContain('TOO_FEW_LECTURES');
  });
});
