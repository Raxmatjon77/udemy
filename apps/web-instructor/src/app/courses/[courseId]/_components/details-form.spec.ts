import { describe, expect, it } from 'vitest';
import { UpdateCourseRequestSchema } from '@udemy/contracts';

import { courseDetail } from '@/test/fixtures';

import { DetailsFormSchema, toFormValues, toPatch } from './details-form';

describe('details form', () => {
  it('sends only changed fields, with expectedVersion, valid against the contract', () => {
    const course = courseDetail();
    const values = DetailsFormSchema.parse({
      ...toFormValues(course),
      subtitle: 'Build production-grade APIs step by step',
      outcomes: [{ value: 'Write modules' }, { value: 'Test them' }],
      language: '',
    });
    const patch = toPatch(values, course);
    expect(patch).toEqual({
      subtitle: 'Build production-grade APIs step by step',
      language: null,
      outcomes: ['Write modules', 'Test them'],
      expectedVersion: 3,
    });
    expect(UpdateCourseRequestSchema.safeParse(patch).success).toBe(true);
  });

  it('returns null without changes and never sends a frozen slug', () => {
    const course = courseDetail({ slugEditable: false });
    expect(toPatch(DetailsFormSchema.parse(toFormValues(course)), course)).toBeNull();
    const renamed = DetailsFormSchema.parse({ ...toFormValues(course), slug: 'other-slug' });
    expect(toPatch(renamed, course)).toBeNull();
  });

  it('reports the real reason for an optional field', () => {
    const result = DetailsFormSchema.safeParse({
      ...toFormValues(courseDetail()),
      subtitle: 'short',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Must be at least 10 characters.');
  });
});
