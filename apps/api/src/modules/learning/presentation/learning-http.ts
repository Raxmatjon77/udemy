import type { Request } from 'express';

/*
 * Resource-id extractors for `@CheckPolicy` (the guard runs before the param pipes; a missing or
 * malformed id resolves to "does not exist", 404).
 */
export const noteIdOf = (req: Request): string => String(req.params.noteId);
export const attemptIdOf = (req: Request): string => String(req.params.attemptId);
export const certificateIdOf = (req: Request): string => String(req.params.certificateId);

/** Signed URLs are per request and short-lived: never cache them. */
export const SIGNED_URL_CACHE_CONTROL = 'private, no-store';
