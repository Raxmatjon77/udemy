import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as main from '../index';
import * as testing from './index.mjs';

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
  exports: Record<string, { types: string; default: string }>;
  dependencies: Record<string, string>;
};

describe('@udemy/payments/testing', () => {
  it('is a separate ESM subpath and not part of the main entry', () => {
    expect(pkg.exports['./testing']).toEqual({
      types: './dist/testing/index.d.mts',
      default: './dist/testing/index.mjs',
    });
    for (const name of ['signTestWebhook', 'InMemoryPaymentProvider', 'stripeEvent']) {
      expect(Object.keys(main)).not.toContain(name);
      expect(Object.keys(testing)).toContain(name);
    }
  });

  it('does not expose the vitest stripe-mock harness (the emulator imports this entry)', () => {
    expect(Object.keys(testing)).not.toContain('useStripeMock');
    const source = readFileSync(join(__dirname, 'index.mts'), 'utf8');
    expect(source).not.toMatch(/from '[^']*(vitest|it-stripe-mock)/);
  });

  it('pins the stripe SDK exactly', () => {
    expect(pkg.dependencies.stripe).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('randomWebhookSecret is an ephemeral whsec_ secret', () => {
    const a = testing.randomWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);
    expect(testing.randomWebhookSecret()).not.toBe(a);
  });

  it('signTestWebhook accepts a Date or unix seconds and rejects milliseconds', () => {
    const date = new Date('2026-10-10T12:00:00.000Z');
    const seconds = Math.floor(date.getTime() / 1000);
    expect(testing.signTestWebhook('{}', 'whsec_x', date)).toBe(
      testing.signTestWebhook('{}', 'whsec_x', seconds),
    );
    expect(() => testing.signTestWebhook('{}', 'whsec_x', 1.5)).toThrow(RangeError);
  });
});
