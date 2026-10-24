import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { effectivePreferences, lockedPairsOf } from './notification-preferences';

describe('effectivePreferences', () => {
  it('lists every category × channel in contract order with the code defaults', () => {
    const items = effectivePreferences([]);
    expect(items.map((i) => `${i.category}:${i.channel}`)).toEqual(
      NOTIFICATION_CATEGORIES.flatMap((c) => NOTIFICATION_CHANNELS.map((ch) => `${c}:${ch}`)),
    );
    expect(items.every((i) => i.isDefault)).toBe(true);
    expect(items.filter((i) => !i.enabled)).toEqual([
      {
        category: 'COURSE_BUILDING',
        channel: 'EMAIL',
        enabled: false,
        locked: false,
        isDefault: true,
      },
    ]);
  });

  it('applies overrides, except on locked pairs', () => {
    const items = effectivePreferences([
      { category: 'REVIEWS', channel: 'IN_APP', enabled: false },
      { category: 'MODERATION', channel: 'IN_APP', enabled: false },
    ]);
    expect(items.find((i) => i.category === 'REVIEWS' && i.channel === 'IN_APP')).toEqual({
      category: 'REVIEWS',
      channel: 'IN_APP',
      enabled: false,
      locked: false,
      isDefault: false,
    });
    expect(items.find((i) => i.category === 'MODERATION' && i.channel === 'IN_APP')).toEqual({
      category: 'MODERATION',
      channel: 'IN_APP',
      enabled: true,
      locked: true,
      isDefault: true,
    });
  });
});

describe('lockedPairsOf', () => {
  it('returns only the locked pairs', () => {
    expect(
      lockedPairsOf([
        { category: 'QA', channel: 'EMAIL' },
        { category: 'MODERATION', channel: 'EMAIL' },
      ]),
    ).toEqual([{ category: 'MODERATION', channel: 'EMAIL' }]);
  });
});
