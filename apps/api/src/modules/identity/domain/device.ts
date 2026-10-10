/**
 * A tiny, dependency-free User-Agent parser for the sessions list (design §5 ListMySessions:
 * "device parsed from UA at read time"). It only has to tell a user which of their own devices
 * a session belongs to, e.g. "Firefox on Windows". Unknown agents give null.
 *
 * Order matters: many browsers carry other browsers' tokens (Edge says "Chrome", Chrome says
 * "Safari"), so the more specific token is tested first.
 */
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

const MAX_UA_LENGTH = 512;

function firstMatch(ua: string, table: readonly (readonly [RegExp, string])[]): string | null {
  for (const [pattern, name] of table) if (pattern.test(ua)) return name;
  return null;
}

/** `"Chrome on macOS"`, `"Firefox"`, `"iOS"`, or null when nothing is recognised. */
export function describeDevice(userAgent: string | null | undefined): string | null {
  if (userAgent === null || userAgent === undefined) return null;
  const ua = userAgent.slice(0, MAX_UA_LENGTH);
  if (ua.trim() === '') return null;
  const browser = firstMatch(ua, BROWSERS);
  const system = firstMatch(ua, SYSTEMS);
  if (browser !== null && system !== null) return `${browser} on ${system}`;
  return browser ?? system;
}
