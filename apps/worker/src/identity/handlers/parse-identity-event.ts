import type { EventDefinition, EventEnvelope, EventPayload } from '@udemy/contracts';
import { NonRetryableError } from '../../messaging';

/**
 * Validates an envelope against the v1 contract. Another version cannot be handled by this
 * code and goes to the DLQ (NonRetryableError) instead of being dropped silently; a payload
 * that breaks the contract throws a ZodError, which the dispatcher also dead-letters.
 */
export function parseIdentityEvent<TDef extends EventDefinition>(
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
