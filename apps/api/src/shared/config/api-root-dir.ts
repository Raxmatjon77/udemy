import { resolve } from 'node:path';

/**
 * Absolute path of the api package (`apps/api` in the repo, `/app` in the container).
 * This file sits at `<root>/src/shared/config` (tests) or `<root>/dist/shared/config`
 * (build), so the root is three levels up in both cases, independent of the process cwd.
 */
export const API_ROOT_DIR = resolve(__dirname, '..', '..', '..');
