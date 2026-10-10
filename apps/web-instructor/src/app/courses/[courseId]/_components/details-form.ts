import { z } from 'zod';
import {
  COURSE_LANGUAGES,
  COURSE_LEVELS,
  CourseBulletSchema,
  CourseDescriptionSchema,
  CourseSubtitleSchema,
  CourseTitleSchema,
  CURRICULUM_LIMITS,
  SlugSchema,
  type CourseDetail,
  type UpdateCourseRequest,
} from '@udemy/contracts';

import { friendlyZodError } from '@/lib/zod-messages';

/**
 * An optional text field: empty means "not set" (sent as `null`), anything else must pass the
 * contracts schema. A plain `z.union` would report a vague "Invalid input" instead of the
 * real reason, so the inner schema's first message is surfaced.
 */
function optionalText(schema: z.ZodType<string, string>) {
  return z.string().superRefine((value, ctx) => {
    if (value.trim() === '') return;
    const result = schema.safeParse(value, { error: friendlyZodError });
    if (!result.success) {
      ctx.addIssue({ code: 'custom', message: result.error.issues[0]?.message ?? 'Invalid value' });
    }
  });
}

const bullets = z
  .array(z.object({ value: CourseBulletSchema }))
  .max(CURRICULUM_LIMITS.maxBulletsPerKind);

export const DetailsFormSchema = z.object({
  title: CourseTitleSchema,
  subtitle: optionalText(CourseSubtitleSchema),
  descriptionMd: optionalText(CourseDescriptionSchema),
  language: z.enum(['', ...COURSE_LANGUAGES]),
  level: z.enum(['', ...COURSE_LEVELS]),
  categoryId: z.string(),
  slug: SlugSchema,
  outcomes: bullets,
  requirements: bullets,
});
export type DetailsFormInput = z.input<typeof DetailsFormSchema>;
export type DetailsFormOutput = z.output<typeof DetailsFormSchema>;

export function toFormValues(course: CourseDetail): DetailsFormInput {
  return {
    title: course.title,
    subtitle: course.subtitle ?? '',
    descriptionMd: course.descriptionMd ?? '',
    language: course.language ?? '',
    level: course.level ?? '',
    categoryId: course.categoryId ?? '',
    slug: course.slug,
    outcomes: course.outcomes.map((value) => ({ value })),
    requirements: course.requirements.map((value) => ({ value })),
  };
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * Only the fields that differ from the loaded course (so an unchanged frozen slug is never
 * sent), plus `expectedVersion` for the optimistic lock. `null` when nothing changed.
 */
export function toPatch(
  values: DetailsFormOutput,
  course: CourseDetail,
): UpdateCourseRequest | null {
  const patch: UpdateCourseRequest = {};
  if (values.title !== course.title) patch.title = values.title;
  const subtitle = values.subtitle.trim() || null;
  if (subtitle !== course.subtitle) patch.subtitle = subtitle;
  // Markdown is sent exactly as typed (trailing spaces matter); only "all blank" clears it.
  const description = values.descriptionMd.trim() === '' ? null : values.descriptionMd;
  if (description !== course.descriptionMd) patch.descriptionMd = description;
  const language = values.language || null;
  if (language !== course.language) patch.language = language;
  const level = values.level || null;
  if (level !== course.level) patch.level = level;
  const categoryId = values.categoryId || null;
  if (categoryId !== course.categoryId) patch.categoryId = categoryId;
  if (course.slugEditable && values.slug !== course.slug) patch.slug = values.slug;
  const outcomes = values.outcomes.map((item) => item.value);
  if (!sameList(outcomes, course.outcomes)) patch.outcomes = outcomes;
  const requirements = values.requirements.map((item) => item.value);
  if (!sameList(requirements, course.requirements)) patch.requirements = requirements;
  if (Object.keys(patch).length === 0) return null;
  return { ...patch, expectedVersion: course.version };
}
