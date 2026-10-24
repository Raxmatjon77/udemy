import { createTransport, type SentMessageInfo, type Transporter } from 'nodemailer';
import { DependencyUnavailableError } from '../errors/dependency-unavailable.error';
import { assertMailHeaders, Mailer, type MailMessage, type MailSendResult } from './mailer';
import { isValidMessageId } from './message-id';

export interface SmtpMailerOptions {
  host: string;
  port: number;
  /** Default `From` header, e.g. `Udemy Clone <no-reply@udemy.local>`. */
  from: string;
  /** Implicit TLS. Defaults to `port === 465`. */
  secure?: boolean;
  /** Keep SMTP connections open between messages (worker). Defaults to true. */
  pool?: boolean;
  connectionTimeoutMs?: number;
  socketTimeoutMs?: number;
}

/**
 * nodemailer error codes that mean "the SMTP server could not be reached / talked to":
 * transient, so they become DependencyUnavailableError and the caller (worker) retries.
 */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ETLS',
  'ECONNREFUSED',
  'ECONNRESET',
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function toAddressList(addresses: unknown): string[] {
  if (!Array.isArray(addresses)) return [];
  return addresses.map((item: unknown) =>
    typeof item === 'object' && item !== null && 'address' in item
      ? String(item.address)
      : String(item),
  );
}

/** `Mailer` over SMTP (Mailpit in dev). */
export class SmtpMailer extends Mailer {
  private readonly transport: Transporter<SentMessageInfo>;

  constructor(private readonly options: SmtpMailerOptions) {
    super();
    const common = {
      host: options.host,
      port: options.port,
      secure: options.secure ?? options.port === 465,
      connectionTimeout: options.connectionTimeoutMs ?? 5_000,
      greetingTimeout: options.connectionTimeoutMs ?? 5_000,
      socketTimeout: options.socketTimeoutMs ?? 15_000,
    };
    this.transport =
      (options.pool ?? true)
        ? createTransport({ ...common, pool: true, maxConnections: 2 })
        : createTransport(common);
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    if (message.messageId !== undefined && !isValidMessageId(message.messageId)) {
      throw new TypeError('MailMessage.messageId must look like <id@domain>');
    }
    assertMailHeaders(message.headers);
    try {
      const info = await this.transport.sendMail({
        from: this.options.from,
        to: typeof message.to === 'string' ? message.to : [...message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: message.messageId,
        ...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
      });
      return {
        messageId: info.messageId,
        accepted: toAddressList(info.accepted),
        rejected: toAddressList(info.rejected),
      };
    } catch (error) {
      const code = errorCode(error);
      if (code !== undefined && UNAVAILABLE_CODES.has(code)) {
        throw new DependencyUnavailableError('smtp', { cause: error });
      }
      throw error;
    }
  }

  /** Closes pooled connections. Called on application shutdown by MailModule. */
  close(): void {
    this.transport.close();
  }
}
