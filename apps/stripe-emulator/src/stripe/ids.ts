import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** `prefix_` + `length` random alphanumerics, e.g. `stripeId('cs_test', 58)`. */
export function stripeId(prefix: string, length = 24): string {
  let id = '';
  for (const byte of randomBytes(length)) id += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${id}`;
}

/** Milliseconds since the epoch; injectable so tests can move time without sleeping. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export function unixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}
