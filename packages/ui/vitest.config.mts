import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The playback controller is DOM-free (the media element is an interface), so plain Node.
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
