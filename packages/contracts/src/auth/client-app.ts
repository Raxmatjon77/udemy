import { z } from 'zod';

/**
 * The frontend (BFF) a token was issued to. Tokens carry it as the `app` claim, and the
 * effective permissions of a principal depend on it (design D6): student -> STUDENT,
 * instructor -> INSTRUCTOR, admin -> ADMIN.
 */
export const CLIENT_APPS = ['student', 'instructor', 'admin'] as const;
export const ClientAppSchema = z.enum(CLIENT_APPS);
export type ClientApp = z.infer<typeof ClientAppSchema>;
