/**
 * Linear-time cost guard run BEFORE the CommonMark parser.
 *
 * This is not the security decision (that is the mdast walk in validate.ts); it only bounds the
 * parser's CPU time. micromark has no regex backtracking, but several of its algorithms are
 * quadratic. Measured on micromark 4.0.3 / mdast-util-from-markdown 2.1.0, Node 22, Apple M-series,
 * with 100 000 characters (the article contract limit) and no guard:
 * - list items: 25 000 lines of `- - x` ≈ 14 s, 33 000 lines of `- x` ≈ 0.8 s, a realistic 4-level
 *   nested list ≈ 2.3 s (cost grows with list items × events);
 * - emphasis resolution: each potential closing `*`/`_`/`~` scans back over the paragraph, so one
 *   paragraph of `a*b*c + d*e` ≈ 2.2 s and 30 000 `**_` runs ≈ 14 s;
 * - label ends: `[a](`×20 000 ≈ 2 s;
 * - one line of `- `×10 000 ≈ 15 s and then a stack overflow.
 *
 * Budgets (each measured to keep the parse near or below ~100 ms in the worst shape, see
 * validate.spec.ts "performance"), far above what course text needs:
 * - at most MAX_LIST_MARKERS list-item markers in the whole document;
 * - at most MAX_LINE_CONTAINERS container markers (`>`, list markers) at the start of a line, and
 *   at most MAX_LINE_NESTING_ESTIMATE once leading indentation (2 columns = 1 level) is added in;
 * - per blank-line-separated chunk (a paragraph never spans a blank line): the number of
 *   potential closing delimiters (`*`/`~` runs not after whitespace, `_` runs not after whitespace
 *   nor before an ASCII letter/digit, each weighted by run length², plus `]`) times the chunk
 *   length, summed over chunks, is at most DELIMITER_BUDGET.
 *
 * It is deliberately conservative (it also counts inside code blocks), so a rejection is reported
 * as "too complex" / "too deeply nested", never as a security verdict.
 */

export const MAX_LIST_MARKERS = 2_000;
export const MAX_LINE_CONTAINERS = 16;
export const MAX_LINE_NESTING_ESTIMATE = 64;
export const DELIMITER_BUDGET = 25_000_000;

export interface ComplexityViolation {
  kind: 'too_deeply_nested' | 'too_complex';
  line: number;
  column: number;
  detail: string;
}

const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;

function isWhitespace(c: number): boolean {
  return c === SPACE || c === TAB || c === LF || c === CR || c === 0x0b || c === 0x0c;
}

function isAsciiAlnum(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

export function checkComplexity(source: string): ComplexityViolation | null {
  const n = source.length;
  let listMarkers = 0;
  let delimiterCost = 0;
  let chunkClosers = 0;
  let chunkStart = 0;
  let lineNo = 1;
  let i = 0;

  const violation = (kind: ComplexityViolation['kind'], detail: string): ComplexityViolation => ({
    kind,
    line: lineNo,
    column: 1,
    detail,
  });

  for (;;) {
    const lineStart = i;

    // --- leading indentation and block-container markers ---
    let indentCols = 0;
    let markers = 0;
    let p = i;
    for (;;) {
      while (p < n && (source.charCodeAt(p) === SPACE || source.charCodeAt(p) === TAB)) {
        indentCols += source.charCodeAt(p) === TAB ? 4 : 1;
        p++;
      }
      if (p >= n) break;
      const c = source.charCodeAt(p);
      if (c === 0x3e /* > */) {
        markers++;
        p++;
        continue;
      }
      if ((c === 0x2d || c === 0x2b || c === 0x2a) /* - + * */ && p + 1 < n) {
        const next = source.charCodeAt(p + 1);
        if (next === SPACE || next === TAB) {
          markers++;
          listMarkers++;
          p += 2;
          continue;
        }
      }
      if (c >= 0x30 && c <= 0x39) {
        let q = p;
        while (q < n && q - p < 9 && source.charCodeAt(q) >= 0x30 && source.charCodeAt(q) <= 0x39) {
          q++;
        }
        const d = q < n ? source.charCodeAt(q) : -1;
        const after = q + 1 < n ? source.charCodeAt(q + 1) : -1;
        if ((d === 0x2e || d === 0x29) /* . ) */ && (after === SPACE || after === TAB)) {
          markers++;
          listMarkers++;
          p = q + 2;
          continue;
        }
      }
      break;
    }
    if (markers > MAX_LINE_CONTAINERS) {
      return violation(
        'too_deeply_nested',
        `More than ${MAX_LINE_CONTAINERS} nested lists or quotes on one line`,
      );
    }
    if (markers + Math.floor(indentCols / 2) > MAX_LINE_NESTING_ESTIMATE) {
      return violation('too_deeply_nested', 'Line is indented or nested too deeply');
    }
    if (listMarkers > MAX_LIST_MARKERS) {
      return violation('too_complex', `More than ${MAX_LIST_MARKERS} list items`);
    }

    // --- rest of the line: potential closing delimiters; a blank line ends the chunk ---
    let blank = true;
    let q = lineStart;
    while (q < n) {
      const c = source.charCodeAt(q);
      if (c === LF || c === CR) break;
      if (c !== SPACE && c !== TAB) blank = false;
      if (c === 0x2a || c === 0x7e || c === 0x5f /* * ~ _ */) {
        const before = q > lineStart ? source.charCodeAt(q - 1) : LF;
        let end = q;
        while (end < n && source.charCodeAt(end) === c) end++;
        const after = end < n ? source.charCodeAt(end) : LF;
        if (!isWhitespace(before) && (c !== 0x5f || !isAsciiAlnum(after))) {
          // A run of length L closes up to L/2 nested emphases, each re-splicing the run: L².
          chunkClosers += (end - q) * (end - q);
        }
        q = end;
        continue;
      }
      if (c === 0x5d /* ] */) chunkClosers++;
      q++;
    }
    const lineEnd = q;
    if (blank) {
      // A blank line ends the chunk: commit its cost and start a new one after this line.
      delimiterCost += chunkClosers * (lineStart - chunkStart);
      chunkClosers = 0;
    } else if (delimiterCost + chunkClosers * (lineEnd - chunkStart) > DELIMITER_BUDGET) {
      return violation(
        'too_complex',
        'Too many emphasis, strikethrough or link markers in one paragraph; split it with blank lines',
      );
    }

    // --- next line (CRLF, LF or CR) ---
    if (q >= n) break;
    i = q + (source.charCodeAt(q) === CR && source.charCodeAt(q + 1) === LF ? 2 : 1);
    lineNo++;
    if (blank) chunkStart = i;
  }
  return null;
}
