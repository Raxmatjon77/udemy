import type { EventDefinition, EventEnvelope, EventPayload } from '@udemy/contracts';
import { NonRetryableError } from './non-retryable.error';

/**
 * Validates an envelope against the contract version a handler was written for. Another
 * version cannot be handled by that code and goes to the DLQ (NonRetryableError) instead of
 * being dropped silently; a payload that breaks the contract throws a ZodError, which the
 * dispatcher also dead-letters.
 */
export function parseEvent<TDef extends EventDefinition>(
  definition: TDef,
  envelope: EventEnvelope,
): EventPayload<TDef> {
  if (!definition.matches(envelope)) {
    throw new NonRetryableError(
      `Unsupported ${envelope.eventType} version ${envelope.version} (expected v${definition.version})`,
    );
  }
  return definition.parsePayload(envelope.payload) as EventPayload<TDef>;
}
