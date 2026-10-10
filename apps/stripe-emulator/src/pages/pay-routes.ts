import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { parseForm } from '../http/form';
import { mediaType, readBody, send } from '../http/io';
import type { SessionRecord, StripeEmulator } from '../stripe/emulator';
import { EmulatorConflictError } from '../stripe/emulator';
import { renderCheckoutPage, renderStatusPage } from './checkout-page';

export const PAY_PATH = /^\/pay\/([A-Za-z0-9_]{1,255})$/;

function origin(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url.split('{CHECKOUT_SESSION_ID}').join('x')).origin;
  } catch {
    return null;
  }
}

/**
 * Strict page headers. `form-action` must list the redirect targets too: Chrome applies it to
 * the 303 that follows the form POST.
 */
function pageHeaders(session: SessionRecord | undefined): OutgoingHttpHeaders {
  const targets = new Set<string>(["'self'"]);
  for (const value of [origin(session?.successUrl ?? null), origin(session?.cancelUrl ?? null)]) {
    if (value !== null) targets.add(value);
  }
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; " +
      `form-action ${[...targets].join(' ')}`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

function seeOther(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'content-length': 0 });
  res.end();
}

function statusPage(res: ServerResponse, session: SessionRecord | undefined, id: string): void {
  if (session === undefined) {
    send(
      res,
      404,
      renderStatusPage('Checkout not found', `No checkout session ${id}.`),
      pageHeaders(undefined),
    );
    return;
  }
  if (session.status === 'complete') {
    send(
      res,
      409,
      renderStatusPage('Payment complete', 'This checkout session has already been paid.'),
      pageHeaders(session),
    );
    return;
  }
  send(
    res,
    410,
    renderStatusPage(
      'Checkout expired',
      'This checkout session has expired. Start a new checkout.',
    ),
    pageHeaders(session),
  );
}

/** `GET /pay/:id` (the page) and `POST /pay/:id` (`action` = pay | decline | cancel). */
export async function handlePay(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  stripe: StripeEmulator,
): Promise<void> {
  const session = stripe.findSession(id);
  const action = `/pay/${encodeURIComponent(id)}`;
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (session?.status !== 'open') {
      statusPage(res, session, id);
      return;
    }
    send(res, 200, renderCheckoutPage(session, { action }), pageHeaders(session));
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, renderStatusPage('Method not allowed', 'Use the buttons on the page.'), {
      ...pageHeaders(session),
      allow: 'GET, HEAD, POST',
    });
    return;
  }
  const body = await readBody(req, 16 * 1024);
  const form =
    mediaType(req) === 'application/x-www-form-urlencoded' ? parseForm(body.toString('utf8')) : {};
  const choice = form.action;
  if (session?.status !== 'open') {
    statusPage(res, session, id);
    return;
  }
  try {
    switch (choice) {
      case 'pay': {
        const completed = stripe.completeSession(id);
        seeOther(res, stripe.successRedirect(completed));
        return;
      }
      case 'decline': {
        const declined = stripe.declineSession(id);
        send(res, 402, renderCheckoutPage(declined, { action }), pageHeaders(declined));
        return;
      }
      case 'cancel':
        if (session.cancelUrl === null) break;
        seeOther(res, session.cancelUrl);
        return;
      default:
        break;
    }
  } catch (error) {
    if (error instanceof EmulatorConflictError) {
      statusPage(res, stripe.findSession(id), id);
      return;
    }
    throw error;
  }
  send(
    res,
    400,
    renderStatusPage('Invalid action', 'Choose Pay, Decline or Cancel.'),
    pageHeaders(session),
  );
}
