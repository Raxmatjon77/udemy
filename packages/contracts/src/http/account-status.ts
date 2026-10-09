import { z } from 'zod';

/** Derived from `identity.user_bans`: BANNED while an unlifted ban exists. */
export const ACCOUNT_STATUSES = ['ACTIVE', 'BANNED'] as const;
export const AccountStatusSchema = z.enum(ACCOUNT_STATUSES);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;
