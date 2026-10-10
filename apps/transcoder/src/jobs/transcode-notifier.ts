import type { Logger } from '@nestjs/common';
import pg from 'pg';

export const TRANSCODE_CHANNEL = 'media_transcode';
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export interface TranscodeNotifierOptions {
  readonly connectionString: string;
  readonly applicationName: string;
  /** Called on every notification and after every (re)connect (notifications are lost while down). */
  readonly onNotify: () => void;
  readonly logger: Pick<Logger, 'log' | 'warn'>;
}

/**
 * `LISTEN media_transcode` on a dedicated, non-pooled `pg.Client` (schema doc §8.1). A latency
 * optimisation only: the poll is the correctness path. Reconnects with capped backoff.
 */
export class TranscodeNotifier {
  private client: pg.Client | undefined;
  private stopped = false;
  private backoffMs = MIN_BACKOFF_MS;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: TranscodeNotifierOptions) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) {
      client.removeAllListeners('end');
      await client.end().catch(() => undefined);
    }
  }

  get connected(): boolean {
    return this.client !== undefined;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({
      connectionString: this.options.connectionString,
      application_name: this.options.applicationName,
    });
    client.on('notification', (message) => {
      if (message.channel === TRANSCODE_CHANNEL) this.options.onNotify();
    });
    client.on('error', (error) => {
      this.options.logger.warn({ err: error }, 'LISTEN connection error');
      this.dropAndReconnect(client);
    });
    client.on('end', () => this.dropAndReconnect(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${TRANSCODE_CHANNEL}`);
      if (this.stopped) {
        await client.end().catch(() => undefined);
        return;
      }
      this.client = client;
      this.backoffMs = MIN_BACKOFF_MS;
      this.options.logger.log(`Listening on ${TRANSCODE_CHANNEL}`);
      this.options.onNotify();
    } catch (error) {
      this.options.logger.warn({ err: error }, 'LISTEN connect failed');
      this.dropAndReconnect(client);
    }
  }

  private dropAndReconnect(client: pg.Client): void {
    client.removeAllListeners('end');
    client.end().catch(() => undefined);
    if (this.client === client) this.client = undefined;
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }
}
