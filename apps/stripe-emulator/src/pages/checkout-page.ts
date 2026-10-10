import type { SessionRecord } from '../stripe/emulator';

/**
 * The hosted checkout page (`GET /pay/:sessionId`): one self-contained HTML document, inline CSS,
 * no scripts, no external assets. One form, three submit buttons (`name="action"`), so it works
 * with any browser and with Playwright's `getByRole('button', { name: 'Pay' })`.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `1999, 'usd'` → `$19.99` (zero-decimal currencies such as JPY are handled by Intl). */
export function formatMoney(amountMinor: number, currency: string): string {
  const format = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(amountMinor / 10 ** digits);
}

const STYLE = `
  :root { color-scheme: light; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { margin: 0; background: #f6f9fc; color: #1a1f36; }
  .banner { background: #ffde92; color: #3d2a00; padding: .5rem 1rem; text-align: center; font-size: .875rem; }
  main { max-width: 32rem; margin: 2rem auto; background: #fff; border-radius: .5rem;
         box-shadow: 0 2px 8px rgba(0,0,0,.08); padding: 1.5rem 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
  caption { text-align: left; font-weight: 600; padding-bottom: .5rem; }
  th, td { padding: .5rem 0; border-bottom: 1px solid #e3e8ee; text-align: left; }
  td.amount, th.amount { text-align: right; }
  tfoot th, tfoot td { font-weight: 700; border-bottom: none; }
  .alert { background: #fde8e8; color: #8a1c1c; border: 1px solid #f5b5b5; border-radius: .25rem;
           padding: .75rem; margin-bottom: 1rem; }
  .info { background: #e8f1fd; color: #1c3d8a; border-radius: .25rem; padding: .75rem; }
  .actions { display: flex; gap: .5rem; flex-wrap: wrap; }
  button { font: inherit; padding: .625rem 1.25rem; border-radius: .375rem; border: 1px solid #cfd7df;
           background: #fff; color: #1a1f36; cursor: pointer; }
  button.primary { background: #635bff; border-color: #635bff; color: #fff; font-weight: 600; }
  button:focus-visible { outline: 3px solid #1a1f36; outline-offset: 2px; }
  .muted { color: #5b6573; font-size: .875rem; }
`;

function document(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<p class="banner" role="note">Test mode: Stripe emulator. No real payment is made.</p>
<main>
${body}
</main>
</body>
</html>
`;
}

export interface CheckoutPageOptions {
  /** The form's POST target (`/pay/{id}`). */
  readonly action: string;
}

export function renderCheckoutPage(session: SessionRecord, options: CheckoutPageOptions): string {
  const rows = session.lineItems
    .map(
      (line) => `<tr>
  <td>${escapeHtml(line.name)}${line.quantity > 1 ? ` &times; ${line.quantity}` : ''}</td>
  <td class="amount">${escapeHtml(formatMoney(line.amountTotal, session.currency))}</td>
</tr>`,
    )
    .join('\n');
  const total = formatMoney(session.amountTotal, session.currency);
  const alert =
    session.lastDeclineMessage === null
      ? ''
      : `<div class="alert" role="alert" id="payment-error">${escapeHtml(session.lastDeclineMessage)}</div>`;
  const email =
    session.customerEmail === null
      ? ''
      : `<p class="muted">Paying as <strong>${escapeHtml(session.customerEmail)}</strong></p>`;
  const cancel =
    session.cancelUrl === null
      ? ''
      : '<button type="submit" name="action" value="cancel">Cancel</button>';
  const expires = new Date(session.expiresAt * 1000).toISOString();
  return document(
    `Pay ${total}`,
    `<h1>Pay ${escapeHtml(total)}</h1>
${alert}
${email}
<table>
<caption>Order summary</caption>
<thead><tr><th scope="col">Item</th><th scope="col" class="amount">Amount</th></tr></thead>
<tbody>
${rows}
</tbody>
<tfoot><tr><th scope="row">Total</th><td class="amount" id="total">${escapeHtml(total)}</td></tr></tfoot>
</table>
<form method="post" action="${escapeHtml(options.action)}"${session.lastDeclineMessage === null ? '' : ' aria-describedby="payment-error"'}>
<div class="actions">
<button type="submit" name="action" value="pay" class="primary">Pay</button>
<button type="submit" name="action" value="decline">Decline</button>
${cancel}
</div>
</form>
<p class="muted">Session <code>${escapeHtml(session.id)}</code> expires at <time datetime="${expires}">${expires}</time>.</p>`,
  );
}

/** Shown for a session that is no longer open (paid, expired) and for unknown ids. */
export function renderStatusPage(title: string, message: string): string {
  return document(
    title,
    `<h1>${escapeHtml(title)}</h1>\n<p class="info" role="status">${escapeHtml(message)}</p>`,
  );
}
