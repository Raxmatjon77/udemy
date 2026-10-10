import { describe, expect, it } from 'vitest';
import { RECOMMENDED_PROXY_MATCHER } from '@udemy/web-auth/proxy';

import { config } from './proxy';

describe('proxy config', () => {
  it('uses the matcher recommended by @udemy/web-auth (it must be a literal in proxy.ts)', () => {
    expect(config.matcher).toEqual([RECOMMENDED_PROXY_MATCHER]);
  });
});
