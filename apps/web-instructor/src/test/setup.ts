import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  // findBy*/waitFor give up after 1 s by default. Under a full parallel turbo run (or a shared CI
  // runner) renders and mocked fetches take longer, so tests flaked; assertions are unchanged.
  const { configure } = await import('@testing-library/react');
  configure({ asyncUtilTimeout: 10_000 });
}

// Testing Library auto-cleanup needs vitest `globals`; this project keeps them off.
afterEach(async () => {
  if (typeof document === 'undefined') return;
  const { cleanup } = await import('@testing-library/react');
  cleanup();
  window.sessionStorage.clear();
});
