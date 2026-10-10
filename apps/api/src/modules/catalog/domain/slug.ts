import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '@udemy/contracts';

/**
 * URL slugs (design D12): `[a-z0-9]` words joined by single hyphens, at most 60 characters,
 * the same rule as the `courses_slug_ck` / `categories_slug_ck` CHECKs.
 */
export { SLUG_MAX_LENGTH };

/** Used when a title has no transliterable letter or digit at all (e.g. only CJK or emoji). */
export const FALLBACK_SLUG = 'course';

/** Letters NFKD does not decompose into ASCII plus a combining mark. */
const LATIN_SPECIALS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ı: 'i',
  ŧ: 't',
  ħ: 'h',
  ŋ: 'ng',
  ĸ: 'k',
  ſ: 's',
  // Uzbek Latin apostrophes (oʻ, gʻ) and the like simply separate nothing.
  ʻ: '',
  ʼ: '',
  '’': '',
  "'": '',
};

/**
 * Cyrillic (Russian, Ukrainian, Uzbek, Kazakh, Kyrgyz, Tajik letters), transliterated so the
 * many Cyrillic titles of this catalogue still get a readable slug.
 */
const CYRILLIC: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  є: 'ye',
  і: 'i',
  ї: 'yi',
  ґ: 'g',
  ў: 'o',
  қ: 'q',
  ғ: 'g',
  ҳ: 'h',
  ә: 'a',
  ө: 'o',
  ү: 'u',
  ұ: 'u',
  ң: 'ng',
  һ: 'h',
  ӣ: 'i',
  ӯ: 'u',
  ҷ: 'j',
};

/**
 * ASCII-folds `text` into a slug base: NFKD with combining marks removed, Latin specials and
 * Cyrillic transliterated, everything else outside `[a-z0-9]` collapsed into single hyphens,
 * trimmed of hyphens and cut to `maxLength` (never ending in a hyphen). May return `''`.
 */
export function slugify(text: string, maxLength: number = SLUG_MAX_LENGTH): string {
  // Transliterate on composed characters first (NFKD would turn "й" into "и" + breve).
  const folded = Array.from(text.normalize('NFC').toLowerCase())
    .map((ch) => LATIN_SPECIALS[ch] ?? CYRILLIC[ch] ?? ch)
    .join('')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
  const hyphenated = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return truncateSlug(hyphenated, maxLength);
}

/** Cuts at `maxLength` and drops a trailing hyphen left by the cut. */
function truncateSlug(slug: string, maxLength: number): string {
  return slug.slice(0, Math.max(0, maxLength)).replace(/-+$/, '');
}

/** The slug base for a title: `slugify(title)` or `fallback` when nothing survives. */
export function slugBase(title: string, fallback: string = FALLBACK_SLUG): string {
  const base = slugify(title);
  return base === '' ? fallback : base;
}

/**
 * The `n`-th candidate for `base` (n = 1 is the base itself, then `-2`, `-3`, ...). The base is
 * shortened so the whole candidate stays within 60 characters.
 */
export function slugCandidate(base: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('n must be a positive integer');
  if (n === 1) return truncateSlug(base, SLUG_MAX_LENGTH);
  const suffix = `-${n}`;
  const head = truncateSlug(base, SLUG_MAX_LENGTH - suffix.length);
  return `${head === '' ? FALLBACK_SLUG : head}${suffix}`;
}

/**
 * Every candidate for `base` starts with this prefix (room for a suffix up to `-99999`), so
 * "slugs taken among the candidates" is one `LIKE prefix%` lookup.
 */
export function slugCandidatePrefix(base: string): string {
  return truncateSlug(base, SLUG_MAX_LENGTH - 6);
}

/**
 * The first free candidate for `base` given the slugs already taken (by non-deleted courses
 * that start with `slugCandidatePrefix(base)`). Deterministic: base, base-2, base-3, ...
 */
export function firstFreeSlug(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = slugCandidate(base, n);
    if (!taken.has(candidate)) return candidate;
  }
}

export function isValidSlug(value: string): boolean {
  return value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}
