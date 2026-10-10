import type { RateLimitRule } from '../../../shared/redis';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Redis limiter keys and rules of design §6 ("Redis keys"). Counting always happens whether or
 * not the account exists, so a 429 never reveals an account.
 */
export const AUTH_RATE_LIMITS = {
  /** Every login attempt from one IP. */
  loginIp: { limit: 30, windowMs: 10 * MINUTE },
  /** Failed logins for one email from one IP. */
  loginEmailIp: { limit: 5, windowMs: 15 * MINUTE },
  /** Failed logins for one email from anywhere (looser ceiling; no hard lockout). */
  loginEmail: { limit: 50, windowMs: HOUR },
  /** Signups from one IP. */
  signupIp: { limit: 10, windowMs: HOUR },
  /** "You already have an account" mails per existing user. */
  signupExistingNotice: { limit: 1, windowMs: 24 * HOUR },
  /** Forgot-password requests per email (counted for unknown emails too; over it: silent drop). */
  forgotEmail: { limit: 3, windowMs: HOUR },
  /** Forgot-password requests per client IP. */
  forgotIp: { limit: 10, windowMs: HOUR },
  /** Verification mail re-sends per user. */
  verifyResend: { limit: 3, windowMs: HOUR },
} as const satisfies Record<string, RateLimitRule>;

/** `rl:login:*` keys for one attempt; `emailHmac` is hex HMAC-SHA256 of the normalised email. */
export function loginLimiterKeys(
  emailHmac: string,
  ip: string,
): { ip: string; emailIp: string; email: string } {
  return {
    ip: `rl:login:ip:${ip}`,
    emailIp: `rl:login:eip:${emailHmac}:${ip}`,
    email: `rl:login:e:${emailHmac}`,
  };
}

export function signupIpKey(ip: string): string {
  return `rl:signup:ip:${ip}`;
}

export function signupExistingNoticeKey(userId: string): string {
  return `rl:signup-existing-notice:u:${userId}`;
}

/** `rl:forgot:*` keys; `emailHmac` is hex HMAC-SHA256 of the normalised email. */
export function forgotLimiterKeys(emailHmac: string, ip: string): { email: string; ip: string } {
  return { email: `rl:forgot:e:${emailHmac}`, ip: `rl:forgot:ip:${ip}` };
}

export function verifyResendKey(userId: string): string {
  return `rl:verify-resend:u:${userId}`;
}
