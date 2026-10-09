import type { z } from 'zod';

/**
 * A producer tried to publish a payload that breaks its own event contract.
 * This is a bug in our code (not bad client input), so it maps to a 500.
 */
export class OutboxPayloadError extends Error {
  constructor(
    readonly eventType: string,
    readonly issues: readonly z.core.$ZodIssue[],
  ) {
    super(`Invalid payload for event ${eventType}: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'OutboxPayloadError';
  }
}
