/** One outgoing email. Plain text is mandatory; HTML is an optional alternative part. */
export interface MailMessage {
  to: string | readonly string[];
  subject: string;
  text: string;
  html?: string;
  /**
   * Value of the `Message-ID` header, in RFC 5322 form `<id@domain>`. Event-driven mail uses
   * `eventMessageId(eventId)` (design §7), so a redelivered event re-sends the same Message-ID
   * and downstream systems can deduplicate. Omit it to let the transport generate one.
   */
  messageId?: string;
}

export interface MailSendResult {
  /** The Message-ID the message was sent with. */
  messageId: string;
  /** Recipients the SMTP server accepted / rejected (a partial rejection does not throw). */
  accepted: string[];
  rejected: string[];
}

/**
 * Port for sending email. Inject it by class: `constructor(private readonly mailer: Mailer)`.
 * `MailModule.forRoot()` binds it to the SMTP adapter; tests bind a fake.
 *
 * `send` throws `DependencyUnavailableError('smtp')` when the server cannot be reached (retry
 * later), and the transport's own error for permanent failures (e.g. every recipient rejected).
 */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<MailSendResult>;
}
