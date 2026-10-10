import type { BanRecord } from '../../application/dto';

/** Columns of `identity.user_bans` that make up a BanRecord. */
export const BAN_COLUMNS = [
  'id',
  'userId',
  'reason',
  'bannedBy',
  'bannedAt',
  'liftedAt',
  'liftedBy',
  'liftReason',
] as const;

export function toBanRecord(row: BanRecord): BanRecord {
  return {
    id: row.id,
    userId: row.userId,
    reason: row.reason,
    bannedBy: row.bannedBy,
    bannedAt: row.bannedAt,
    liftedAt: row.liftedAt,
    liftedBy: row.liftedBy,
    liftReason: row.liftReason,
  };
}
