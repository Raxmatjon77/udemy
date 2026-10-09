import { z } from 'zod';

/**
 * Field schemas shared by event payloads. Producers already hold normalised domain values,
 * so these only guard the shape; the strict input rules live in the http request schemas.
 * Internal to the events folder (not re-exported).
 */
export const eventId = () => z.uuid();
export const eventTimestamp = () => z.iso.datetime({ offset: true });
/** Lenient on purpose: the domain `Email` VO already normalised it; an over-strict check here would abort the producing transaction. */
export const eventEmail = () =>
  z
    .string()
    .max(254)
    .regex(/^[^@\s]+@[^@\s]+$/, 'Invalid email address');
export const eventDisplayName = () => z.string().min(1).max(60);
