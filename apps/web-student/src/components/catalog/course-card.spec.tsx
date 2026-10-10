/** @vitest-environment jsdom */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { courseCard } from '@/test/fixtures/catalog';

import { CourseCard } from './course-card';

const image = (container: HTMLElement) =>
  container.querySelector('[data-slot="course-thumbnail"] img');
const placeholder = (container: HTMLElement) =>
  container.querySelector('[data-slot="thumbnail-placeholder"]');

describe('<CourseCard> thumbnail', () => {
  it('skips the image request and shows the placeholder when hasThumbnail is false', () => {
    const { container } = render(<CourseCard course={courseCard(1, { hasThumbnail: false })} />);
    expect(image(container)).toBeNull();
    expect(placeholder(container)?.textContent).toBe('CN');
  });

  it('requests the stable image route when hasThumbnail is true', () => {
    const course = courseCard(2, { hasThumbnail: true });
    const { container } = render(<CourseCard course={course} />);
    // next/image may make the URL absolute: compare path and query.
    const src = new URL(image(container)!.getAttribute('src')!, 'http://localhost:3000');
    expect(`${src.pathname}${src.search}`).toBe(
      `/media/course-thumbnail/${course.id}?variant=w480`,
    );
    expect(placeholder(container)).toBeNull();
  });

  it('still tries the image route when the flag is absent (older API)', () => {
    const course = courseCard(3);
    expect(course.hasThumbnail).toBeUndefined();
    const { container } = render(<CourseCard course={course} />);
    expect(image(container)).not.toBeNull();
  });
});
