import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy*/waitFor give up after 1 s by default. Under a full parallel turbo run (or a shared CI
// runner) renders and mocked fetches take longer, so tests flaked; assertions are unchanged.
configure({ asyncUtilTimeout: 10_000 });

// Vitest runs without globals, so Testing Library's auto-cleanup is not registered.
afterEach(() => {
  cleanup();
});
