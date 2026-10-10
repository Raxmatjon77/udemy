/** RFC 5322 msg-id as accepted by `MailMessage.messageId`: `<local@domain>`, no spaces. */
export const MESSAGE_ID_FORMAT = /^<[^\s<>@]+@[^\s<>@]+>$/;

/** Domain part of Message-IDs for event-driven mail (design §7). */
export const DEFAULT_MESSAGE_ID_DOMAIN = 'udemy.local';

const ID_PART = /^[A-Za-z0-9._-]+$/;

/** `<eventId@udemy.local>`: the deterministic Message-ID of the email an event triggers. */
export function eventMessageId(
  eventId: string,
  domain: string = DEFAULT_MESSAGE_ID_DOMAIN,
): string {
  if (!ID_PART.test(eventId) || !ID_PART.test(domain)) {
    throw new TypeError('eventMessageId: eventId and domain may contain only [A-Za-z0-9._-]');
  }
  return `<${eventId}@${domain}>`;
}

export function isValidMessageId(value: string): boolean {
  return MESSAGE_ID_FORMAT.test(value);
}
