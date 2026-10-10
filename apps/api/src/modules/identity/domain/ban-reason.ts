import { InvalidBanReason } from './identity.errors';

const BAN_REASON = { min: 10, max: 1000 } as const;
const LIFT_REASON = { min: 1, max: 1000 } as const;

function length(value: string): number {
  return [...value].length;
}

/** Ban reason: trimmed, 10–1000 characters (DB CHECK user_bans_reason_ck). */
export function parseBanReason(raw: string): string {
  const value = raw.trim();
  const n = length(value);
  if (n < BAN_REASON.min || n > BAN_REASON.max) throw new InvalidBanReason();
  return value;
}

/** Optional lift reason: trimmed, 1–1000 characters when present (user_bans_lift_reason_ck). */
export function parseLiftReason(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  const n = length(value);
  if (n < LIFT_REASON.min || n > LIFT_REASON.max) throw new InvalidBanReason();
  return value;
}
