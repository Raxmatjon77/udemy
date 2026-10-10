import {
  CategoryTreeResponseSchema,
  CourseCardPageSchema,
  CourseCardSchema,
  CourseLandingSchema,
  PublicArticleSchema,
  type CourseCard,
  type CourseCardPage,
  type CourseLanding,
} from '@udemy/contracts';

/**
 * Catalog API fixtures. Every one goes through its contracts schema, so a contract change that
 * the UI has not caught up with fails here first.
 */

export const COURSE_ID = '0b7f1d1e-5a8f-4c3a-9a51-6f1b2c3d4e5f';
export const VIDEO_PREVIEW_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
export const ARTICLE_PREVIEW_ID = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';
export const LOCKED_VIDEO_ID = '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b';
export const RESOURCE_ID = '4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c';

export const categoryTree = CategoryTreeResponseSchema.parse({
  items: [
    {
      id: 'a1a1a1a1-0000-4000-8000-000000000001',
      slug: 'development',
      name: 'Development',
      children: [
        {
          id: 'a1a1a1a1-0000-4000-8000-000000000011',
          slug: 'web-development',
          name: 'Web Development',
        },
        { id: 'a1a1a1a1-0000-4000-8000-000000000012', slug: 'data-science', name: 'Data Science' },
      ],
    },
    {
      id: 'a1a1a1a1-0000-4000-8000-000000000002',
      slug: 'design',
      name: 'Design',
      children: [],
    },
  ],
});

export function courseCard(n: number, overrides: Partial<CourseCard> = {}): CourseCard {
  const hex = n.toString(16).padStart(12, '0');
  return CourseCardSchema.parse({
    id: `c0c0c0c0-0000-4000-8000-${hex}`,
    slug: `course-${n}`,
    title: `Course number ${n}`,
    subtitle: `Subtitle of course ${n}`,
    level: 'BEGINNER',
    language: 'en',
    category: {
      id: 'a1a1a1a1-0000-4000-8000-000000000011',
      slug: 'web-development',
      name: 'Web Development',
    },
    instructor: { id: 'd0d0d0d0-0000-4000-8000-000000000001', displayName: 'Ada Lovelace' },
    lectureCount: 12,
    videoSeconds: 3 * 3600 + 5 * 60,
    publishedAt: '2026-10-01T10:00:00.123456+00:00',
    ...overrides,
  });
}

/**
 * Keyset cursors are opaque base64url text (here: `{"t":"2026-10-01T10:00:00.123456+00:00",...}`
 * with microseconds). The UI must send them back exactly as received.
 */
export const CURSOR_PAGE_2 =
  'eyJ0IjoiMjAyNi0xMC0wMVQxMDowMDowMC4xMjM0NTYrMDA6MDAiLCJpZCI6ImMwYzBjMGMwIn0';

export function coursePage(from: number, count: number, nextCursor: string | null): CourseCardPage {
  return CourseCardPageSchema.parse({
    items: Array.from({ length: count }, (_, i) => courseCard(from + i)),
    nextCursor,
  });
}

export function courseLanding(overrides: Partial<CourseLanding> = {}): CourseLanding {
  return CourseLandingSchema.parse({
    id: COURSE_ID,
    slug: 'modern-typescript',
    revisionId: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d',
    title: 'Modern TypeScript </script> & more',
    subtitle: 'From the type system to production-grade Node services',
    descriptionMd:
      '# Overview\n\nLearn **TypeScript** the practical way.\n\n- Generics\n- Narrowing',
    language: 'en',
    level: 'INTERMEDIATE',
    outcomes: ['Model domains with types', 'Write safe generics'],
    requirements: ['Basic JavaScript'],
    categoryPath: [
      { id: 'a1a1a1a1-0000-4000-8000-000000000001', slug: 'development', name: 'Development' },
      {
        id: 'a1a1a1a1-0000-4000-8000-000000000011',
        slug: 'web-development',
        name: 'Web Development',
      },
    ],
    instructor: {
      id: 'd0d0d0d0-0000-4000-8000-000000000001',
      displayName: 'Ada Lovelace',
      headline: 'Engineer and teacher',
      bio: 'Writes compilers for fun.',
      avatarUrl: null,
      isInstructor: true,
    },
    sections: [
      {
        id: '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e',
        title: 'Getting started',
        objective: 'Set up the toolchain',
        lectures: [
          {
            id: VIDEO_PREVIEW_ID,
            title: 'Welcome',
            type: 'VIDEO',
            durationSeconds: 245,
            isPreview: true,
          },
          {
            id: ARTICLE_PREVIEW_ID,
            title: 'Course notes',
            type: 'ARTICLE',
            durationSeconds: null,
            isPreview: true,
          },
        ],
      },
      {
        id: '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f',
        title: 'Types in depth',
        objective: null,
        lectures: [
          {
            id: LOCKED_VIDEO_ID,
            title: 'Generics',
            type: 'VIDEO',
            durationSeconds: 3723,
            isPreview: false,
          },
          {
            id: RESOURCE_ID,
            title: 'Cheat sheet',
            type: 'RESOURCE',
            durationSeconds: null,
            isPreview: false,
          },
        ],
      },
    ],
    totals: { sectionCount: 2, lectureCount: 4, videoSeconds: 245 + 3723 },
    publishedAt: '2026-09-01T08:00:00.000000+00:00',
    lastUpdatedAt: '2026-10-05T12:30:00.000000+00:00',
    ...overrides,
  });
}

export const previewArticle = PublicArticleSchema.parse({
  bodyMd: '# Notes\n\nRead **this** first. <img src=x onerror=alert(1)>',
});
