import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderEvent } from '@udemy/payments';
import { WebhookSignatureInvalidError } from '@udemy/payments';

/**
 * A local webhook endpoint for tests: it verifies every delivery exactly like the api's
 * `StripeSignatureGuard` will (the given `verify`, i.e. `StripePaymentProvider.verifyWebhook`
 * over the RAW bytes), answers 200 / 400, and keeps every request for assertions.
 */
export interface SinkDelivery {
  readonly rawBody: Buffer;
  readonly signatureHeader: string | undefined;
  readonly userAgent: string | undefined;
  /** The verified, normalized event; null when verification failed. */
  readonly event: ProviderEvent | null;
  /** The parsed JSON (also for rejected deliveries; null when it is not JSON). */
  readonly json: Record<string, unknown> | null;
  readonly verificationError: string | null;
  readonly respondedWith: number;
}

export type Verify = (rawBody: Buffer, signatureHeader: string | undefined) => ProviderEvent;

export interface WebhookSink {
  readonly url: string;
  readonly deliveries: SinkDelivery[];
  /** Answer the next `count` VALID deliveries with `status` (e.g. 500) to exercise retries. */
  failNext(count: number, status?: number): void;
  verified(): ProviderEvent[];
  clear(): void;
  close(): Promise<void>;
}

async function rawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseJson(body: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function startWebhookSink(verify: Verify): Promise<WebhookSink> {
  const deliveries: SinkDelivery[] = [];
  const failures: number[] = [];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await rawBody(req);
    const header = req.headers['stripe-signature'];
    const signatureHeader = Array.isArray(header) ? header[0] : header;
    let event: ProviderEvent | null = null;
    let verificationError: string | null = null;
    try {
      event = verify(body, signatureHeader);
    } catch (error) {
      verificationError =
        error instanceof WebhookSignatureInvalidError ? error.reason : String(error);
    }
    const status = event === null ? 400 : (failures.shift() ?? 200);
    deliveries.push({
      rawBody: body,
      signatureHeader,
      userAgent: req.headers['user-agent'],
      event,
      json: parseJson(body),
      verificationError,
      respondedWith: status,
    });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(event === null ? { error: 'webhook_signature_invalid' } : { received: true }),
    );
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/v1/webhooks/stripe`,
    deliveries,
    failNext(count: number, status = 500): void {
      for (let index = 0; index < count; index += 1) failures.push(status);
    },
    verified(): ProviderEvent[] {
      return deliveries.flatMap((delivery) => (delivery.event === null ? [] : [delivery.event]));
    },
    clear(): void {
      deliveries.length = 0;
      failures.length = 0;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      });
    },
  };
}
