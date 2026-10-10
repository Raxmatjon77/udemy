import { OpaqueTokenSchema } from '@udemy/contracts';

/**
 * One-time tokens (email verification, password reset) arrive in the URL FRAGMENT
 * (`/verify-email#token=…`): fragments are never sent to any server, so the token stays out of
 * access logs, proxies and Referer headers.
 */

/** Reads `token` from a `location.hash` value (`#token=abc`), or null when absent/malformed. */
export function readFragmentToken(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!fragment) return null;
  const token = new URLSearchParams(fragment).get('token');
  if (token === null) return null;
  return OpaqueTokenSchema.safeParse(token).success ? token : null;
}

type LocationLike = Pick<Location, 'hash' | 'pathname' | 'search'>;
type HistoryLike = Pick<History, 'replaceState' | 'state'>;

/**
 * Reads the token and immediately removes the whole fragment from the address bar and the
 * history entry (`history.replaceState`), so it is not left in history, bookmarks or a
 * screenshot. The current history state is kept (Next's router stores its own data there).
 */
export function takeFragmentToken(location: LocationLike, history: HistoryLike): string | null {
  const token = readFragmentToken(location.hash);
  if (location.hash) {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  }
  return token;
}
