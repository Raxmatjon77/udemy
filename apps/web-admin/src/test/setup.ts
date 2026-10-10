import { afterEach, vi } from 'vitest';

/*
 * Shared test setup. Component tests (`// @vitest-environment jsdom`) render with Testing
 * Library; Node-only specs ignore the DOM parts.
 */

if (typeof window !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => {
    cleanup();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});
