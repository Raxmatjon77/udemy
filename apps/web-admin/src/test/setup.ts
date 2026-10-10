import { afterEach, vi } from 'vitest';

/*
 * Shared test setup. Component tests (`// @vitest-environment jsdom`) render with Testing
 * Library; Node-only specs ignore the DOM parts.
 */

if (typeof window !== 'undefined') {
  const { cleanup, configure } = await import('@testing-library/react');
  // findBy*/waitFor give up after 1 s by default. Under a full parallel turbo run (or a shared CI
  // runner) renders and mocked fetches take longer, so tests flaked; assertions are unchanged.
  configure({ asyncUtilTimeout: 10_000 });
  afterEach(() => {
    cleanup();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});
