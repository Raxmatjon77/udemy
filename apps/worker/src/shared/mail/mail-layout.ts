/**
 * Shared layout for worker emails: plain text plus a small HTML alternative. Every interpolated
 * value is escaped for HTML (text and attribute context), and only http(s) links are rendered.
 * The per-context templates (identity, users) build a `MailLayout` and call `renderMail`.
 */

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface MailLayout {
  readonly subject: string;
  readonly greetingName: string;
  readonly paragraphs: readonly string[];
  readonly action?: { readonly label: string; readonly url: string };
  readonly footnote?: string;
  /**
   * Notification e-mails of an unlockable category (design §14): a visible one-click
   * unsubscribe link (`{STUDENT_APP_ORIGIN}/unsubscribe#token=…`) and the preferences page.
   */
  readonly unsubscribe?: {
    readonly url: string;
    readonly preferencesUrl: string;
    /** e.g. "course announcements" (NOTIFICATION_CATEGORY_META label, lowercased). */
    readonly categoryLabel: string;
  };
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Only http(s) links are ever rendered (origins are validated at startup; this is a backstop). */
export function safeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('Email links must be http(s) URLs');
  }
  return parsed.toString();
}

/** Display names are user input: no line breaks in the text part either. */
export function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

/** `2026-10-10 10:00 UTC`. */
export function utc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function renderMail(layout: MailLayout): RenderedMail {
  const name = oneLine(layout.greetingName);
  const action =
    layout.action === undefined ? undefined : { ...layout.action, url: safeUrl(layout.action.url) };
  const unsubscribe =
    layout.unsubscribe === undefined
      ? undefined
      : {
          url: safeUrl(layout.unsubscribe.url),
          preferencesUrl: safeUrl(layout.unsubscribe.preferencesUrl),
          categoryLabel: oneLine(layout.unsubscribe.categoryLabel),
        };

  const text = [
    `Hi ${name},`,
    '',
    ...layout.paragraphs.flatMap((p) => [p, '']),
    ...(action === undefined ? [] : [`${action.label}: ${action.url}`, '']),
    ...(layout.footnote === undefined ? [] : [layout.footnote, '']),
    '— Udemy Clone',
    ...(unsubscribe === undefined
      ? []
      : [
          '',
          `Unsubscribe from ${unsubscribe.categoryLabel} emails: ${unsubscribe.url}`,
          `Notification settings: ${unsubscribe.preferencesUrl}`,
        ]),
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html><body style="font-family:sans-serif;line-height:1.5;color:#1c1d1f">',
    `<p>Hi ${escapeHtml(name)},</p>`,
    ...layout.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    ...(action === undefined
      ? []
      : [
          `<p><a href="${escapeHtml(action.url)}" style="background:#5624d0;color:#fff;padding:10px 16px;text-decoration:none;border-radius:4px">${escapeHtml(action.label)}</a></p>`,
          `<p style="font-size:12px;color:#6a6f73">Or paste this link into your browser:<br>${escapeHtml(action.url)}</p>`,
        ]),
    ...(layout.footnote === undefined
      ? []
      : [`<p style="font-size:12px;color:#6a6f73">${escapeHtml(layout.footnote)}</p>`]),
    '<p>— Udemy Clone</p>',
    ...(unsubscribe === undefined
      ? []
      : [
          `<p style="font-size:12px;color:#6a6f73"><a href="${escapeHtml(unsubscribe.url)}">Unsubscribe</a> from ${escapeHtml(unsubscribe.categoryLabel)} emails · <a href="${escapeHtml(unsubscribe.preferencesUrl)}">Notification settings</a></p>`,
        ]),
    '</body></html>',
  ].join('\n');

  return { subject: layout.subject, text, html };
}

/** The bare address of a `MAIL_FROM` value (`Name <a@b>` or `a@b`, validated at startup). */
export function mailboxAddress(mailFrom: string): string {
  const match = /<([^<>]+)>\s*$/.exec(mailFrom);
  return (match?.[1] ?? mailFrom).trim();
}
