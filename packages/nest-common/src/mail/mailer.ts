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
  /**
   * Extra header fields, e.g. RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` on
   * notification e-mails. Only names from `MAIL_EXTRA_HEADER_NAMES` are accepted, and values
   * must be one line (`assertMailHeaders`), so no header can be injected.
   */
  headers?: Readonly<Record<string, string>>;
}

/** The extra header fields a `MailMessage` may set (everything else is the transport's job). */
export const MAIL_EXTRA_HEADER_NAMES: readonly string[] = Object.freeze([
  'List-Unsubscribe',
  'List-Unsubscribe-Post',
]);

/** Throws TypeError for a header name outside the allowlist or a value with a line break. */
export function assertMailHeaders(headers: Readonly<Record<string, string>> | undefined): void {
  if (headers === undefined) return;
  for (const [name, value] of Object.entries(headers)) {
    if (!MAIL_EXTRA_HEADER_NAMES.includes(name)) {
      throw new TypeError(`MailMessage.headers: "${name}" is not an allowed header`);
    }
    if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) {
      throw new TypeError(`MailMessage.headers: "${name}" must be a non-empty single line`);
    }
  }
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
