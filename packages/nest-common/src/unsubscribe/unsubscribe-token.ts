import {
  isPreferenceLocked,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from '@udemy/contracts';

/**
 * The one-click unsubscribe token of notification e-mails (design D14, §5 `Unsubscribe`, §14):
 *
 *   v1.{userId}.{category}.{mac}
 *   mac = base64url(HMAC-SHA256(NOTIFICATIONS_UNSUBSCRIBE_SECRET, "v1|{userId}|{category}"))
 *
 * `userId` is the lowercase canonical uuid, `category` one of `NOTIFICATION_CATEGORIES`, and the
 * MAC the full 32-byte digest (43 base64url characters, no padding). The worker signs the tokens
 * into its notification e-mails and the api verifies them; both use THIS module (P5-T15 moved it
 * here from the api), so the format cannot drift between them. A token turns EMAIL off for ONE
 * category; it never expires (the link in an old e-mail keeps working) and is rotated by
 * rotating the secret.
 */
export const UNSUBSCRIBE_TOKEN_VERSION = 'v1';

export interface UnsubscribeTokenClaims {
  readonly userId: string;
  readonly category: NotificationCategory;
}

export interface ParsedUnsubscribeToken {
  readonly claims: UnsubscribeTokenClaims;
  /** The presented MAC (base64url, 43 characters); still to be verified. */
  readonly mac: string;
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;

/** The MAC input of a token: `v1|{userId}|{category}`. */
export function unsubscribeMacInput(claims: UnsubscribeTokenClaims): string {
  return `${UNSUBSCRIBE_TOKEN_VERSION}|${claims.userId}|${claims.category}`;
}

export function formatUnsubscribeToken(claims: UnsubscribeTokenClaims, mac: string): string {
  return `${UNSUBSCRIBE_TOKEN_VERSION}.${claims.userId}.${claims.category}.${mac}`;
}

/**
 * Syntax check only (the MAC is verified by the codec). Null for anything that is not a v1
 * token for an unlockable category: a locked category (MODERATION) can never be unsubscribed,
 * so such a token is invalid whoever signed it.
 */
export function parseUnsubscribeToken(token: string): ParsedUnsubscribeToken | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, userId, category, mac] = parts as [string, string, string, string];
  if (version !== UNSUBSCRIBE_TOKEN_VERSION || !USER_ID.test(userId) || !MAC.test(mac)) {
    return null;
  }
  if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(category)) return null;
  const claims = { userId, category: category as NotificationCategory };
  if (isPreferenceLocked(claims.category, 'EMAIL')) return null;
  return { claims, mac };
}

/** True when e-mails of `category` can carry an unsubscribe token (its EMAIL channel is not locked). */
export function isUnsubscribable(category: NotificationCategory): boolean {
  return !isPreferenceLocked(category, 'EMAIL');
}
