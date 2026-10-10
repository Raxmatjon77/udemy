/**
 * A tiny seeded PRNG (mulberry32) for the domain property tests: deterministic, so a failing
 * case is reproducible from its seed, and no extra dependency is needed.
 */
export interface Prng {
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  bool(): boolean;
}

export function prng(seed: number): Prng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new RangeError('pick from an empty list');
      return item;
    },
    bool: () => next() < 0.5,
  };
}
