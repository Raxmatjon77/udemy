import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The client is DOM-free (the socket is injected); React specs opt into jsdom per file.
    environment: 'node',
    include: ['src/**/*.spec.{ts,tsx}'],
  },
});
