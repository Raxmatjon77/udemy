import { afterEach } from 'vitest';

// Testing Library auto-cleanup needs vitest `globals`; this project keeps them off.
afterEach(async () => {
  if (typeof document === 'undefined') return;
  const { cleanup } = await import('@testing-library/react');
  cleanup();
  window.sessionStorage.clear();
});
